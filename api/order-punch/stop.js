// POST /api/order-punch/stop {jobId} - admin-only. Sets stop_requested on the job row; the
// Python worker checks this flag between rows and between chunks (see
// scripts/process_order_punch_job.py) and stops picking up new rows once it sees it.
const { getSession } = require('../_lib/session');
const { getOrderPunchJob, setOrderPunchJobStopRequested } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can stop Order Punch.';
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
