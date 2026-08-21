// POST /api/order-punch/start - admin-only. Queues a batch of orders for repunch via the
// background Lambda worker (mcaff-cls-order-punch-worker) - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md. Accepts the same {doc, reason,
// facility_code}[] shape whether the browser built it from a parsed CSV or the manual
// multi-row form; this endpoint only validates and queues, it never talks to Unicommerce
// itself (that's the worker's job, entirely in Python - see
// scripts/process_order_punch_job.py).
const { getSession } = require('../_lib/session');
const { validateRows } = require('../_lib/orderPunchRows');
const { createOrderPunchJob } = require('../_lib/db');
const { triggerLambda } = require('../_lib/lambdaTrigger');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const ORDER_PUNCH_WORKER_LAMBDA = 'mcaff-cls-order-punch-worker';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can run Order Punch.';
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
    await triggerLambda(ORDER_PUNCH_WORKER_LAMBDA, { jobId });
    return res.status(200).json({ jobId, queued: validRows.length, errors });
  } catch (e) {
    console.error('api/order-punch/start error:', e);
    return res.status(500).json({ error: e.message || 'Could not queue this batch' });
  }
};
