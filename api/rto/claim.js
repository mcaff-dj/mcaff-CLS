// The authoritative path for an agent claiming an RTO lead for themselves.
//
// Replaces the browser writing Column Q directly through api/rto/sheet.js's generic range
// proxy, which had two problems this route exists to close:
//
//   1. No quota. The auto-assigner (scripts/assign_leads.py) has always capped how many
//      undisposed leads an agent may hold, but a manual claim bypassed that entirely, so an
//      agent could self-claim indefinitely. Observed 2026-08-18: five of six online agents
//      over quota, one at 34 against a cap of 20 - after which the robot correctly refused to
//      auto-assign them more, which those agents reported as "leads aren't being assigned to
//      me." The cap was enforced in exactly one of the two ways a lead can be assigned.
//   2. No history row. A self-claimed lead got no CLS_RTO_calling row until it was disposed,
//      so the table could not answer "how many leads does this agent hold" - see claimRtoLead.
//
// The browser runs the SAME quota check first (leadQuota.checkClaimQuota) for immediate
// feedback; this one is what actually decides, since anything enforced only in the browser is
// one devtools call away from not being enforced at all. Both import the same helper so they
// cannot drift apart.
//
// The email is taken from the caller's own session and never from the request body - the same
// rule /api/auth/presence follows, so an agent can only ever claim as themselves.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { claimRtoLead, getRtoAgentQuota } = require('../_lib/db');
const { resolveAgentQuota } = require('../_lib/leadQuota');
const leadAssignmentRules = require('../_lib/leadAssignmentRules.json');

// Same sheet and same gate as api/rto/sheet.js - see its comments for why the id is pinned
// rather than taken from the request.
const RTO_SHEET_ID = '1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI';
const SHEET_TAB = 'Data';
const AGENT_COL = 'Q';
const CARD_KEY = 'calling';
const TAB_KEY = 'rto';

// Its own JWT rather than one shared with api/rto/sheet.js: that module's export is its request
// handler, and reaching into it for the client would couple this route to that file's internals
// for the sake of eight lines of setup. Same env vars, same service account.
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

// Load is counted from the SHEET, not from CLS_RTO_calling, even though the table would be one
// cheap indexed COUNT. The table cannot answer this question today: it accumulates live rows
// that nothing ever closes. Measured 2026-08-18 for one agent - 35 rows counted live and
// undisposed, made up of 19 orders no longer present on the sheet at all (it is a rolling
// window and old orders age out), 15 whose Column Q now names a DIFFERENT agent (a manual or
// bulk reassign writes Q but never stamps reassigned_away_at on the outgoing row), and exactly
// 1 lead she actually held. Gating on that number would have refused a claim from an agent
// holding one lead - the very failure this route exists to prevent, with the sign flipped.
//
// The sheet is what decides who holds a lead and whether it has been worked, so it is what the
// cap has to be measured against - and it keeps this gate identical to the browser's own
// pre-check. scripts/backfill_selfclaimed_rto_rows.py is what repairs the table; once it is
// clean this can move to the cheaper COUNT.
//
// Columns Q:Z in one batchGet alongside E (order id, for the same first-row-wins dedup the CRM
// does - the sheet genuinely repeats order ids). Within Q:Z the offsets are Q=0 agent,
// R=1 connected, S=2 attempt, T=3 disposition, U=4 legacy remarks, Z=9 remarks - the same five
// "this lead has been worked" signals scripts/lead_priority.py defines.
const LOAD_CACHE_TTL_MS = 15000;
let _loadCache = null; // { expiresAt, promise } - one fetch serves every agent claiming inside the window

const ORDER_RANGE = `${SHEET_TAB}!E2:E`;
const WORK_RANGE = `${SHEET_TAB}!Q2:Z`;

function parseLoadByAgent(data) {
  const orders = (data.valueRanges && data.valueRanges[0] && data.valueRanges[0].values) || [];
  const work = (data.valueRanges && data.valueRanges[1] && data.valueRanges[1].values) || [];
  const seen = new Set();
  const load = new Map();
  for (let i = 0; i < orders.length; i++) {
    const key = (((orders[i] || [])[0]) || '').toString().trim().toUpperCase();
    if (!key || seen.has(key)) continue; // first row wins, matching the CRM's dedup
    seen.add(key);
    const w = work[i] || []; // trailing empty cells are omitted by the API, so index defensively
    const agent = ((w[0] || '').toString()).trim().toLowerCase();
    if (!agent || agent === 'unassigned') continue;
    const worked = [1, 2, 3, 4, 9].some((c) => ((w[c] || '').toString()).trim());
    if (worked) continue;
    load.set(agent, (load.get(agent) || 0) + 1);
  }
  return load;
}

