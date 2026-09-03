// GET /api/order-punch/status?jobId=123 - admin-only. Polled by the browser while the
// background worker (mcaff-cls-order-punch-worker) processes a batch - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md.
const { getSession } = require('../_lib/session');
const { getOrderPunchJob } = require('../_lib/db');
const { isJobStalled } = require('../_lib/orderPunchRows');

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
  if (!session.isAdmin && !hasOrderPunchTab) return 'Only admins (or an explicitly granted agent) can view Order Punch status.';
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
    return res.status(200).json({
      status: job.status,
      totalRows: job.total_rows,
      processedCount: job.processed_count,
      successCount: job.success_count,
      errorCount: job.error_count,
      skippedCount: job.skipped_count,
      errorMessage: job.error_message,
      // Nothing has touched this job in 15 minutes while it still claims to be live, so the
      // worker invoke died without being able to record why (see isJobStalled). Reported as a
      // flag rather than by rewriting status, because the row is not actually 'failed' - a
      // continuation invoke that was merely slow to cold-start would clear this on the next poll.
      stalled: isJobStalled(job.status, job.updated_at),
    });
  } catch (e) {
    console.error('api/order-punch/status error:', e);
    return res.status(500).json({ error: e.message || 'Could not fetch job status' });
  }
};
