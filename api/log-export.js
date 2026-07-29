// POST /api/log-export - audit beacon for "someone exported/downloaded a CSV from an
// in-page pivot table". The table export itself is entirely client-side (a Blob download,
// no server round-trip), so this is the only way that action ever reaches the server for
// the admin audit log. Body: { card, tab, table }.
const { CARD_KEYS, logEvent } = require('./_lib/db');
const { getSession } = require('./_lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const card = CARD_KEYS.includes(body.card) ? body.card : null;
  const tab = typeof body.tab === 'string' ? body.tab.slice(0, 60) : '';
  const table = typeof body.table === 'string' ? body.table.slice(0, 200) : '';
  const detail = [tab, table].filter(Boolean).join(' / ') || null;

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  try {
    await logEvent(session.uid, session.email, card, 'csv_export', detail, ip);
  } catch (e) {
    // A logging failure must never surface as a user-facing error for a UI export click.
  }
  res.status(204).end();
};