function getLoadByAgent(client) {
  if (_loadCache && Date.now() < _loadCache.expiresAt) return _loadCache.promise;
  const promise = sheetsRequest(
    client, 'GET',
    `/values:batchGet?ranges=${encodeURIComponent(ORDER_RANGE)}&ranges=${encodeURIComponent(WORK_RANGE)}`,
  ).then(parseLoadByAgent).catch((e) => {
    // Never serve a failed read for the rest of the window - one blip would otherwise gate
    // every claim for 15s on an error.
    if (_loadCache && _loadCache.promise === promise) _loadCache = null;
    throw e;
  });
  _loadCache = { expiresAt: Date.now() + LOAD_CACHE_TTL_MS, promise };
  return promise;
}

module.exports = async (req, res) => {
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

  const { orderNumber, rowNumber, awbCode, rtoReason, paymentMode, addressCity, addressState, addressPincode } = req.body || {};
  const email = session.email;
  if (!orderNumber || !rowNumber) {
    res.status(400).json({ error: 'orderNumber and rowNumber are required' });
    return;
  }
  const row = Number(rowNumber);
  // Row 1 is the header - writing there would overwrite the column title itself.
  if (!Number.isInteger(row) || row < 2) {
    res.status(400).json({ error: 'rowNumber must be a data row (2 or greater)' });
    return;
  }

  try {
    const client = getClient();
    const cell = `${SHEET_TAB}!${AGENT_COL}${row}`;

    // Re-read Column Q server-side rather than trusting the browser's view of it. Two different
    // agents can open the same still-unassigned lead and both press Claim; whoever's write
    // lands second would otherwise silently take the lead off the first. The browser makes the
    // same check, but its copy of the sheet can be up to a sync interval stale.
    const current = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(cell)}`);
    const held = (((current.values || [])[0] || [])[0] || '').toString().trim();
    if (held && held.toLowerCase() !== 'unassigned') {
      // Not an error - the lead is simply taken. 409 so the browser can say who has it and
      // refresh, rather than showing a generic failure.
      res.status(409).json({ error: `Lead ${orderNumber} is already assigned to ${held}.`, assignedTo: held });
      return;
    }

    // Quota gate - see getLoadByAgent for why load is counted from the sheet rather than from
    // CLS_RTO_calling.
    const [loadByAgent, quota] = await Promise.all([
      getLoadByAgent(client),
      getRtoAgentQuota(email),
    ]);
    const load = loadByAgent.get(email.trim().toLowerCase()) || 0;
    const effectiveQuota = resolveAgentQuota(
      [{ email, maxQuota: quota }], email, leadAssignmentRules.assignmentQuota,
    );
    if (load >= effectiveQuota) {
      res.status(409).json({
        error: `You already hold ${load} undisposed lead(s) - at your quota of ${effectiveQuota}. Dispose some before claiming more.`,
        load,
        quota: effectiveQuota,
      });
      return;
    }

    await sheetsRequest(client, 'PUT', `/values/${encodeURIComponent(cell)}?valueInputOption=USER_ENTERED`, {
      range: cell,
      values: [[email]],
    });

    // After the sheet write, deliberately. The sheet is what the CRM reads and what the cron
    // treats as authoritative for who holds a lead, so a MySQL row for a claim that never
    // reached the sheet would be a lie. This ordering can leave a claimed lead without its row
    // if the insert fails - recoverable (the disposal path still upserts, and the backfill
    // script re-derives from the sheet), unlike the reverse.
    let recorded = true;
    try {
      ({ recorded } = await claimRtoLead(orderNumber, email, awbCode, rtoReason, paymentMode, addressCity, addressState, addressPincode));
    } catch (e) {
      // The claim itself succeeded - the agent holds the lead. Losing the history row is a
      // reporting gap, not a failed claim, so this must not surface as an error to the agent.
      console.error(`api/rto/claim: Column Q written for ${orderNumber} but CLS_RTO_calling insert failed:`, e.message);
      recorded = false;
    }

    res.status(200).json({ ok: true, assignedTo: email, load: load + 1, quota: effectiveQuota, recorded });
  } catch (e) {
    console.error('api/rto/claim error:', e);
    res.status(500).json({ error: e.message || 'Could not claim this lead' });
  }
};
