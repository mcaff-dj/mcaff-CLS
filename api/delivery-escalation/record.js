// The only way the browser (or an external caller) reaches MySQL PEP_CLS.Delivery_escalation.
// This table is what BOTH the Fresh and Resolved tabs read from, not the sheet.
//
// NO AUTH: unlike the rest of this app, this endpoint does NOT require the pkyc_session cookie
// or check report_tab_permissions - it's deliberately open so an external system can call it
// directly (e.g. Postman, a script) with no login flow. A caller MAY still send the cookie (the
// in-app UI does) and its session.email is used for attribution if present; a caller with no
// cookie must instead pass `agent` (an email string) in the POST body for any action that writes
// agent_email - see callerEmail below.
//
// GET serves three shapes, all paged/filtered in SQL (see db.js's own header comment on
// why - Lambda's 6MB response cap):
//   ?view=fresh|resolved&page&perPage&search&brand&agent&date&contactBucket -> { rows, total, page, perPage }
//   ?op=stats                                            -> { stats, agents }
//   ?op=export&view=...(+ same filters)                  -> { rows, capped }
//   ?op=awbHistory&awb&brand                             -> { rows } (every ticket for that parcel)
//   ?op=geoCategory&month&level=state|city|pincode(&state)(&city)(&brand)(&agent)(&partner)(&paymentMode)
//                                                       -> { categories, rows, grandTotal, grandTotalAll, grandSales, grandComplaintPct }
//
// POST action 'claim'/'dispose' is the Fresh tab's own claim/resolve, and 'bulkDispose' its CSV
// upload - all MySQL-only, no sheet write, same model as CLS_RTO_calling's own claim/dispose.
// 'setTags' { id, tags: [...] } sets a ticket's Escalation Tags (DE_ESCALATION_TAGS) - applies
// to every ticket sharing that ticket's own AWB, see setDeliveryEscalationTicketTags's own
// comment for why that's automatic rather than a separate cascade step. Any other POST body
// falls through to the older ticket-snapshot dispose (disposeDeliveryEscalationTicket), kept as
// a fallback though the client no longer calls it.
//
// There is deliberately no per-agent row scoping: this is one shared desk whose tickets are
// self-claimed from a common unassigned pool, so hiding unclaimed rows from one caller left a
// newly-invited agent with an empty page and nothing to claim. The GET `agent` param is a plain
// filter anyone may use to narrow the view to one person (usually themselves).
//
// There IS per-user row scoping by Delivery Partner, though - an admin-configured allowlist
// (see getDeliveryPartnerAccess/allowedPartners below), separate from and on top of the
// deliveryescalation tab grant itself. Unrestricted by default (empty allowlist = every
// partner), and only ever applies to a cookie-carrying caller - the no-auth path above has no
// user to look one up for, same as it skips every other permission check.
const { getSession } = require('../_lib/session');
const {
  disposeDeliveryEscalationTicket,
  getDeliveryEscalationPage, getDeliveryEscalationStats, getDeliveryEscalationAgents,
  getDeliveryEscalationExport, DELIVERY_ESCALATION_MAX_EXPORT, getDeliveryEscalationRepeatStats,
  getDeliveryEscalationDaywiseStats, getDeliveryEscalationAwbHistory,
  getDeliveryEscalationGeoCategoryStats, getDeliveryPartnerAccess,
  getDeliveryEscalationQueryCategoryAccess,
  claimDeliveryEscalationTicketById, disposeDeliveryEscalationTicketById,
  bulkDisposeDeliveryEscalationByAwb,
  DE_ESCALATION_TAGS, setDeliveryEscalationTicketTags,
} = require('../_lib/db');

// Backstop against a request that can never finish, not an arbitrary business limit:
// bulkDisposeDeliveryEscalationByAwb now runs 8 row-updates at a time (see its own comment)
// rather than one at a time, but the whole request still has to finish inside API Gateway's
// hard ~29s integration ceiling - a platform limit no Lambda/pool config can raise. 10,000 rows
// is a wide safety margin under that ceiling at the per-row latency this table has shown so
// far; if a real upload legitimately needs more than this, the fix is a background-job
// pattern (see api/rto/upload-start.js's own for exactly that reason), not a bigger number here.
const MAX_BULK_ROWS = 10000;

