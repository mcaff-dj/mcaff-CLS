// GET /api/order-punch/results?jobId=123 - admin-only. CSV of every row's final outcome for a
// job (display_order_code, reason, facility_code, status, so_code, target_channel,
// error_message) - see docs/superpowers/specs/2026-08-21-order-punch-design.md.
const { getSession } = require('../_lib/session');
const { toCSV } = require('../_lib/csv');
const { getOrderPunchJob, getOrderPunchJobRowsForExport } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const SUB_TAB_KEY = 'order-punch';
const COLUMNS = ['display_order_code', 'reason', 'facility_code', 'status', 'so_code', 'target_channel', 'error_message'];

// isAdmin bypasses everything below, same as before this permission existed. A non-admin needs
// 'order-punch' EXPLICITLY in their tab list - unlike every other sub-permission on this card,
// being unrestricted/untouched does NOT imply Order Punch access (see api/_lib/tabs.js's own
// comment on why: this creates real Unicommerce orders).
function checkAccess(session) {
  if (!session) return 'Not authenticated';
  const hasOrderPunchTab = Array.isArray(session.tabPerms?.[CARD_KEY]) && session.tabPerms[CARD_KEY].includes(SUB_TAB_KEY);
  if (!session.isAdmin && !hasOrderPunchTab) return 'Only admins (or an explicitly granted agent) can download Order Punch results.';
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

  const jobId = Number(req.query.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const job = await getOrderPunchJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const rows = await getOrderPunchJobRowsForExport(jobId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="order-punch-results_${jobId}.csv"`);
    return res.status(200).send(toCSV(rows, COLUMNS));
  } catch (e) {
    console.error('api/order-punch/results error:', e);
    return res.status(500).json({ error: e.message || 'Could not build results CSV' });
  }
};
