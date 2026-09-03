// GET /api/nps-product-export - Calling Team's "Exports" tab: a filtered CSV download of
// PEP_CLS.nps_product (see api/_lib/db.js's own comment above getNpsProductExportCount/Rows
// for what that table is). Gated the same as api/refund-export.js - one card/tab grant
// ('calling'/'exports') covers every sub-tab in app/exports/ExportsClient.js, there's no
// finer-grained permission for this one.
const { getSession } = require('./_lib/session');
const { toCSV } = require('./_lib/csv');
const {
  NPS_PRODUCT_EXPORT_MAX_ROWS, NPS_PRODUCT_EXPORT_COLUMNS,
  getNpsProductExportCount, getNpsProductExportRows,
} = require('./_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
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
    const count = await getNpsProductExportCount(filters);
    if (count > NPS_PRODUCT_EXPORT_MAX_ROWS) {
      return res.status(400).json({
        error: `${count} rows match - narrow your date range (max ${NPS_PRODUCT_EXPORT_MAX_ROWS} per export)`,
        count,
      });
    }

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
