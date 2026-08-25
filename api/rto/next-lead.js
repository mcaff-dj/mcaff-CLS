// Fills the calling agent back up toward their own quota right now, instead of them waiting on
// scripts/assign_leads.py's next scheduled pass (up to 5 minutes away, and - see
// docs/2026-08-18-rto-crm-performance-audit.md and this week's incidents - not reliably
// completing even then on a CPU-throttled Lambda).
//
// Called from RtoCrmClient.js's submitDisp() right after a disposal succeeds. Before this
// existed, disposing a lead did not trigger any assignment at all - the sweep was the ONLY
// path, and the UI's own toast ("& refilled fresh lead into box!") was simply false; nothing
// behind it ever ran. Observed repeatedly this week as agents sitting at zero leads for
// 15-60+ minutes against a backlog in the thousands (Badshah, Sayli, Naziya, Atharva, Shubham
// all hit this on 2026-08-19/20) purely because the sweep hadn't reached them yet.
//
// FILLS to quota, not just one-for-one - this is the fix for a second, quieter failure mode
// found right after the one-lead version shipped: Rasika sat at 1/20 all session while every
// other agent climbed to 18-21 through ordinary one-at-a-time top-ups, because giving back
// exactly what was just disposed can only ever MAINTAIN a load, never GROW it. An agent who
// starts a session (or comes back from a long idle stretch) under quota had no way to close
// that gap except the periodic sweep - the exact piece already unreliable all week. See the
// FILL_TIME_BUDGET_MS/MAX_FILL_PER_REQUEST bounds further down for why this is capped rather
// than unconditionally filling the whole gap in one request.
//
// Deliberately scoped to fresh leads for the CALLER only, not a re-run of the sweep:
//   - The sweep is a full pass over the whole sheet plus GoKwik/LMD checks (12-40s+ observed
//     this week) behind reserved concurrency 1 on the Lambda - firing it from every disposal
//     across a team would queue duplicate full runs behind each other, and Lambda's async
//     invoke retries a throttled call for up to 6 hours (see lambda/README.md), so a busy
//     afternoon could build a backlog that outlives the shift.
//   - This request touches only the caller's own quota and rows. Batched, not per-lead - see
//     planFillRound and the loop around it - so a whole fill costs a small constant number of
//     Sheets calls regardless of how many leads it hands out, not one round-trip per lead. That
//     batching is not an optimisation, it is load-bearing: every Sheets call in this app,
//     across every agent, authenticates as the SAME service account, so Google's per-user rate
//     limit is shared team-wide. The first version of this fill did one GET+PUT pair PER lead
//     (up to 50 calls for one disposal), and on 2026-08-20 that was enough - with a few agents
//     disposing in the same minute, an ordinary busy stretch - to exhaust the shared quota and
//     start returning 429 to EVERYONE, including the plain 60s sync that has nothing to do with
//     filling at all. No GoKwik/LMD network round-trip on the common path either - see the SCOPE
//     note below - so a fill still comfortably finishes inside a normal HTTP request.
//
// SCOPE CUT, stated plainly: this endpoint only ever hands out a FRESH lead (Column Q blank or
// "Unassigned") - it does NOT participate in the Connected=No reassignment queue or the
// prepaid-target ratio steering, both of which stay exclusive to scripts/assign_leads.py's
// periodic sweep (which keeps running as the safety net - see that file, unchanged). Agent
// specializations (priority_rto_reasons) WERE in that list and no longer are: leaving them out
// meant the two assignment paths actively disagreed - the sweep routed a reason to its
// specialist while a top-up handed the same reason to whoever disposed first, so the faster
// path quietly undid the roster's configuration. See rankBySpecialization below for how a
// per-lead agent ordering becomes a per-agent lead ordering. And a PREPAID fresh lead is handed out WITHOUT a live GoKwik refund check:
// that check needs Item_level_data in the mcaff_prod MySQL schema, which only the Python cron's
// credentials can reach today - the Node API Lambda has no connection to that database at all,
// and standing one up just for this endpoint was judged not worth the new credential surface
// for a v1. This is safe, not just convenient: assign_leads.py ALREADY re-checks refund status
// for a prepaid lead that is assigned-but-not-yet-disposed (see its own module docstring,
// HYP42591650) - the sweep will still catch and stamp "Already Refunded" on anything this
// endpoint hands out, at worst one cron cycle later, exactly the same latency window that
// already existed for that check before this endpoint was added.
const { getSession } = require('../_lib/session');
const { JWT } = require('google-auth-library');
const { claimRtoLead, getRtoAgentQuota, getRtoAgentAvailability, getAgentPresenceRow,
  getRtoOnlineSpecializations } = require('../_lib/db');
