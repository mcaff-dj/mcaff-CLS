// Fills an NDR calling agent back up toward their own quota right now, instead of them waiting
// on scripts/assign_ndr_leads.py's next scheduled pass (up to 5 minutes away).
//
// The NDR twin of api/rto/next-lead.js, and built deliberately as a twin: that endpoint exists
// because RTO had this exact problem first, and every bound and gate below is one it learned the
// hard way. Read its header before changing anything here. Called from NdrCallingClient.js's
// saveNdrDisposition right after a disposal succeeds. Before this existed, the periodic sweep was
// NDR's only assignment path, which is why two agents in one week (Rasika, Manica - both Team
// Aditi, both carrying an Attempt Count filter) reported getting nothing: any single thing wrong
// anywhere in the sweep meant no leads at all, with a 5-minute floor on recovery even when it
// worked.
//
// FILLS to quota, not one-for-one. Handing back exactly what was just disposed can only ever
// MAINTAIN a load, never GROW it, so an agent who starts a session (or comes back from an idle
// stretch) under quota would have no way to close that gap except the sweep. RTO shipped the
// one-lead version first and hit precisely this - see its header, where the agent left stuck at
// 1/20 was also Rasika.
//
// Deliberately scoped to the CALLER only, not a re-run of the sweep. Firing the sweep's Lambda
// from every disposal is the tempting one-liner and it is wrong: it is a full pass over the whole
// sheet behind reserved concurrency 1, and Lambda's async invoke retries a throttled call for up
// to 6 hours, so a busy afternoon builds a queue of duplicate full runs that outlives the shift.
// This request touches only this agent's own quota and rows.
//
// BATCHED, not one Sheets round trip per lead. Every Sheets call in this app, across every agent,
// authenticates as the SAME service account, so Google's per-user rate limit is shared team-wide -
// RTO's first version did a GET+PUT pair per lead and on 2026-08-20 that was enough to return 429
// to EVERYONE, including reads unrelated to filling. A whole fill here costs ~2 Sheets calls per
// round, a small constant, regardless of how many leads it hands out.
//
// SCOPE CUT, stated plainly: this only ever hands out a FRESH lead (Agent Name blank). It does not
// participate in anything else the sweep does, and the sweep keeps running unchanged as the safety
// net for whatever this misses - notably leads for an agent who is not currently in the app at all
// (no disposal, so nothing here ever fires for them) and any lead uploaded mid-shift while every
// agent happens to be at quota.
//
// One rule this does NOT reimplement: the sweep's scarcest-supply-first CHOICE BETWEEN AGENTS.
// That question does not exist here - there is exactly one agent, the caller. What the sweep does
// per lead across many agents, this does for one agent across many leads, and both consult the
// same hard filters via api/_lib/ndrAssignment.js so they cannot disagree about who may receive
// what. The consequence is worth being explicit about: a top-up can hand a broadly-eligible agent
// a lead that a narrowly-filtered colleague was the better fit for. The sweep's fairness rule only
// governs the sweep. This is the same trade RTO made when it dropped specialization steering from
// its own fill, and it is why the sweep stays the authority on fairness.
const { getSession } = require('../_lib/session');
const { JWT } = require('google-auth-library');
const { claimNdrLead, getAgentPresenceRow, getNdrAgentAssignmentConfig } = require('../_lib/db');
const { resolveSheetFor, checkAccess } = require('./sheet');
const {
  DEFAULT_QUOTA, brandOf, parseLatestNdrDate, normalizeAgentFilters, filtersCoverLead,
  computeFillTarget, isEligibleNow,
} = require('../_lib/ndrAssignment');

// Hard ceiling on how many leads one request will fill, independent of quota - purely defensive
// against a misconfigured quota turning one disposal into dozens of sequential Sheets calls.
const MAX_FILL_PER_REQUEST = 25;
// Wall-clock cap. This runs inside an interactive request the agent is waiting on, so a partial
// fill returned promptly beats a multi-second UI hang. A gap wider than either bound closes over
// the agent's next few disposals instead of this one - slower than instant, still self-healing
// without the sweep, which is the property that was missing entirely before.
const FILL_TIME_BUDGET_MS = 8000;
const MAX_ROUNDS = 3; // initial pass + up to 2 backfills for rows lost to a race

