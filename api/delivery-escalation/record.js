// The only way the browser reaches MySQL PEP_CLS.Delivery_escalation - same permission gate as
// api/delivery-escalation/sheet.js. This table is what BOTH the Fresh and Resolved tabs read
// from, not the sheet.
//
// GET serves three shapes, all paged/filtered/scoped in SQL (see db.js's own header comment on
// why - Lambda's 6MB response cap, and not leaking other agents' rows to a non-admin):
//   ?view=fresh|resolved&page&perPage&search&brand&agent -> { rows, total, page, perPage }
//   ?op=stats                                            -> { stats, agents }
//   ?op=export&view=...(+ same filters)                  -> { rows, capped }
//
// POST action 'claim'/'dispose' is the Fresh tab's own claim/resolve, and 'bulkDispose' its CSV
// upload - all MySQL-only, no sheet write, same model as CLS_RTO_calling's own claim/dispose.
// Any other POST body falls through to the older ticket-snapshot dispose
// (disposeDeliveryEscalationTicket), kept as a fallback though the client no longer calls it.
//
// scopeFor() is the security boundary: a non-admin is pinned to their own agent_email in SQL,
// and the request can NOT override it - `agent` from the query string is only honoured for an
// admin, who is allowed to filter by anyone.
const { getSession } = require('../_lib/session');
const {
  disposeDeliveryEscalationTicket,
  getDeliveryEscalationPage, getDeliveryEscalationStats, getDeliveryEscalationAgents,
  getDeliveryEscalationExport, DELIVERY_ESCALATION_MAX_EXPORT,
  claimDeliveryEscalationTicketById, disposeDeliveryEscalationTicketById,
  bulkDisposeDeliveryEscalationByAwb,
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
    const q = req.query || {};
    // A non-admin is pinned to their own tickets in SQL; only an admin may filter by agent.
    const scopeEmail = session.isAdmin ? '' : session.email;
    const view = q.view || 'fresh';
    if (view !== 'fresh' && view !== 'resolved' && view !== 'forced_rto') {
      // A bad query param is the caller's error, not a server fault - answering 500 here would
      // look identical to a real outage.
      res.status(400).json({ error: `Unknown view: ${view}` });
      return;
    }
    const filters = {
      search: q.search || '',
      brand: q.brand && q.brand !== 'ALL' ? q.brand : '',
      agent: session.isAdmin && q.agent && q.agent !== 'ALL' ? q.agent : '',
      scopeEmail,
    };
    try {
      if (q.op === 'stats') {
        // Agents populate the admin-only filter, so there's nothing to fetch for a non-admin.
        const [stats, agents] = await Promise.all([
          getDeliveryEscalationStats({ scopeEmail }),
          session.isAdmin ? getDeliveryEscalationAgents() : Promise.resolve([]),
        ]);
        res.status(200).json({ stats, agents });
        return;
      }

      if (q.op === 'export') {
        const rows = await getDeliveryEscalationExport(view, filters);
        // capped tells the client the export hit the ceiling, so a partial file can say so
        // rather than looking like the complete set.
        res.status(200).json({ rows, capped: rows.length >= DELIVERY_ESCALATION_MAX_EXPORT });
        return;
      }

      const result = await getDeliveryEscalationPage(view, {
        ...filters, page: q.page, perPage: q.perPage,
      });
      res.status(200).json(result);
    } catch (e) {
      console.error('api/delivery-escalation/record GET error:', e);
      res.status(500).json({ error: e.message || 'Could not load Delivery-Escalation tickets' });
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