const { resolveAgentQuota } = require('../_lib/leadQuota');
const leadAssignmentRules = require('../_lib/leadAssignmentRules.json');

const RTO_SHEET_ID = '1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI';
const SHEET_TAB = 'Data';
const CARD_KEY = 'calling';
const TAB_KEY = 'rto';

// Must match scripts/assign_leads.py's STALE_MINUTES - the same "heartbeat-fresh" window that
// decides whether an agent's global presence counts as genuinely Online right now.
const STALE_MINUTES = 10;

// Hard ceiling on how many leads one request will fill, independent of quota - purely
// defensive against a misconfigured quota value turning one request into dozens of sequential
// Sheets calls. See computeFillTarget and the handler's own FILL_TIME_BUDGET_MS for the two
// bounds together.
const MAX_FILL_PER_REQUEST = 25;

// How many leads this call should try to assign: the smaller of the agent's real remaining
// quota headroom, the hard per-request ceiling, and how many candidates actually exist. A pure
// function purely so the arithmetic - easy to get off-by-one on (quota-load vs quota-load-1,
// clamping negative) - is tested rather than trusted. Clamped at 0: the caller already checks
// load >= quota before reaching this, but this must never return a negative "target" if that
// guard is ever reordered or removed.
function computeFillTarget(quota, load, candidatesAvailable, maxPerRequest) {
  const headroom = Math.max(0, quota - load);
  return Math.min(headroom, maxPerRequest, candidatesAvailable);
}

// The exact eligibility rule scripts/assign_leads.py's fetch_online_agents enforces for the
// sweep - BOTH a heartbeat-fresh global "Online" AND a per-process (rto) "Online" - reduced to
// one pure function so it can be tested without a database. This was the check missing from the
// first version of this endpoint: it assigned purely on quota, so an agent who went Busy/OnCall
// mid-shift kept getting topped up on every disposal regardless (observed on Sayli, 2026-08-20 -
// assignments continued for 14+ minutes and multiple leads after she went OnCall).
//
// presence: {status, updatedAt} | null (null = never reported in, or the lookup failed).
// perProcessStatus: string | null (null = the lookup itself failed - see getRtoAgentAvailability
// in db.js for why a missing ROW is a different, already-handled case: it resolves to the string
// 'Offline' before this function ever sees it, not null).
function isEligibleNow(presence, perProcessStatus, nowMs) {
  if (!presence || presence.status !== 'Online') return false;
  const updatedAtMs = new Date(presence.updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) return false;
  if (nowMs - updatedAtMs >= STALE_MINUTES * 60 * 1000) return false;
  return perProcessStatus === 'Online';
}

// Same reason claim.js gives for its own client: reaching into a sibling route's module-scoped
// client would couple the two for the sake of a few lines of setup.
let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return _client;
}

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to RTO-CRM.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to RTO-CRM.';
  return null;
}

