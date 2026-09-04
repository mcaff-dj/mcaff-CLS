// GET /api/nps-product-export - filtered CSV download of PEP_CLS.nps_product (see
// api/_lib/db.js's own comment above getNpsProductExportRows for what that table is).
//
// ponytail: NO AUTH CHECK - deliberately public again, by explicit request (2026-09-04) -
// reverses the brief same-day window where this required login + the 'nps-product-export' tab
// permission (added alongside the other 3 Exports sub-tabs' own permissions). That tab
// permission entry still exists in api/_lib/tabs.js and app/exports/ExportsClient.js still
// checks it client-side to decide whether to show the "Export Product NPS" button in-app - but
// it is now PURELY COSMETIC: this endpoint itself enforces nothing, so anyone with the URL can
// call it directly regardless of that checkbox. To re-gate it, restore the getSession/
// checkAccess block api/refund-export.js still uses (or see this file's own git history).
//
// Headers are derived from the first returned row's own keys, not a fixed list - getNpsProduct
// ExportRows now does SELECT * (by explicit request 2026-09-04, see its own comment), so the
// exact column set is whatever mysql2 hands back, unknown until a real row exists. A date range
// matching zero rows produces a headerless empty CSV (nothing to derive columns from) - a rarer
// edge than it sounds, since 'brand' alone already means at least one match almost always.
const { toCSV } = require('./_lib/csv');
const { getNpsProductExportRows } = require('./_lib/db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { from, to, brand } = req.query || {};
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD' });
  }
  if (to < from) {
    return res.status(400).json({ error: 'to must not be before from' });
  }

  const filters = { from, to, brand };

  try {
    const rows = await getNpsProductExportRows(filters);
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const filename = `nps-product-export_${from}_to_${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(toCSV(rows, headers));
  } catch (e) {
    console.error('api/nps-product-export error:', e);
    return res.status(500).json({ error: e.message || 'Export failed' });
  }
};