// 0-based column indices in this sheet, matching scripts/assign_ndr_leads.py's COL_* exactly.
// This is someone else's long-running spreadsheet, not ours, so these are fixed positions rather
// than anything derived from a schema. Only COL_AGENT is ever written here.
const COL_ORDER_ID = 0;          // A - the only source for brand (no Brand column exists)
const COL_AWB = 4;               // E
const COL_PAYMENT_MODE = 11;     // L
const COL_ATTEMPTS = 14;         // O
const COL_LATEST_NDR_DATE = 15;  // P - the oldest-first sort key
const COL_LATEST_NDR_REASON = 16; // Q
const COL_AGENT = 18;            // S - the ONLY column this file writes
const COL_CONNECTED = 19;        // T - read-only here; tells an agent's still-open leads apart
                                  //     from ones they have already disposed
const COL_AGENT_LETTER = 'S';
const LAST_COL_LETTER = 'T';

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return _client;
}

async function sheetsRequest(client, sheetId, method, path, body) {
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`,
    method,
    data: body,
  });
  return res.data;
}

// One pass over the sheet producing both halves of the decision, because they read the same rows
// and splitting them would mean iterating twice over the same tens of thousands of rows:
//
//   load       - this agent's OPEN leads: their email in Agent Name with Connected still blank.
//                Quota is a cap on CONCURRENT work, not a lifetime total; counting disposed leads
//                here is what once capped an agent at zero forever the moment they finished a
//                batch (see the fix in assign_ndr_leads.py's own current_load).
//   candidates - assignable leads this agent's filters cover, oldest Latest NDR Date first.
//
// A row with no AWB is skipped: AWB is the key ndr_lead_assignments is written under, so there is
// nothing to hand out. Same rule as the sweep's own `if awb:` guard.
//
// Exported for tests - pure, takes rows rather than reaching for a sheet.
function buildCandidateList(rows, email, filters) {
  const mine = String(email || '').trim().toLowerCase();
  let load = 0;
  const candidates = [];
  rows.forEach((row, i) => {
    const cell = (idx) => (row && row[idx] != null ? String(row[idx]) : '');
    const agent = cell(COL_AGENT).trim().toLowerCase();
    if (agent) {
      if (agent === mine && !cell(COL_CONNECTED).trim()) load++;
      return; // assigned to someone: never taken back, the same contract the sweep holds
    }
    const awb = cell(COL_AWB).trim();
    if (!awb) return;
    const lead = {
      row: i + 2, // rows[] starts at sheet row 2 (A2:T...), so +2
      awb,
      attempts: cell(COL_ATTEMPTS),
      latestNdrReason: cell(COL_LATEST_NDR_REASON),
      paymentMode: cell(COL_PAYMENT_MODE),
      brand: brandOf(cell(COL_ORDER_ID)),
      sortKey: parseLatestNdrDate(cell(COL_LATEST_NDR_DATE)),
    };
    if (filtersCoverLead(filters, lead)) candidates.push(lead);
  });
  // Oldest first, undated last (parseLatestNdrDate returns Infinity) - a lead that has been
  // waiting longest outranks a fresher one, same ordering as the sweep. Row number breaks ties so
  // two callers reading the same sheet at the same instant walk it in the same order, which keeps
  // the race below rare rather than merely survivable.
  candidates.sort((a, b) => (a.sortKey - b.sortKey) || (a.row - b.row));
  return { load, candidates };
}

// Splits a round's targets by what the verify read just found in Agent Name: still blank (ours to
// take) versus already written by someone else between our first read and now. Same shape and
// reasoning as planFillRound in api/rto/next-lead.js, minus RTO's 'Unassigned' sentinel - this
// sheet only ever uses a blank cell for "nobody has this".
function planFillRound(target, valueRanges) {
  const free = [];
  const taken = [];
  target.forEach((candidate, i) => {
    const vr = valueRanges[i];
    const held = (((vr && vr.values && vr.values[0]) || [])[0] || '').toString().trim();
    if (held) taken.push(candidate);
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

  // Eligibility gate BEFORE any Sheets work. An agent who has gone Busy/OnCall/Offline must not
  // be topped up just because they happened to dispose something - finishing a call after
  // switching status, or clearing a stale row, are both ordinary. Both lookups fail safe to "not
  // eligible", never to "assume Online": the disposal that triggered this call has already fully
  // succeeded, so skipping a top-up is always the safe direction.
  let presence = null;
  let config = null;
  try {
    [presence, config] = await Promise.all([
      getAgentPresenceRow(email),
      getNdrAgentAssignmentConfig(email),
    ]);
  } catch (e) {
    console.error('api/ndr/next-lead: eligibility lookup failed:', e.message);
  }
  if (!isEligibleNow(presence, config && config.status, Date.now())) {
    res.status(200).json({ assigned: false, reason: 'not online' });
    return;
  }

  // The caller's own team sheet, resolved by the SAME function api/ndr/sheet.js reads through -
  // never re-derived here. A resolver that drifts by one branch writes real assignments into
  // another team's live spreadsheet.
  const resolved = await resolveSheetFor(session, req);
  if (resolved.error) {
    res.status(403).json({ error: resolved.error });
    return;
  }
  const { team } = resolved;

  try {
    const client = getClient();
    const filters = normalizeAgentFilters({
      email,
      maxQuota: config.max_quota != null ? config.max_quota : DEFAULT_QUOTA,
      attemptCountFilter: config.attempt_count_filter,
      ndrReasonFilter: config.ndr_reason_filter,
      ndrPaymentModeFilter: config.ndr_payment_mode_filter,
      ndrBrandFilter: config.ndr_brand_filter,
    });
    const quota = filters.quota;

    // One read, A2:T, covering every column both halves of buildCandidateList need.
    const range = `'${team.sheetTab}'!A2:${LAST_COL_LETTER}`;
    const data = await sheetsRequest(client, team.sheetId, 'GET',
      `/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
    const { load, candidates } = buildCandidateList(data.values || [], email, filters);

    if (load >= quota) {
      res.status(200).json({ assigned: false, reason: 'at quota', load, quota });
      return;
    }
    if (candidates.length === 0) {
      // Either nothing is waiting, or nothing waiting passes this agent's filters. The roster's
      // own coverage badge is what distinguishes those two for a human - see ndrFilterMatchCounts
      // in NdrCallingClient.js.
      res.status(200).json({ assigned: false, reason: 'no leads available', load, quota });
      return;
    }

    const needed = computeFillTarget(quota, load, candidates.length, MAX_FILL_PER_REQUEST);
    const assignedAwbs = [];
    const startedAt = Date.now();
    let target = candidates.slice(0, needed);
    let spare = candidates.slice(needed); // backfill pool if a round loses a race
    for (let round = 0; round < MAX_ROUNDS && target.length > 0 && Date.now() - startedAt < FILL_TIME_BUDGET_MS; round++) {
      // ONE batchGet re-checking every target cell, not one GET per cell. A race with the sweep or
      // another agent's claim landing on the same row between our read above and now is the only
      // way one of these is already taken.
      const cellRanges = target.map((c) => `'${team.sheetTab}'!${COL_AGENT_LETTER}${c.row}`);
      const qs = cellRanges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
      const verify = await sheetsRequest(client, team.sheetId, 'GET', `/values:batchGet?${qs}`);
      const { free, taken } = planFillRound(target, verify.valueRanges || []);

      if (free.length > 0) {
        // ONE batchUpdate writing every confirmed-free cell at once.
        await sheetsRequest(client, team.sheetId, 'POST', '/values:batchUpdate', {
          valueInputOption: 'USER_ENTERED',
          data: free.map((c) => ({ range: `'${team.sheetTab}'!${COL_AGENT_LETTER}${c.row}`, values: [[email]] })),
        });
        assignedAwbs.push(...free.map((c) => c.awb));
        // The ndr_lead_assignments mirror is MySQL, not Sheets - it does not count against the
        // shared Sheets quota this batching exists for, so these run alongside rather than
        // serialized into the round trips above. Best-effort by design: the sheet write already
        // succeeded and the agent holds the lead, so losing a history row is a reporting gap, not
        // a failed assignment, and must not stop the fill.
        await Promise.all(free.map((c) => claimNdrLead(c.awb, email).catch((e) => {
          console.error(`api/ndr/next-lead: Agent Name written for ${c.awb} but ndr_lead_assignments claim failed:`, e.message);
        })));
      }

      if (taken.length === 0) break; // nothing lost this round - done
      target = spare.slice(0, taken.length);
      spare = spare.slice(taken.length);
    }

    if (assignedAwbs.length === 0) {
      // Every attempt lost its race, or the budget expired before the first write landed. Fail
      // open rather than error: the agent's disposal already succeeded, so this reports "nothing
      // available this instant" rather than a false failure.
      res.status(200).json({ assigned: false, reason: 'no leads available', load, quota });
      return;
    }
    res.status(200).json({
      assigned: true,
      count: assignedAwbs.length,
      awbNumbers: assignedAwbs,
      load: load + assignedAwbs.length,
      quota,
    });
  } catch (e) {
    console.error('api/ndr/next-lead error:', e);
    res.status(500).json({ error: e.message || 'Could not assign a next lead' });
  }
}

module.exports = handler;
// Exported for ndr-next-lead.test.js - pure, so they are testable without a sheet or a database.
module.exports.buildCandidateList = buildCandidateList;
module.exports.planFillRound = planFillRound;
module.exports.MAX_FILL_PER_REQUEST = MAX_FILL_PER_REQUEST;
