// POST /api/order-punch/stop {jobId} - admin-only. Sets stop_requested on the job row; the
// Python worker checks this flag between rows and between chunks (see
// scripts/process_order_punch_job.py) and stops picking up new rows once it sees it.
const { getSession } = require('../_lib/session');
const { getOrderPunchJob, setOrderPunchJobStopRequested } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const SUB_TAB_KEY = 'order-punch';

// isAdmin bypasses everything below, same as before this permission existed. A non-admin needs
// 'order-punch' EXPLICITLY in their tab list - unlike every other sub-permission on this card,
// being unrestricted/untouched does NOT imply Order Punch access (see api/_lib/tabs.js's own
// comment on why: this creates real Unicommerce orders).
function checkAccess(session) {
  if (!session) return 'Not authenticated';
  const hasOrderPunchTab = Array.isArray(session.tabPerms?.[CARD_KEY]) && session.tabPerms[CARD_KEY].includes(SUB_TAB_KEY);
  if (!session.isAdmin && !hasOrderPunchTab) return 'Only admins (or an explicitly granted agent) can stop Order Punch.';
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

  const { jobId } = req.body || {};
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const job = await getOrderPunchJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await setOrderPunchJobStopRequested(id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('api/order-punch/stop error:', e);
    return res.status(500).json({ error: e.message || 'Could not stop this job' });
  }
};
