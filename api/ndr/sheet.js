// Gated Google Sheets proxy for NDR Calling's own sheet - sibling to api/rto/sheet.js. Now
// read+write: the Call modal's disposition form writes S:U (disposition/remarks/disposed_at)
// and Q:R (assigned_agent/assigned_at claim-on-open) directly from the browser, same trust
// model as RTO's own writeToSheetRow (the frontend owns which range it writes; this route
// stays a dumb, permission-gated proxy). Same service account
// (GOOGLE_SHEETS_CLIENT_EMAIL/GOOGLE_SHEETS_PRIVATE_KEY) already has access to this sheet -
// it's the same one the Python scripts (scripts/lib.py) use to write it.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');

// The one sheet this proxy is allowed to touch - see scripts/sync_ndr_leads_to_sheet.py's
// SPREADSHEET_ID. Rejecting any other sid keeps a permitted-but-malicious request from
// repurposing this service account's access against an unrelated sheet.
const NDR_SHEET_ID = '1oRPRvZaGpgQsZyXO_Q_j5HEZO1nkrFv0spTobfDoQ2g';
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
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${NDR_SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await r.json();
      res.status(r.status).json(data);
      return;
    }

    if (req.method === 'POST' && (req.body || {}).op === 'batchUpdate') {
      const data = (req.body || {}).data || [];
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${NDR_SHEET_ID}/values:batchUpdate`,
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
    console.error('api/ndr/sheet error:', e);
    res.status(500).json({ error: 'Sheets proxy error' });
  }
};