module.exports = async (req, res) => {
  // Best-effort only - never blocks the request. Just lets a cookie-carrying browser call skip
  // passing `agent` explicitly (see callerEmail below); getSession() itself never throws for a
  // missing/invalid cookie, it just resolves null.
  const session = await getSession(req).catch(() => null);
  // Delivery Partner allowlist (see getDeliveryPartnerAccess) - empty for a no-cookie caller
  // (there's no user to look one up for) or a cookie-carrying user with no restriction
  // configured, both of which mean unrestricted, same convention the DB layer already uses.
  // Threaded through every read below so it enforces everywhere at once, not just the ticket
  // list - stats tiles, export, day-wise table, geo table, AWB history all narrow the same way.
  const allowedPartners = session ? await getDeliveryPartnerAccess(session.uid) : [];
  // Query Category allowlist (see getDeliveryEscalationQueryCategoryAccess) - same convention
  // and same "thread through every read" reasoning as allowedPartners just above.
  const allowedQueryCategories = session ? await getDeliveryEscalationQueryCategoryAccess(session.uid) : [];

  if (req.method === 'GET') {
    const q = req.query || {};
    const view = q.view || 'fresh';
    if (view !== 'fresh' && view !== 'resolved' && view !== 'forced_rto' && view !== 'new_order_placed') {
      // A bad query param is the caller's error, not a server fault - answering 500 here would
      // look identical to a real outage.
      res.status(400).json({ error: `Unknown view: ${view}` });
      return;
    }
    // Tab Access (see api/admin/[action].js's own DE_TAB_CARD_KEY comment) - restricts which of
    // THIS PAGE'S OWN tabs an agent may open, on top of the deliveryescalation card grant itself.
    // Only gates the ticket-list reads below (this `view`, and its own op=export) - op=stats/
    // daywise/geoCategory/awbHistory describe the whole desk regardless of which tab is
    // currently open, so they're deliberately left unrestricted here. Same "no rows/empty =
    // unrestricted" convention as allowedPartners/allowedQueryCategories above.
    const allowedTabs = session?.tabPerms?.['deliveryescalation-tabs'];
    if (Array.isArray(allowedTabs) && allowedTabs.length && !allowedTabs.includes(view)
        && (q.op === undefined || q.op === 'export')) {
      res.status(403).json({ error: `You do not have access to the ${view} tab` });
      return;
    }
    const filters = {
      search: q.search || '',
      brand: q.brand && q.brand !== 'ALL' ? q.brand : '',
      agent: q.agent && q.agent !== 'ALL' ? q.agent : '',
      date: q.date || '',
      dateTo: q.dateTo || '',
      dateField: q.dateField || '',
      tatBucket: q.tatBucket || '',
      contactBucket: q.contactBucket && q.contactBucket !== 'ALL' ? q.contactBucket : '',
      // The ticket list's own Delivery Partner filter, comma-joined raw values (client already
      // resolved canonical -> raw - see DeliveryEscalationClient.js's filterQuery). Distinct from
      // allowedPartners: this is a user-chosen filter, that's the always-enforced access floor.
      partner: q.partner ? String(q.partner).split(',').filter(Boolean) : undefined,
      // The ticket list's own Outcome filter (see deFilterSql's own outcomeRoot comment) - a
      // plain bound parameter, so an unrecognized value just matches zero rows rather than
      // needing server-side whitelisting the way a WRITE (e.g. setTags) does.
      outcomeRoot: q.outcome && q.outcome !== 'ALL' ? q.outcome : '',
      allowedPartners,
      allowedQueryCategories,
    };
    try {
      if (q.op === 'stats') {
        // Tiles describe the whole desk (whole = everything THIS caller may see); agents
        // populates the Agent filter, which everyone with access now has (it is the only way to
        // get back the old "just my tickets" view).
        const [stats, agents, repeatStats] = await Promise.all([
          getDeliveryEscalationStats({ allowedPartners, allowedQueryCategories }),
          getDeliveryEscalationAgents(),
          getDeliveryEscalationRepeatStats(allowedPartners, allowedQueryCategories),
        ]);
        res.status(200).json({ stats, agents, repeatStats });
        return;
      }

      if (q.op === 'awbHistory') {
        // Powers the ticket list's expand-to-timeline (see DeliveryEscalationClient.js) -
        // every ticket ever raised for this parcel, spanning all three views, not just the one
        // the client is currently looking at.
        if (!q.awb || !q.brand) {
          res.status(400).json({ error: 'awb and brand are required' });
          return;
        }
        const history = await getDeliveryEscalationAwbHistory(q.awb, q.brand, allowedPartners, allowedQueryCategories);
        res.status(200).json({ rows: history });
        return;
      }

      if (q.op === 'daywise') {
        // Overview's day-wise TAT table - respects the page's current brand/agent filters
        // (unlike op=stats, which is deliberately whole-desk); view is irrelevant here since it
        // spans Fresh+Resolved+Forced RTO in one table. partner arrives as a comma-joined list
        // of raw delivery_partner values (the client already resolved its own canonical-name
        // filter down to that list - see PARTNER_NAME_MAP in DeliveryEscalationClient.js).
        // dateFrom/dateTo are this table's OWN date-range filter, independent of the ticket
        // list's own `date`/`dateTo` (q.date/q.dateTo) - the day-wise table has no `view`, so it
        // can't share deWhere/deFilterSql, hence separate query params.
        const daywise = await getDeliveryEscalationDaywiseStats({
          brand: filters.brand, agent: filters.agent, dateField: q.dateField,
          partner: q.partner ? String(q.partner).split(',').filter(Boolean) : undefined,
          paymentMode: q.paymentMode && q.paymentMode !== 'ALL' ? q.paymentMode : '',
          dateFrom: q.dateFrom || '', dateTo: q.dateTo || '',
          allowedPartners,
          allowedQueryCategories,
        });
        res.status(200).json(daywise);
        return;
      }

      if (q.op === 'geoCategory') {
        // Overview's standalone State/City/Pincode x Query Category table - one level per
        // request (see getDeliveryEscalationGeoCategoryStats's own comment on why), the client
        // walks deeper only as each column is actually expanded.
        const level = ['state', 'city', 'pincode'].includes(q.level) ? q.level : 'state';
        if (!q.month) { res.status(400).json({ error: 'month is required' }); return; }
        if (level === 'city' && !q.state) { res.status(400).json({ error: 'state is required' }); return; }
        if (level === 'pincode' && (!q.state || !q.city)) {
          res.status(400).json({ error: 'state and city are required' });
          return;
        }
        const geo = await getDeliveryEscalationGeoCategoryStats({
          brand: filters.brand, month: q.month, level, state: q.state, city: q.city,
          agent: filters.agent, partner: filters.partner,
          paymentMode: q.paymentMode && q.paymentMode !== 'ALL' ? q.paymentMode : '',
          allowedPartners, allowedQueryCategories,
        });
        res.status(200).json(geo);
        return;
      }

      if (q.op === 'export') {
        // One chunk (see getDeliveryEscalationExport) - q.page walks through the full matching
        // set across multiple requests, so no total row count is capped here. hasMore tells the
        // client whether to request the next page rather than stop.
        const rows = await getDeliveryEscalationExport(view, { ...filters, page: q.page });
        res.status(200).json({ rows, hasMore: rows.length >= DELIVERY_ESCALATION_MAX_EXPORT });
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

  const { action, id, ticket, outcome, agentRemarks, newOrderAwb, oldAwb } = req.body || {};
  // No-auth caller passes `agent` (an email) in the body for attribution; a cookie-carrying
  // browser call falls back to its session email so the existing UI needs no change.
  const callerEmail = (req.body?.agent && String(req.body.agent).trim()) || session?.email || '';

  // Fresh AND Forced RTO tabs' bulk outcome upload (CSV: AWB, Outcome, optional Remarks), AND
  // the New Order Placed tab's own bulk fill-in (CSV: AWB, New Order AWB, optional Outcome +
  // Remarks) - see db.js's bulkDisposeDeliveryEscalationByAwb. rows is pre-parsed client-side;
  // this only validates shape/size, not outcome values (a bulk upload's Outcome text is trusted
  // the same way a single dispose's dispPath.join(' > ') already is - no disposition-tree
  // validation there either). view defaults to 'fresh' for a stale client bundle mid-deploy that
  // doesn't send one yet; bulkDisposeDeliveryEscalationByAwb itself rejects anything else.
  //
  // New Order Placed's Outcome is OPTIONAL per row (blank = just fill new_order_AWB, current
  // behavior) - but when given, New Order AWB is required anyway by the very next filter below
  // (unconditional for this view), which is exactly the "mandatory New Order AWB when marking
  // Delivered/RTO" rule the tab's own single-dispose modal enforces - satisfied here for free.
  if (action === 'bulkDispose') {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const view = req.body?.view === 'forced_rto' ? 'forced_rto'
      : req.body?.view === 'new_order_placed' ? 'new_order_placed' : 'fresh';
    if (!rows.length) {
      res.status(400).json({ error: 'rows is required' });
      return;
    }
    if (rows.length > MAX_BULK_ROWS) {
      res.status(400).json({ error: `Too many rows (${rows.length}) - split into batches of ${MAX_BULK_ROWS} or fewer.` });
      return;
    }
    const clean = view === 'new_order_placed'
      ? rows
        .map((r) => ({
          awb: String(r.awb || '').trim(),
          newOrderAwb: String(r.newOrderAwb || '').trim(),
          outcome: r.outcome ? String(r.outcome).trim() : '',
          remarks: r.remarks ? String(r.remarks).trim() : '',
        }))
        .filter((r) => r.awb && r.newOrderAwb)
      : rows
        .map((r) => ({ awb: String(r.awb || '').trim(), outcome: String(r.outcome || '').trim(), remarks: r.remarks ? String(r.remarks).trim() : '' }))
        .filter((r) => r.awb && r.outcome);
    if (!clean.length) {
      res.status(400).json({
        error: view === 'new_order_placed'
          ? 'No valid rows (each needs an AWB and a New Order AWB).'
          : 'No valid rows (each needs an AWB and an Outcome).',
      });
      return;
    }
    // new_order_placed's own UPDATE only touches agent_email when a row also carries an Outcome
    // (it's then a real disposal, same as fresh/forced_rto) - a plain AWB-fill-in row needs no
    // attribution at all.
    const needsCallerEmail = view !== 'new_order_placed' || clean.some((r) => r.outcome);
    if (needsCallerEmail && !callerEmail) {
      res.status(400).json({ error: 'agent (an email) is required' });
      return;
    }
    try {
      const results = await bulkDisposeDeliveryEscalationByAwb(clean, callerEmail, view);
      res.status(200).json({ results });
    } catch (e) {
      console.error('api/delivery-escalation/record bulkDispose error:', e);
      res.status(500).json({ error: e.message || 'Bulk upload failed' });
    }
    return;
  }

  // Escalation Tags column, any list-tab - see setDeliveryEscalationTicketTags's own comment for
  // why this one call already covers every ticket sharing this ticket's AWB. Whitelisted against
  // DE_ESCALATION_TAGS server-side (not just trusted from the client's own fixed dropdown
  // options), same posture claim/dispose already take toward every other write on this endpoint.
  if (action === 'setTags') {
    if (!id) { res.status(400).json({ error: 'id is required' }); return; }
    if (!callerEmail) { res.status(400).json({ error: 'agent (an email) is required' }); return; }
    const tags = Array.isArray(req.body?.tags)
      ? [...new Set(req.body.tags.filter((t) => DE_ESCALATION_TAGS.includes(t)))] : [];
    try {
      const saved = await setDeliveryEscalationTicketTags(id, tags, callerEmail);
      res.status(200).json({ ok: true, tags: saved });
    } catch (e) {
      console.error('api/delivery-escalation/record setTags error:', e);
      res.status(400).json({ error: e.message || 'Could not save tags' });
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
    if (!callerEmail) {
      res.status(400).json({ error: 'agent (an email) is required' });
      return;
    }
    try {
      if (action === 'claim') {
        await claimDeliveryEscalationTicketById(id, callerEmail);
      } else {
        // newOrderAwb/oldAwb: both mandates (Delivered/RTO from New Order Placed; disposing a
        // ticket with no AWB on file at all) are enforced inside
        // disposeDeliveryEscalationTicketById itself (it needs the ticket's pre-update outcome/
        // awb_code/order_id to know whether either rule even applies here) - it throws a plain
        // Error for either case, which the isValidation check below turns into a 400 instead of
        // a 500.
        await disposeDeliveryEscalationTicketById(
          id, callerEmail, outcome, agentRemarks,
          newOrderAwb ? String(newOrderAwb).trim() : '',
          oldAwb ? String(oldAwb).trim() : '');
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error(`api/delivery-escalation/record ${action} error:`, e);
      const isValidation = /New Order AWB is required|AWB number is required/.test(e.message || '');
      res.status(isValidation ? 400 : 500).json({ error: e.message || `Could not ${action} Delivery-Escalation ticket` });
    }
    return;
  }

  if (!ticket || !ticket.brand || !ticket.orderId) {
    res.status(400).json({ error: 'ticket.brand and ticket.orderId are required' });
    return;
  }
  if (!callerEmail) {
    res.status(400).json({ error: 'agent (an email) is required' });
    return;
  }

  try {
    await disposeDeliveryEscalationTicket(ticket, callerEmail, outcome, agentRemarks);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('api/delivery-escalation/record error:', e);
    res.status(500).json({ error: e.message || 'Could not record Delivery-Escalation ticket' });
  }
};
