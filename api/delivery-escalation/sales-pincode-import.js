// /api/delivery-escalation/sales-pincode-import - Calling Team's "Exports" tab CSV upload:
// manual override of PEP_CLS.Delivery_escalation.sales_Pincode, matched per row on
// (Pincode, brand, order_date, delivery_partner) - see api/_lib/db.js's own comment above
// bulkUpdateDeliveryEscalationSalesPincode for the matching/additive-update rules.
//
// GET ?op=meta     -> last-upload metadata (who/when/file/group count), for the tab's display.
// GET ?op=download -> that upload's applied-rows CSV (see db.js's own note: this is the
//                     grouped data actually applied, not a copy of the original raw file).
// POST             -> the upload itself. contentHash (client-computed SHA-256 of the raw file)
//                     is compared against the stored last upload's hash BEFORE any write - an
//                     exact match is rejected outright, since the additive update in db.js is
//                     not idempotent and a repeat upload would silently double-count.
//
// Gated like api/refund-export.js (session + 'calling'/'exports' access) - unlike
// api/delivery-escalation/record.js's own endpoints, which are deliberately open for external
// callers. This one writes on nothing but the caller's own say-so (no per-row identity check
// beyond the match key), so it stays behind a login.
const { getSession } = require('../_lib/session');
const { toCSV } = require('../_lib/csv');
const {
  bulkUpdateDeliveryEscalationSalesPincode,
  getLastSalesPincodeUpload, getLastSalesPincodeUploadCsv, recordSalesPincodeUpload,
} = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
// Same ceiling and same reasoning as record.js's own MAX_BULK_ROWS - one request must finish
// inside API Gateway's ~29s integration ceiling.
const MAX_BULK_ROWS = 10000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const APPLIED_CSV_HEADERS = ['pincode', 'brand', 'orderDate', 'deliveryPartner', 'salesPincode'];

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  if (req.method === 'GET') {
    try {
      if (req.query?.op === 'download') {
        const last = await getLastSalesPincodeUploadCsv();
        if (!last) return res.status(404).json({ error: 'No upload recorded yet.' });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${last.file_name}"`);
        return res.status(200).send(last.csv_content);
      }
      const last = await getLastSalesPincodeUpload();
      return res.status(200).json({ last });
    } catch (e) {
      console.error('api/delivery-escalation/sales-pincode-import GET error:', e);
      return res.status(500).json({ error: e.message || 'Could not load last upload' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const fileName = String(req.body?.fileName || 'upload.csv').trim().slice(0, 255);
  const fileSize = Number(req.body?.fileSize) || 0;
  const contentHash = String(req.body?.contentHash || '').trim().toLowerCase();
  if (!rows.length) return res.status(400).json({ error: 'rows is required' });
  if (rows.length > MAX_BULK_ROWS) {
    return res.status(400).json({ error: `Too many rows (${rows.length}) - split into batches of ${MAX_BULK_ROWS} or fewer.` });
  }

  try {
    if (contentHash) {
      const last = await getLastSalesPincodeUpload();
      if (last && last.content_hash === contentHash) {
        return res.status(409).json({
          error: `This exact file was already uploaded on ${last.uploaded_at} by ${last.uploaded_by} - rejected to avoid double-counting.`,
        });
      }
    }

    const clean = [];
    const rejected = [];
    rows.forEach((r, idx) => {
      const pincode = String(r.pincode || '').trim();
      const brand = String(r.brand || '').trim();
      const orderDate = String(r.orderDate || '').trim();
      const deliveryPartner = String(r.deliveryPartner || '').trim();
      const salesPincode = Number(r.salesPincode);
      if (!pincode || !brand || !DATE_RE.test(orderDate) || !deliveryPartner || !Number.isInteger(salesPincode) || salesPincode < 0) {
        rejected.push({ row: idx + 1, reason: 'missing/invalid pincode, brand, orderDate (YYYY-MM-DD), deliveryPartner, or salesPincode (non-negative integer)' });
        return;
      }
      clean.push({ pincode, brand, orderDate, deliveryPartner, salesPincode });
    });
    if (!clean.length) {
      return res.status(400).json({ error: 'No valid rows.', rejected });
    }

    const results = await bulkUpdateDeliveryEscalationSalesPincode(clean);

    if (contentHash) {
      await recordSalesPincodeUpload({
        uploadedBy: session.email || 'unknown',
        fileName, fileSize, groupCount: clean.length, contentHash,
        csvContent: toCSV(clean, APPLIED_CSV_HEADERS),
      });
    }

    res.status(200).json({ results, rejected });
  } catch (e) {
    console.error('api/delivery-escalation/sales-pincode-import POST error:', e);
    res.status(500).json({ error: e.message || 'Update failed' });
  }
};
