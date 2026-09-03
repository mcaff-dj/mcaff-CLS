// GET /api/nps-product-export - filtered CSV download of PEP_CLS.nps_product (see
// api/_lib/db.js's own comment above getNpsProductExportRows for what that table is).
//
// ponytail: NO AUTH CHECK, NO ROW CAP - deliberately public and unbounded, by explicit
// request (2026-09-03), unlike every other Calling export (api/refund-export.js etc), which
// require a logged-in session AND cap rows to stay under Lambda's ~6MB response ceiling.
// Anyone with this URL can pull NPS survey responses (score/category/brand/product, no
// name/phone/email though - see NPS_PRODUCT_EXPORT_COLUMNS in db.js), and a wide from/to can
// fail with an opaque 500/502 past that ceiling instead of the clear 400 refund-export gives.
// To re-gate/re-cap, see api/refund-export.js and REFUND_EXPORT_MAX_ROWS in db.js.
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
