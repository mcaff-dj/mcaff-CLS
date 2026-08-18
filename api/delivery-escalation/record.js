// The only way the browser reaches MySQL PEP_CLS.Delivery_escalation - same permission gate as
// api/delivery-escalation/sheet.js. GET returns both the Resolved tab's rows (outcome =
// Delivered only - see getDeliveryEscalationHistory) and the Fresh tab's rows (outcome blank or
// RTO - see getDeliveryEscalationFresh); this table is what BOTH tabs read from now, not the
// sheet, since a sheet row ages out of the client's own row-count cap while this table keeps
// the full history.
//
// POST action 'claim'/'dispose' is the Fresh tab's own claim/resolve, MySQL-only - no sheet
// write at all, same model as CLS_RTO_calling's own claim/dispose (see
// claimDeliveryEscalationTicketById/disposeDeliveryEscalationTicketById). Any other POST body
// falls through to the older ticket-snapshot dispose (disposeDeliveryEscalationTicket) - kept
// for now as a fallback, though nothing in DeliveryEscalationClient.js calls it any more since
// Fresh moved off the sheet.
const { getSession } = require('../_lib/session');
const {
  disposeDeliveryEscalationTicket, getDeliveryEscalationHistory,
  getDeliveryEscalationFresh, claimDeliveryEscalationTicketById, disposeDeliveryEscalationTicketById,
  bulkDisposeDeliveryEscalationByAwb, DELIVERY_ESCALATION_MAX_ROWS,
} = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'deliveryescalation';
// Backstop against an accidentally-huge upload hammering the 5-connection MySQL pool with
// one UPDATE per row, sequentially, inside a single Lambda invocation - see
// bulkDisposeDeliveryEscalationByAwb's own per-row loop.
const MAX_BULK_ROWS = 2000;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Delivery-Escalation.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Delivery-Escalation.';
  return null;
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  if (req.method === 'GET') {
    try {
      const [rows, freshRows] = await Promise.all([getDeliveryEscalationHistory(), getDeliveryEscalationFresh()]);
      // maxRows lets the client tell "this is everything" apart from "this is the cap" and warn
      // accordingly - both lists are capped to keep this single response under Lambda's 6MB
      // limit (see DELIVERY_ESCALATION_MAX_ROWS), and a silent truncation reads as real data.
      res.status(200).json({ rows, freshRows, maxRows: DELIVERY_ESCALATION_MAX_ROWS });
    } catch (e) {
      console.error('api/delivery-escalation/record GET error:', e);
      res.status(500).json({ error: e.message || 'Could not load Delivery-Escalation history' });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { action, id, ticket, outcome, agentRemarks } = req.body || {};

  // Fresh tab's bulk outcome upload (CSV: AWB, Outcome, optional Remarks) - see db.js's
  // bulkDisposeDeliveryEscalationByAwb. rows is pre-parsed client-side; this only validates
  // shape/size, not outcome values (a bulk upload's Outcome text is trusted the same way a
  // single dispose's dispPath.join(' > ') already is - no disposition-tree validation there
  // either).
  if (action === 'bulkDispose') {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      res.status(400).json({ error: 'rows is required' });
      return;
    }
    if (rows.length > MAX_BULK_ROWS) {
      res.status(400).json({ error: `Too many rows (${rows.length}) - split into batches of ${MAX_BULK_ROWS} or fewer.` });
      return;
    }
    const clean = rows
      .map((r) => ({ awb: String(r.awb || '').trim(), outcome: String(r.outcome || '').trim(), remarks: r.remarks ? String(r.remarks).trim() : '' }))
      .filter((r) => r.awb && r.outcome);
    if (!clean.length) {
      res.status(400).json({ error: 'No valid rows (each needs an AWB and an Outcome).' });
      return;
    }
    try {
      const results = await bulkDisposeDeliveryEscalationByAwb(clean, session.email);
      res.status(200).json({ results });
    } catch (e) {
      console.error('api/delivery-escalation/record bulkDispose error:', e);
      res.status(500).json({ error: e.message || 'Bulk upload failed' });
    }
    return;
  }

  // Fresh tab's claim/dispose, MySQL-only (no sheet write) - see db.js's
  // claimDeliveryEscalationTicketById/disposeDeliveryEscalationTicketById.
  if (action === 'claim' || action === 'dispose') {
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    try {
      if (action === 'claim') {
        await claimDeliveryEscalationTicketById(id, session.email);
      } else {
        await disposeDeliveryEscalationTicketById(id, session.email, outcome, agentRemarks);
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error(`api/delivery-escalation/record ${action} error:`, e);
      res.status(500).json({ error: e.message || `Could not ${action} Delivery-Escalation ticket` });
    }
    return;
  }

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