async function sheetsRequest(client, method, path, body) {
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}${path}`,
    method,
    data: body,
  });
  return res.data;
}

// Column layout - same constants as scripts/lead_priority.py (COL_* there), kept as letters
// here since this reads via A1-notation ranges rather than a parsed 2D array.
const COL = {
  RTO_INITIATED_DATE: 'B',
  RTO_REASON: 'D',
  ORDER_ID: 'E',
  AWB_CODE: 'G',
  PAYMENT_METHOD: 'O',
  AGENT: 'Q',
};
// Offsets WITHIN the Q:Z batchGet range below - Q is offset 0.
const WORK_OFFSET = { AGENT: 0, CONNECTED: 1, ATTEMPT: 2, DISPOSITION: 3, REMARKS_LEGACY_U: 4, REMARKS: 9 };

const HIGH_PRIORITY_REASONS = (leadAssignmentRules.highPriorityCodRtoReasons || []).map((r) => r.toLowerCase());
const LOW_PRIORITY_REASONS = (leadAssignmentRules.lowPriorityCodRtoReasons || []).map((r) => r.toLowerCase());

// Mirrors scripts/lead_priority.py's is_prepaid exactly: explicit COD/Cash is COD, everything
// else (payment text varies a lot across sources) defaults to Prepaid.
function isPrepaid(paymentRaw) {
  const p = (paymentRaw || '').toUpperCase();
  return !(p.includes('COD') || p.includes('CASH'));
}

// Mirrors scripts/lead_priority.py's priority_tier exactly: 0 Prepaid, 1 COD/high-priority
// reason, 2 every other COD, 3 COD/low-priority reason. Lower sorts first.
function priorityTier(paymentRaw, rtoReasonRaw) {
  if (isPrepaid(paymentRaw)) return 0;
  const reason = (rtoReasonRaw || '').toLowerCase();
  if (LOW_PRIORITY_REASONS.some((r) => reason.includes(r))) return 3;
  if (HIGH_PRIORITY_REASONS.some((r) => reason.includes(r))) return 1;
  return 2;
}

// Mirrors scripts/lead_priority.py's parse_rto_initiated_date: "DD-MM-YYYY HH:MM" or bare
// "DD-MM-YYYY". Returns null (sorts last, i.e. oldest) rather than throwing on anything else -
// a bad date must never jump the queue.
function parseRtoInitiatedDate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?$/.exec((s || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +(hh || 0), +(min || 0)));
  // Date.UTC silently rolls an out-of-range day/month into a neighbouring month rather than
  // failing - reject that instead of letting a typo'd date jump the queue under a wrong tier.
  if (d.getUTCFullYear() !== +yyyy || d.getUTCMonth() !== +mm - 1 || d.getUTCDate() !== +dd) return null;
  return d;
}

// Fresh/never-touched candidates, sorted highest-priority first: tier ascending, then RTO
// Initiated Date descending (newest first) within a tier, undated rows last within their tier -
// the exact ordering scripts/lead_priority.py's build_assignment_queue applies to the
// fresh-lead pool. Deliberately excludes anything already touched (Column Q non-blank, or any
// of Connected/Attempt/Disposition/legacy-U/Remarks set) - the Connected=No reassignment queue
// is out of scope here, see this file's own module comment.
function buildCandidateList(orderRows, workRows) {
  const seen = new Set();
  const candidates = [];
  for (let i = 0; i < orderRows.length; i++) {
    const orderId = ((orderRows[i] && orderRows[i][0]) || '').toString().trim();
    const key = orderId.toUpperCase();
    if (!key || seen.has(key)) continue; // first row wins, matching the CRM's own dedup
    seen.add(key);
    const w = workRows[i] || {};
    const agent = (w.agent || '').trim().toLowerCase();
    if (agent && agent !== 'unassigned') continue;
    const worked = w.connected || w.attempt || w.disposition || w.remarksLegacyU || w.remarks;
    if (worked) continue;
    candidates.push({
      row: i + 2, // +2: header row + 0-based index
      orderId,
      awbCode: w.awbCode || '',
      rtoReason: w.rtoReason || '',
      tier: priorityTier(w.paymentMethod, w.rtoReason),
      date: parseRtoInitiatedDate(w.rtoInitiatedDate),
    });
  }
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.date && b.date) return b.date - a.date; // newest first
    if (a.date) return -1; // dated beats undated within a tier
    if (b.date) return 1;
    return 0;
  });
  return candidates;
}

// Applies scripts/lead_priority.py's Pass 1 (specialist first refusal) to a single-agent pull.
// The sweep expresses that rule by reordering AGENTS per lead; with only the caller in play here
// it becomes a reordering of LEADS, in both directions:
//
//   rank 0  matches the caller's own priority reasons - the sweep would have handed these to
//           them ahead of the general pool, so they come first.
//   rank 1  no online specialist claims this reason - free for anyone.
//   rank 2  another ONLINE specialist's reason. Last, not excluded: the sweep's Pass 2/3 hand a
//           reserved lead to a generalist anyway once specialists are at quota or unavailable,
//           and leaving an eligible agent idle in front of a backlog is the worse failure. This
//           only stops the instant top-up from OUTRUNNING the sweep on someone else's speciality.
//
// Rank is the outermost key; tier and date still order within a rank because the input is
// already sorted that way and Array.prototype.sort is stable (Node >= 11). A caller with no
// specialization of their own simply has no rank-0 leads - the rank-1-before-rank-2 half still
// applies, which is the half that stops the stealing.
//
// specialists is the whole online set INCLUDING the caller; matching by email keeps "mine"
// authoritative when a reason is on both lists. null/[] (lookup failed or nobody specializes)
// leaves the order exactly as the tier sort produced it.
function rankBySpecialization(candidates, callerEmail, specialists) {
  if (!specialists || specialists.length === 0) return candidates;
  const me = callerEmail.trim().toLowerCase();
  const mine = specialists.filter((s) => s.email === me).flatMap((s) => s.reasons);
  const others = specialists.filter((s) => s.email !== me).flatMap((s) => s.reasons);
  if (mine.length === 0 && others.length === 0) return candidates;
  const rank = (c) => {
    const reason = (c.rtoReason || '').toLowerCase();
    if (mine.some((r) => reason.includes(r))) return 0;
    if (others.some((r) => reason.includes(r))) return 2;
    return 1;
  };
  return candidates
    .map((c, i) => ({ c, i, r: rank(c) }))
    // Explicit index tiebreak rather than relying on sort stability alone - the ordering this
    // preserves (tier, then date) is the whole point, and it is cheap to make that guarantee
    // local instead of a footnote about the engine.
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.i - b.i))
    .map((x) => x.c);
}

// Splits one round's target candidates into { free, taken } from a Google values:batchGet
// response verifying their Column Q cells - pure so the response-shape parsing (an easy place
// to get array indexing or the "Unassigned" convention subtly wrong) is tested directly rather
// than trusted. valueRanges is the raw `data.valueRanges` array from the batchGet call, in the
// SAME order as `target` (both built from the same cellRanges list).
function planFillRound(target, valueRanges) {
  const free = [];
  const taken = [];
  target.forEach((candidate, i) => {
    const vr = valueRanges[i];
    const held = (((vr && vr.values && vr.values[0]) || [])[0] || '').toString().trim();
    if (held && held.toLowerCase() !== 'unassigned') taken.push(candidate);
    else free.push(candidate);
  });
  return { free, taken };
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }
  const email = session.email;

  // Eligibility gate, checked before doing any Sheets work: an agent who has gone Busy/OnCall/
  // Offline must not be auto-topped-up just because they happen to dispose something (e.g.
  // finishing up a call after switching status, or clearing a stale row) - see isEligibleNow's
  // own comment. Both lookups fail safe to "not eligible" on an error, never to "assume Online" -
  // the disposal that triggered this call has already fully succeeded regardless, so silently
  // skipping a top-up here is always the safe direction; assuming eligibility would not be.
  let presence = null;
  let perProcessStatus = null;
  try {
    [presence, perProcessStatus] = await Promise.all([
      getAgentPresenceRow(email),
      getRtoAgentAvailability(email),
    ]);
  } catch (e) {
    console.error('api/rto/next-lead: eligibility lookup failed:', e.message);
  }
  if (!isEligibleNow(presence, perProcessStatus, Date.now())) {
    res.status(200).json({ assigned: false, reason: 'not online' });
    return;
  }

  try {
    const client = getClient();

    // One combined read: order ids for dedup, B/D/G/O for tier + candidate metadata, Q:Z for
    // both this agent's current load AND every row's worked-or-not state. Everything this
    // request needs, in one round trip.
    const ranges = [
      `${SHEET_TAB}!${COL.ORDER_ID}2:${COL.ORDER_ID}`,
      `${SHEET_TAB}!${COL.RTO_INITIATED_DATE}2:${COL.RTO_INITIATED_DATE}`,
      `${SHEET_TAB}!${COL.RTO_REASON}2:${COL.RTO_REASON}`,
      `${SHEET_TAB}!${COL.AWB_CODE}2:${COL.AWB_CODE}`,
      `${SHEET_TAB}!${COL.PAYMENT_METHOD}2:${COL.PAYMENT_METHOD}`,
      `${SHEET_TAB}!Q2:Z`,
    ];
    const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
    const data = await sheetsRequest(client, 'GET', `/values:batchGet?${qs}`);
    const [orderVR, dateVR, reasonVR, awbVR, paymentVR, workVR] = data.valueRanges || [];
    const orderRows = orderVR?.values || [];
    const dateRows = dateVR?.values || [];
    const reasonRows = reasonVR?.values || [];
    const awbRows = awbVR?.values || [];
    const paymentRows = paymentVR?.values || [];
    const workRowsRaw = workVR?.values || [];

    const workRows = orderRows.map((_r, i) => {
      const w = workRowsRaw[i] || [];
      return {
        agent: w[WORK_OFFSET.AGENT] || '',
        connected: w[WORK_OFFSET.CONNECTED] || '',
        attempt: w[WORK_OFFSET.ATTEMPT] || '',
        disposition: w[WORK_OFFSET.DISPOSITION] || '',
        remarksLegacyU: w[WORK_OFFSET.REMARKS_LEGACY_U] || '',
        remarks: w[WORK_OFFSET.REMARKS] || '',
        rtoInitiatedDate: (dateRows[i] && dateRows[i][0]) || '',
        rtoReason: (reasonRows[i] && reasonRows[i][0]) || '',
        awbCode: (awbRows[i] && awbRows[i][0]) || '',
        paymentMethod: (paymentRows[i] && paymentRows[i][0]) || '',
      };
    });

    // Quota gate first - cheap, and no point picking a candidate for an agent who can't take
    // one. Load counted the same way api/rto/claim.js does and for the same reason (see that
    // file's own note): CLS_RTO_calling cannot answer this yet.
    const seenForLoad = new Set();
    let load = 0;
    for (let i = 0; i < orderRows.length; i++) {
      const key = ((orderRows[i] && orderRows[i][0]) || '').toString().trim().toUpperCase();
      if (!key || seenForLoad.has(key)) continue;
      seenForLoad.add(key);
      const w = workRows[i];
      if ((w.agent || '').trim().toLowerCase() !== email.trim().toLowerCase()) continue;
      const worked = w.connected || w.attempt || w.disposition || w.remarksLegacyU || w.remarks;
      if (!worked) load++;
    }
    // getRtoAgentQuota already fails open to null ("unset") on its own, so no extra guard
    // needed here - see its own comment in db.js.
    const quota = resolveAgentQuota(
      [{ email, maxQuota: await getRtoAgentQuota(email) }], email, leadAssignmentRules.assignmentQuota,
    );
    if (load >= quota) {
      res.status(200).json({ assigned: false, reason: 'at quota', load, quota });
      return;
    }

    const candidatesByTier = buildCandidateList(orderRows, workRows);
    if (candidatesByTier.length === 0) {
      res.status(200).json({ assigned: false, reason: 'no leads available', load, quota });
      return;
    }

    // Specialist first refusal - see rankBySpecialization. Read here rather than alongside the
    // eligibility lookups above so an at-quota or nothing-available call, both of which return
    // before this point, don't pay for a query whose answer they'd throw away.
    const specialists = await getRtoOnlineSpecializations(
      new Date(Date.now() - STALE_MINUTES * 60 * 1000),
    );
    const candidates = rankBySpecialization(candidatesByTier, email, specialists);

    // FILLS to quota, not just "replace the one just disposed" - this is the fix for the gap
    // that let this happen at all: Rasika sat at 1/20 all session while every other agent
    // climbed to 18-21 via ordinary one-at-a-time top-ups, because one-for-one can only ever
    // MAINTAIN a load, never GROW it. An agent who starts a session (or a long idle stretch)
    // under quota has no way to close that gap except the periodic sweep - which is exactly the
    // piece that has been unreliable all week. Filling here means the very first disposal after
    // going under-full catches an agent all the way back up, with no dependency on the sweep
    // completing at all.
    //
    // Bounded two ways, because this now runs inside an interactive disposal request the agent
    // is waiting on, not a background job:
    //   - FILL_TIME_BUDGET_MS caps wall-clock, the same pattern (and the same reasoning) as
    //     scripts/assign_leads.py's GOKWIK_TIME_BUDGET_SEC: better to hand back a partial fill
    //     within a bounded time than let one huge gap turn into a multi-second UI hang.
    //   - MAX_FILL_PER_REQUEST (see computeFillTarget above) is the other bound.
    // A gap wider than either limit closes over the agent's next few disposals instead of this
    // one - slower than instant, but still self-healing without the sweep, which is the property
    // that was missing before.
    const FILL_TIME_BUDGET_MS = 8000;
    const needed = computeFillTarget(quota, load, candidates.length, MAX_FILL_PER_REQUEST);

    // BATCHED, not one GET+PUT pair per candidate lead - this is the fix for a real production
    // incident (2026-08-20): every Sheets call in this app, across every agent, authenticates
    // as the SAME single service account, so Google's per-user rate limit is shared team-wide.
    // The original per-candidate loop cost up to MAX_FILL_PER_REQUEST*2 (=50) individual Sheets
    // calls for ONE agent's ONE disposal; with several agents disposing in the same minute (an
    // ordinary busy stretch - see the multi-agent per-minute bursts already on record from this
    // same day), that was enough to exhaust the shared quota and start returning 429 to
    // EVERYONE, including the plain 60s sync that has nothing to do with filling at all.
    //
    // planFillRound below does the same verify-then-write logic as before, just aimed at a
    // WHOLE round's worth of candidates through one verify call and one write call, rather than
    // per-candidate. Total Sheets calls for a fill is now ~2 per round (regardless of how many
    // leads are in that round) x MAX_ROUNDS, a small constant instead of O(fill size).
    const assignedOrders = [];
    const startedAt = Date.now();
    let target = candidates.slice(0, needed);
    let spare = candidates.slice(needed); // backfill pool if a round loses a race
    const MAX_ROUNDS = 3; // initial pass + up to 2 backfills for lost races
    for (let round = 0; round < MAX_ROUNDS && target.length > 0 && Date.now() - startedAt < FILL_TIME_BUDGET_MS; round++) {
      // ONE batchGet verifying every target cell at once, not one GET per cell - a race with
      // another agent's claim/next-lead call landing on the same row between our initial read
      // and now is the only way one of these is already taken (same reasoning as the old
      // per-candidate check, just batched).
      const cellRanges = target.map((c) => `${SHEET_TAB}!${COL.AGENT}${c.row}`);
      const vqs = cellRanges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
      const verify = await sheetsRequest(client, 'GET', `/values:batchGet?${vqs}`);
      const verifyVR = verify.valueRanges || [];
      const { free, taken } = planFillRound(target, verifyVR);

      if (free.length > 0) {
        // ONE batchUpdate writing every confirmed-free cell at once, not one PUT per cell.
        await sheetsRequest(client, 'POST', '/values:batchUpdate', {
          valueInputOption: 'USER_ENTERED',
          data: free.map((c) => ({ range: `${SHEET_TAB}!${COL.AGENT}${c.row}`, values: [[email]] })),
        });
        assignedOrders.push(...free.map((c) => c.orderId));
        // CLS_RTO_calling inserts are Postgres/MySQL, not Sheets API - they don't count against
        // the quota this rewrite exists for, so they run off to the side, in parallel, rather
        // than serialized into the Sheets round-trip loop above.
        await Promise.all(free.map((c) => claimRtoLead(c.orderId, email, c.awbCode, c.rtoReason).catch((e) => {
          // The sheet write already succeeded - the agent holds the lead. Losing the history
          // row is a reporting gap, not a failed assignment, so this must not stop the fill.
          console.error(`api/rto/next-lead: Column Q written for ${c.orderId} but CLS_RTO_calling insert failed:`, e.message);
        })));
      }

      if (taken.length === 0) break; // nothing lost this round - done
      target = spare.slice(0, taken.length);
      spare = spare.slice(taken.length);
    }

    if (assignedOrders.length === 0) {
      // Every attempt lost its race, or the time budget expired before the first write landed -
      // genuinely unusual, but fail open rather than error: the agent's disposal already
      // succeeded, so report "nothing available this instant" rather than a false failure.
      res.status(200).json({ assigned: false, reason: 'no leads available', load, quota });
      return;
    }
    res.status(200).json({
      assigned: true,
      count: assignedOrders.length,
      orderNumbers: assignedOrders,
      orderNumber: assignedOrders[0], // back-compat single value for any caller expecting v1's shape
      load: load + assignedOrders.length,
      quota,
    });
  } catch (e) {
    console.error('api/rto/next-lead error:', e);
    res.status(500).json({ error: e.message || 'Could not assign a next lead' });
  }
}

module.exports = handler;
// Pure helpers exposed for next-lead.test.js - these are hand-mirrored from
// scripts/lead_priority.py (Python cannot execute JS, see leadAssignmentRules.json's own
// _readme) and drift here would silently disagree with the real cron about tier/order, so they
// get a real test against the actual running code rather than a hand-copied duplicate of it.
// Does not change this file's primary export shape - api/_lambda/app.js's `mount()` still just
// calls the function directly.
module.exports.isEligibleNow = isEligibleNow;
module.exports.computeFillTarget = computeFillTarget;
module.exports.planFillRound = planFillRound;
module.exports.isPrepaid = isPrepaid;
module.exports.priorityTier = priorityTier;
module.exports.parseRtoInitiatedDate = parseRtoInitiatedDate;
module.exports.buildCandidateList = buildCandidateList;
module.exports.rankBySpecialization = rankBySpecialization;
