// Gated report server: GET /api/report/mcaffeine|hyphen|productkyc
// The actual HTML lives under api/_reports/ (NOT publicly servable - only this function
// reads it), so viewing a report always goes through a session + permission check.
const fs = require('fs');
const path = require('path');
const { getSession } = require('../_lib/session');
const { CARD_KEYS, logAccess } = require('../_lib/db');

module.exports = async (req, res) => {
  const card = (req.query && req.query.card) || '';
  if (!CARD_KEYS.includes(card)) {
    res.status(404).send('Not found');
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent('/api/report/' + card)}` });
    res.end();
    return;
  }
  if (!(session.perms || []).includes(card)) {
    res.status(403).send('You do not have access to this report. Contact your admin to request access.');
    return;
  }

  try {
    const filePath = path.join(__dirname, '..', '_reports', `${card}.html`);
    const html = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(html);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logAccess(session.uid, session.email, card, ip).catch(() => {});
  } catch (e) {
    res.status(500).send('Could not load report: ' + (e.message || String(e)));
  }
};
