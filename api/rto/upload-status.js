// GET /api/rto/upload-status?jobId=123 - admin or rto process-admin only. Polled by the
// browser while a CSV upload's background worker (mcaff-cls-csv-upload-worker) processes the
// prepaid-row refund/punch checks - see api/rto/upload-start.js and
// docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md.
const { getSession } = require('../_lib/session');
const { getRtoCsvUploadJob, isCallingProcessAdmin } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'rto';

async function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, TAB_KEY))) {
    return 'Only admins or this process\'s admin can view upload status.';
  }
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to RTO-CRM.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to RTO-CRM.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = await checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const jobId = Number(req.query.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: 'jobId is required' });
    return;
  }

  try {
    const job = await getRtoCsvUploadJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    // rows_pending is deliberately never returned - internal to the worker, and can be large.
    res.status(200).json({
      status: job.status,
      totalRows: job.total_rows,
      prepaidCount: job.prepaid_count,
      checkedCount: job.checked_count,
      alreadyRefundedCount: job.already_refunded_count,
      alreadyPunchedCount: job.already_punched_count,
      appendedCount: job.appended_count,
      errorMessage: job.error_message,
    });
  } catch (e) {
    console.error('api/rto/upload-status error:', e);
    res.status(500).json({ error: e.message || 'Could not fetch upload status' });
  }
};
