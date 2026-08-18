// Gated Google Sheets proxy for Delivery-Escalation's lead source - a tracking sheet with one
// tab per brand (HYPHEN, mCaffeine). Sibling to api/ndr/sheet.js and api/rto/sheet.js, same
// shape (a dumb, permission-gated read/write proxy - the frontend owns which range it reads or
// writes). Deliberately the ONE calling process with no Postgres involvement at all beyond this
// gate: no roster/presence/quota/business-hours/dispositions tables, no parallel write into a
// lead-assignment history table - see api/_lib/callingProcesses.json's "deliveryescalation"
// entry for why.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');

// The one sheet this proxy is allowed to touch - rejecting any other sid keeps a
// permitted-but-malicious request from repurposing this service account's access against an
// unrelated sheet (same defense as NDR's own sheet.js).
const DELIVERY_ESCALATION_SHEET_ID = '1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w';
const CARD_KEY = 'calling';
const TAB_KEY = 'deliveryescalation';

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
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Delivery-Escalation.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Delivery-Escalation.';
  return null;
}

// Short-TTL read cache, same reasoning and TTL as api/ndr/sheet.js's own: without it every
// page-load/poll (now doubled - one call per brand tab) is a live Sheets API call with nothing
// in front of it.
const READ_CACHE_TTL_MS = 20000;
const _readCache = new Map(); // key (range) -> { expiresAt, promise }

function cachedRead(key, fetcher) {
  const hit = _readCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const promise = fetcher();
  _readCache.set(key, { expiresAt: Date.now() + READ_CACHE_TTL_MS, promise });
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
  if (sid !== DELIVERY_ESCALATION_SHEET_ID) {
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
          `https://sheets.googleapis.com/v4/spreadsheets/${DELIVERY_ESCALATION_SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { status: r.status, data: await r.json() };
      });
      res.status(status).json(data);
      return;
    }

    if (req.method === 'POST' && (req.body || {}).op === 'batchUpdate') {
      const data = (req.body || {}).data || [];
      // RAW, not USER_ENTERED - same reasoning as api/ndr/sheet.js: nothing this UI ever writes
      // (Agent Name, Action Date, Outcome, Remarks) needs Sheets' locale-dependent auto-convert.
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${DELIVERY_ESCALATION_SHEET_ID}/values:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'RAW', data }),
        }
      );
      const out = await r.json().catch(() => ({}));
      if (r.ok) _readCache.clear();
      res.status(r.status).json(out);
      return;
    }

    res.status(400).json({ error: 'Unknown or unsupported operation' });
  } catch (e) {
    console.error('api/delivery-escalation/sheet error:', e);
    res.status(500).json({ error: 'Sheets proxy error' });
  }
};
