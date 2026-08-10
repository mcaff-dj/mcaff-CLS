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
      const range = req.query.range || '';
      const { status, data } = await cachedRead(`values:${range}`, async () => {
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { status: r.status, data: await r.json() };
      });
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
      res.status(r.status).json(out);
      return;
    }

    res.status(400).json({ error: 'Unknown or unsupported operation' });
  } catch (e) {
    console.error('api/rto/sheet error:', e);
    res.status(500).json({ error: 'Sheets proxy error' });
  }
};
