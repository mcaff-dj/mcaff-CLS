// Gated Google Sheets proxy for NDR Calling's real lead source - an already-existing,
// actively-used external spreadsheet ("NDR Calling - June"), not one this app owns. Sibling
// to api/rto/sheet.js. Read+write: the Call modal's disposition form writes exactly three of
// that sheet's own existing columns (Calling Date/Connected/Remarks - see
// RtoCrmClient.js's saveNdrDisposition) and the claim-on-open path writes Agent Name, directly
// from the browser, same trust model as RTO's own writeToSheetRow (the frontend owns which
// range it writes; this route stays a dumb, permission-gated proxy). Confirmed this session
// that the service account (GOOGLE_SHEETS_CLIENT_EMAIL/GOOGLE_SHEETS_PRIVATE_KEY) already has
// Editor access on this external sheet, not just Viewer.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');

// The one sheet this proxy is allowed to touch - see scripts/assign_ndr_leads.py's
// SPREADSHEET_ID. Rejecting any other sid keeps a permitted-but-malicious request from
// repurposing this service account's access against an unrelated sheet.
const NDR_SHEET_ID = '12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI';
const CARD_KEY = 'calling';
const TAB_KEY = 'ndr';

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
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NDR Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to NDR Calling.';
  return null;
}

// Short-TTL read cache for the 'values' GET op below. Without it, every page-load or poll is
// a live Sheets API call with nothing in front of it. A 20s staleness window is an acceptable
// tradeoff for the load this saves (mirrors scripts/assign_leads.py's GOKWIK_CACHE_TTL -
// accept a little staleness for a lot less load). A plain module-scoped Map, not a shared/
// external cache: it persists across invocations on the same warm Lambda container, which is
// all we need - no cross-container invalidation, since a stale-by-20s read is fine either way.
const READ_CACHE_TTL_MS = 20000;
const _readCache = new Map(); // key (range) -> { expiresAt, promise }

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
  if (sid !== NDR_SHEET_ID) {
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
          `https://sheets.googleapis.com/v4/spreadsheets/${NDR_SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { status: r.status, data: await r.json() };
      });
      res.status(status).json(data);
      return;
    }

    if (req.method === 'POST' && (req.body || {}).op === 'batchUpdate') {
      const data = (req.body || {}).data || [];
      // RAW, not USER_ENTERED: every value this UI ever writes (Agent Name, Connected Yes/No,
      // Outcome, Remarks, Calling Date) is plain text nobody needs Sheets to auto-convert.
      // USER_ENTERED bit us for real - writing "06-08-2026" (DD-MM-YYYY, the format the user
      // explicitly asked for) got silently reinterpreted as MM-DD-YYYY under this sheet's
      // locale and displayed back as "8 Jun" instead of the intended 6 Aug. RAW stores exactly
      // the string sent, no locale-dependent guessing.
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${NDR_SHEET_ID}/values:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'RAW', data }),
        }
      );
      const out = await r.json().catch(() => ({}));
      res.status(r.status).json(out);
      return;
    }

    res.status(400).json({ error: 'Unknown or unsupported operation' });
  } catch (e) {
    console.error('api/ndr/sheet error:', e);
    res.status(500).json({ error: 'Sheets proxy error' });
  }
};
