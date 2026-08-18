// The only way the browser reaches MySQL PEP_CLS.Delivery_escalation (see
// scripts/create_delivery_escalation_table.py and api/_lib/db.js's
// disposeDeliveryEscalationTicket) - same permission gate as api/delivery-escalation/sheet.js.
// Called once, from DeliveryEscalationClient.js's saveAction, only when a ticket is disposed
// with a TERMINAL outcome (Delivered or RTO) - not on claim, and not for a non-terminal outcome
// like Escalated, which stays sheet-only. This table is a parallel write alongside the Google
// Sheet, not a replacement: the sheet stays what the UI actually reads from; this is the
// durable/queryable history side, same role MySQL's CLS_RTO_calling plays for RTO. No GET:
// nothing in the UI reads this table back yet.
const { getSession } = require('../_lib/session');
const { disposeDeliveryEscalationTicket } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'deliveryescalation';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Delivery-Escalation.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Delivery-Escalation.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const { ticket, outcome, agentRemarks } = req.body || {};
  if (!ticket || !ticket.brand || !ticket.orderId) {
    res.status(400).json({ error: 'ticket.brand and ticket.orderId are required' });
    return;
  }

  try {
    await disposeDeliveryEscalationTicket(ticket, session.email, outcome, agentRemarks);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('api/delivery-escalation/record error:', e);
    res.status(500).json({ error: e.message || 'Could not record Delivery-Escalation ticket' });
  }
};
