// POST /api/delivery-escalation/sales-pincode-import - Calling Team's "Exports" tab CSV
// upload: manual override of PEP_CLS.Delivery_escalation.sales_Pincode, matched per row on
// (Pincode, brand, order_date, delivery_partner) - see api/_lib/db.js's own comment above
// bulkUpdateDeliveryEscalationSalesPincode for the matching rules and why brand/delivery_partner
// compare case-insensitively.
//
// Gated like api/refund-export.js (session + 'calling'/'exports' access) - unlike
// api/delivery-escalation/record.js's own endpoints, which are deliberately open for external
// callers. This one writes on nothing but the caller's own say-so (no per-row identity check
// beyond the match key), so it stays behind a login.
const { getSession } = require('../_lib/session');
const { bulkUpdateDeliveryEscalationSalesPincode } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
// Same ceiling and same reasoning as record.js's own MAX_BULK_ROWS - one request must finish
// inside API Gateway's ~29s integration ceiling.
const MAX_BULK_ROWS = 10000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'rows is required' });
  if (rows.length > MAX_BULK_ROWS) {
    return res.status(400).json({ error: `Too many rows (${rows.length}) - split into batches of ${MAX_BULK_ROWS} or fewer.` });
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

  try {
    const results = await bulkUpdateDeliveryEscalationSalesPincode(clean);
    res.status(200).json({ results, rejected });
  } catch (e) {
    console.error('api/delivery-escalation/sales-pincode-import error:', e);
    res.status(500).json({ error: e.message || 'Update failed' });
  }
};
