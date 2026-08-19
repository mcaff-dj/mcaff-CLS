// Gated Google Sheets proxy for the RTO-CRM page (app/rto-crm/page.js).
// The service-account credential used to be embedded in rto-crm.html's client-side JS -
// anyone opening DevTools could read it. It now lives only here, server-side, as
// GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars, behind the same
// session + 'calling' card permission check used elsewhere in api/.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');

// The one sheet this proxy is allowed to touch - matches DEFAULT_SHEET_URL in
// app/rto-crm/page.js. Rejecting any other sid keeps a permitted-but-malicious request
// from repurposing this service account's write access against an unrelated sheet.
const RTO_SHEET_ID = '1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI';
const CARD_KEY = 'calling';
const TAB_KEY = 'rto';

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

// Last column anything actually reads. scripts/lead_priority.py's highest index is COL_REMARKS =
// 25 = Z (the agent-remarks column); AA:AD carry data nothing in the CRM or the cron ever looks at.
const LAST_USED_COL = 'Z';

// A bare tab reference ('Data') means "every column", which is how this endpoint started returning
// AA:AD for 14k rows to nobody's benefit. On 2026-08-19 that tipped the response past API Gateway's
// hard 6 MB ceiling and the CRM began failing with opaque 500s - agents saw "Sync failed", could not
// see their leads, could not dispose them, so their load never fell below quota and the assignment
// robot correctly concluded there was nobody to assign to. One oversized read stalled the whole desk.
//
// Measured that morning: 'Data' serialised to a 6.43 MB Lambda response (the limit counts the
// JSON-ESCAPED envelope, not the 5.64 MB raw body - escaping the quotes adds ~14%, which is why the
// raw figure looked deceptively safe). 'Data'!A:Z is 5.71 MB.
//
// Clamped HERE rather than only at the caller because api/ (Lambda) and app/ (Amplify) deploy
// separately: a client-side-only fix leaves the Lambda able to serve the oversized range to any
// browser still running the old bundle. Ranges that already name columns are passed through
// untouched - this only fills in the "unbounded" case.
//
// NOTE: this buys roughly 0.29 MB of headroom, ~700 rows at the current ~130 rows/day net growth.
// It is a floor, not a fix. The durable fix is gzip inside the Lambda (this payload compresses
// ~85-90%); see docs/2026-08-18-rto-crm-performance-audit.md.
function clampRange(range) {
  const bareTab = /^'?([^'!]+)'?$/.exec((range || '').trim());
  if (!bareTab) return range; // already qualified with a cell/column range - leave it alone
  return `${bareTab[1]}!A:${LAST_USED_COL}`;
}

// API Gateway rejects a Lambda response over 6 MB, and the rejection surfaces to the browser as a
// bare 500 with nothing in the logs tying it to size - which is exactly why the 2026-08-19 outage
// took a while to identify. Log loudly as the payload approaches the ceiling so the next one is
// obvious from CloudWatch alone. Measured against the escaped envelope, not the raw body.
const PAYLOAD_WARN_BYTES = 5 * 1024 * 1024;
function warnIfLarge(label, data) {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (bytes >= PAYLOAD_WARN_BYTES) {
      console.warn(
        `api/rto/sheet: ${label} response is ${(bytes / 1048576).toFixed(2)} MB raw ` +
        `(~${((bytes * 1.14) / 1048576).toFixed(2)} MB once JSON-escaped into the Lambda envelope). ` +
        'API Gateway hard-fails at 6 MB - narrow the range or enable compression.'
      );
    }
  } catch (e) { /* size logging must never break the response */ }
}

// Short-TTL read cache for the GET ops below (values/batchGet). Without it, every page-load
// or poll is a live Sheets API call with nothing in front of it. A 20s staleness window is an
// acceptable tradeoff for the load this saves (mirrors scripts/assign_leads.py's
// GOKWIK_CACHE_TTL - accept a little staleness for a lot less load). A plain module-scoped
// Map, not a shared/external cache: it persists across invocations on the same warm Lambda
// container, which is all we need - no cross-container invalidation, since a stale-by-20s
// read is fine either way.
const READ_CACHE_TTL_MS = 20000;
const _readCache = new Map(); // key (op+params) -> { expiresAt, promise }

// Singleflight: a key already in the map - whether its fetch is still in flight or it
// resolved within the last 20s - is reused instead of firing a duplicate live call, so a
// burst of simultaneous agent page-loads for the same range collapses into one real request.
function cachedRead(key, fetcher) {
  const hit = _readCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const promise = fetcher();
  _readCache.set(key, { expiresAt: Date.now() + READ_CACHE_TTL_MS, promise });
  // A failed fetch must not poison the cache for the rest of the TTL window - evict on
  // rejection so the very next request retries against Sheets instead of replaying the
  // same error for up to 20s.
  promise.catch(() => _readCache.delete(key));
  return promise;
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const sid = (req.method === 'GET' ? req.query.sid : (req.body || {}).sid) || '';
  if (sid !== RTO_SHEET_ID) {
    res.status(400).json({ error: 'Unknown sheet' });
    return;
  }

  let token;
  try {
    const client = getClient();
    ({ token } = await client.getAccessToken());
  } catch (e) {
    res.status(500).json({ error: 'Sheets credentials not configured: ' + (e.message || e) });
    return;
  }

  try {
    if (req.method === 'GET' && req.query.op === 'values') {
      // Clamped before the cache key so every caller - old bundle or new - shares one entry.
      const range = clampRange(req.query.range || '');
      const { status, data } = await cachedRead(`values:${range}`, async () => {
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { status: r.status, data: await r.json() };
      });
      warnIfLarge(`values:${range}`, data);
      res.status(status).json(data);
      return;
    }

    if (req.method === 'GET' && req.query.op === 'batchGet') {
      const ranges = [].concat(req.query.ranges || []);
      const { status, data } = await cachedRead(`batchGet:${JSON.stringify(ranges)}`, async () => {
        const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}/values:batchGet?${qs}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { status: r.status, data: await r.json() };
      });
      res.status(status).json(data);
      return;
    }

    if (req.method === 'POST' && (req.body || {}).op === 'batchUpdate') {
      const data = (req.body || {}).data || [];
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}/values:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
        }
      );
      const out = await r.json().catch(() => ({}));
      // Same staleness bug fixed in api/ndr/sheet.js: a write must not leave the 20s read cache
      // above serving pre-write data to a poll landing inside that window.
      if (r.ok) _readCache.clear();
      res.status(r.status).json(out);
      return;
    }

    res.status(400).json({ error: 'Unknown or unsupported operation' });
  } catch (e) {
    console.error('api/rto/sheet error:', e);
    res.status(500).json({ error: 'Sheets proxy error' });
  }
};
