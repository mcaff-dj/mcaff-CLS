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
const { toCSV } = require('./_lib/csv');
const { NPS_PRODUCT_EXPORT_COLUMNS, getNpsProductExportRows } = require('./_lib/db');

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
    const filename = `nps-product-export_${from}_to_${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(toCSV(rows, NPS_PRODUCT_EXPORT_COLUMNS));
  } catch (e) {
    console.error('api/nps-product-export error:', e);
    return res.status(500).json({ error: e.message || 'Export failed' });
  }
};
