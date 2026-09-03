// POST /api/order-punch/start - admin-only. Queues a batch of orders for repunch via the
// background Lambda worker (mcaff-cls-order-punch-worker) - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md. Accepts the same {doc, reason,
// facility_code}[] shape whether the browser built it from a parsed CSV or the manual
// multi-row form; this endpoint only validates and queues, it never talks to Unicommerce
// itself (that's the worker's job, entirely in Python - see
// scripts/process_order_punch_job.py).
const { getSession } = require('../_lib/session');
const { validateRows } = require('../_lib/orderPunchRows');
const { createOrderPunchJob, failOrderPunchJob } = require('../_lib/db');
const { triggerLambda } = require('../_lib/lambdaTrigger');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const SUB_TAB_KEY = 'order-punch';
const ORDER_PUNCH_WORKER_LAMBDA = 'mcaff-cls-order-punch-worker';

// isAdmin bypasses everything below, same as before this permission existed. A non-admin needs
// 'order-punch' EXPLICITLY in their tab list - unlike every other sub-permission on this card,
// being unrestricted/untouched does NOT imply Order Punch access (see api/_lib/tabs.js's own
// comment on why: this creates real Unicommerce orders).
function checkAccess(session) {
  if (!session) return 'Not authenticated';
  const hasOrderPunchTab = Array.isArray(session.tabPerms?.[CARD_KEY]) && session.tabPerms[CARD_KEY].includes(SUB_TAB_KEY);
  if (!session.isAdmin && !hasOrderPunchTab) return 'Only admins (or an explicitly granted agent) can run Order Punch.';
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

  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows (a non-empty array) is required' });
  }

  const { validRows, errors } = validateRows(rows);
  if (!validRows.length) {
    return res.status(400).json({ error: 'No valid rows to queue', errors });
  }

  try {
    const jobId = await createOrderPunchJob({ createdBy: session.email, rows: validRows });

    // The job row and its rows are committed at this point, so a dropped invoke must not read
    // as a blanket 500 (nothing would explain the rows that DO exist). Instead the job is
    // marked failed with the real reason, which the browser's own status poll then renders -
    // otherwise it sits at 'queued' forever looking healthy, which is exactly how a
    // not-yet-deployed worker Lambda presented itself on 2026-08-21.
    const invoked = await triggerLambda(ORDER_PUNCH_WORKER_LAMBDA, { jobId });
    if (!invoked) {
      const queueError = `Could not start the background worker (${ORDER_PUNCH_WORKER_LAMBDA}) - `
        + 'it may not be deployed, or this API\'s role may lack lambda:InvokeFunction on it. '
        + 'The orders were saved but nothing will process them until that is fixed.';
      console.error(`api/order-punch/start: invoke of ${ORDER_PUNCH_WORKER_LAMBDA} was not accepted for job ${jobId}`);
      // Best-effort: if even this write fails, the response below still tells the caller.
      try {
        await failOrderPunchJob(jobId, queueError);
      } catch (markErr) {
        console.error('api/order-punch/start: could not mark job failed:', markErr);
      }
      return res.status(200).json({ jobId, queued: validRows.length, errors, queueError });
    }

    return res.status(200).json({ jobId, queued: validRows.length, errors });
  } catch (e) {
    console.error('api/order-punch/start error:', e);
    return res.status(500).json({ error: e.message || 'Could not queue this batch' });
  }
};
