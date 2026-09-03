// GET /api/refund-export - Calling Team's "Exports" tab: a filtered CSV download of
// PEP_CLS.refund_all_brands (see api/_lib/db.js's own comment above
// getRefundExportCount/getRefundExportRows for what that table is). PII columns are decided
// from session.isAdmin ONLY - never from anything the client sends, so there is no query param
// that can ask for them.
//
// Gated on 'exports' PLUS its own 'refund-export' tab permission - see api/_lib/tabs.js's own
// comment on that entry. Also backs the standalone /refund-export route
// (app/refund-export/RefundExportClient.js), so this same check applies there too.
const { getSession } = require('./_lib/session');
const { toCSV } = require('./_lib/csv');
const {
  REFUND_EXPORT_MAX_ROWS, REFUND_EXPORT_BASE_COLUMNS, REFUND_EXPORT_PII_COLUMNS,
  getRefundExportCount, getRefundExportRows,
} = require('./_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const SUB_TAB_KEY = 'refund-export';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && (!tabs.includes(TAB_KEY) || !tabs.includes(SUB_TAB_KEY))) {
    return 'You do not have access to Refund Export.';
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  const { from, to, status, refundType, source } = req.query || {};
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD' });
  }
  if (to < from) {
    return res.status(400).json({ error: 'to must not be before from' });
  }

  const filters = { from, to, status, refundType, source };

  try {
    const count = await getRefundExportCount(filters);
    if (count > REFUND_EXPORT_MAX_ROWS) {
      return res.status(400).json({
        error: `${count} rows match - narrow your date range (max ${REFUND_EXPORT_MAX_ROWS} per export)`,
        count,
      });
    }

    const rows = await getRefundExportRows(filters, { includePii: session.isAdmin });
    const headers = session.isAdmin
      ? [...REFUND_EXPORT_BASE_COLUMNS, ...REFUND_EXPORT_PII_COLUMNS]
      : REFUND_EXPORT_BASE_COLUMNS;
    const filename = `refund-export_${from}_to_${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(toCSV(rows, headers));
  } catch (e) {
    console.error('api/refund-export error:', e);
    return res.status(500).json({ error: e.message || 'Export failed' });
  }
};
