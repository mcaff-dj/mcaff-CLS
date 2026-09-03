// GET /api/nps-product-export - filtered CSV download of PEP_CLS.nps_product (see
// api/_lib/db.js's own comment above getNpsProductExportRows for what that table is).
//
// Session + tab-permission gated (2026-09-04) - reverses this endpoint's brief no-auth window
// (2026-09-03): gated on 'exports' PLUS its own 'nps-product-export' tab permission, same
// pattern as api/refund-export.js. The row cap is still deliberately absent though (a separate,
// still-standing decision, not reversed here) - a wide from/to can still fail with an opaque
// 500/502 past Lambda's ~6MB response ceiling instead of the clear 400 refund-export gives; see
// REFUND_EXPORT_MAX_ROWS in db.js to add one back if that becomes a problem.
const { getSession } = require('./_lib/session');
const { toCSV } = require('./_lib/csv');
const { NPS_PRODUCT_EXPORT_COLUMNS, getNpsProductExportRows } = require('./_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const SUB_TAB_KEY = 'nps-product-export';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && (!tabs.includes(TAB_KEY) || !tabs.includes(SUB_TAB_KEY))) {
    return 'You do not have access to Export Product NPS.';
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

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
