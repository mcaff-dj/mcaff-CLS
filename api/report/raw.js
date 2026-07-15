// Gated raw-data CSV server: GET /api/report/raw?card=mcaffeine&tab=delivery
// The CSVs live under api/_reports/ (same non-public convention as the report HTML in
// [card].js) so downloading one always goes through the same session + permission check
// as viewing the report itself. Only mcaffeine/hyphen have raw exports (productkyc is a
// separate standalone report with no ticket-level export built for it).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getSession } = require('../_lib/session');
const { CARD_KEYS, logAccess } = require('../_lib/db');

const RAW_CARD_KEYS = CARD_KEYS.filter((k) => k !== 'productkyc');
const VALID_TABS = new Set(['overview', 'delivery', 'warehouse', 'technical', 'packaging', 'product', 'suggestion', 'prodpkg']);

module.exports = async (req, res) => {
  const card = (req.query && req.query.card) || '';
  const tab = (req.query && req.query.tab) || '';
  if (!RAW_CARD_KEYS.includes(card) || !VALID_TABS.has(tab)) {
    res.status(404).send('Not found');
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent('/api/report/raw?card=' + card + '&tab=' + tab)}` });
    res.end();
    return;
  }
  if (!(session.perms || []).includes(card)) {
    res.status(403).send('You do not have access to this report. Contact your admin to request access.');
    return;
  }

  try {
    const filePath = path.join(__dirname, '..', '_reports', `${card}_raw_${tab}.csv.gz`);
    const csv = zlib.gunzipSync(fs.readFileSync(filePath));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${card}_${tab}_raw.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(csv);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logAccess(session.uid, session.email, card, ip).catch(() => {});
  } catch (e) {
    res.status(404).send('Raw data not available for this tab yet.');
  }
};
