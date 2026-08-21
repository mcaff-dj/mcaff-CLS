// GET /api/order-punch/status?jobId=123 - admin-only. Polled by the browser while the
// background worker (mcaff-cls-order-punch-worker) processes a batch - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md.
const { getSession } = require('../_lib/session');
const { getOrderPunchJob } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can view Order Punch status.';
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
    });
  } catch (e) {
    console.error('api/order-punch/status error:', e);
    return res.status(500).json({ error: e.message || 'Could not fetch job status' });
  }
};
