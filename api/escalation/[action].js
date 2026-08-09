// The Escalation desk's API surface - the standalone app's eight pages/api/* routes folded into
// one dynamic-segment handler, matching this repo's own api/auth/[action].js and
// api/admin/[action].js convention (and keeping api/_lambda/app.js to a single mount).
//
// Actions: agents | orders | assign | assign-bulk | assignments | update | bulk-update | import |
// export | sample
//
// STORE: BigQuery, exclusively. All reads and writes here go through api/_lib/escalationBq.js.
// Ingest (MySQL -> BigQuery, sheet -> BigQuery) lives entirely in scripts/ and runs outside this
// API - see scripts/sync_delivery_tickets_to_bq.py and scripts/sync_escalation_sheet_to_bq.py.
// Nothing in this file reads or writes the Google Sheet.
//
// SECURITY - the substantive change from the standalone app. That app was a private,
// separately-deployed tool with NO auth on any route: /api/orders returned the whole RTO queue
// and /api/orders/update wrote to the live sheet for anyone who could reach the URL. Inside this
// app the same endpoints sit on an internet-facing domain shared with every other report, so
// each one is gated the same way api/ndr/sheet.js gates its own proxy: a valid session, the
// 'calling' card, and - when tab-level restrictions are set on the account - the 'escalation'
// tab. Access is enforced here rather than in the browser, so the client is free to render
// whatever it likes without that being a permission decision.
const { getSession } = require('../_lib/session');
const {
  getEligibleOrders, getFreshLeads, updateOrder, batchUpdateOrders, getOrderIndex,
  assignEscalationOrder, unassignEscalationOrder, assignEscalationOrdersBulk,
  getEscalationAssignments, getLiveEscalationAssignments,
} = require('../_lib/escalationBq');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const { getCallingProcessAgents } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'escalation';
const PROCESS_KEY = 'escalation';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Escalation.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Escalation.';
  return null;
}

// Only statuses that need NO replacement order/AWB can be bulk-applied - anything else has to be
// filled in per row, where the form can require the new order id/AWB.
const BULK_ALLOWED = ['Delivered'];

const handler = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const action = (req.query && req.query.action) || '';
  const body = req.body || {};

  try {
    if (action === 'agents') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return res.status(200).json({ agents: await getCallingProcessAgents(PROCESS_KEY) });
    }

    if (action === 'orders') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const orders = req.query.type === 'fresh-leads' ? await getFreshLeads() : await getEligibleOrders();
      return res.status(200).json({ orders });
    }

    if (action === 'assign') {
      if (req.method === 'GET') {
        const live = await getLiveEscalationAssignments();
        const assignments = {};
        live.forEach((r) => { assignments[r.parentOrder] = { agentId: r.email }; });
        return res.status(200).json({ assignments });
      }
      if (req.method === 'POST') {
        const { sheetTab, parentOrder, awbNumber, agentId } = body;
        if (!sheetTab || !parentOrder) return res.status(400).json({ error: 'sheetTab and parentOrder are required' });
        const key = { sheetTab, parentOrder, awbNumber: awbNumber || '' };
        if (!agentId) await unassignEscalationOrder(key);
        else await assignEscalationOrder(key, agentId);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Auto-Assign All's endpoint. One MERGE for the whole selection - the client used to fire one
    // request per order, which against BigQuery is thousands of concurrent DML statements.
    if (action === 'assign-bulk') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { items } = body;
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });
      if (items.some((i) => !i.sheetTab || !i.parentOrder || !i.agentId)) {
        return res.status(400).json({ error: 'Every item requires sheetTab, parentOrder and agentId' });
      }
      return res.status(200).json({ ok: true, assigned: await assignEscalationOrdersBulk(items) });
    }

    if (action === 'assignments') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return res.status(200).json({ assignments: await getEscalationAssignments() });
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { sheetTab, parentOrder, awbNumber, newOrderId, newAwb, newStatus, notes } = body;
      if (!sheetTab || !parentOrder || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'sheetTab, parentOrder, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(
        { sheetTab, parentOrder, awbNumber: awbNumber || '' },
        { newOrderId, newAwb, newStatus, notes: notes || '', resolvedBy: session.email }
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'bulk-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { items, status } = body;
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'items array is required' });
      }
      if (!status) return res.status(400).json({ error: 'status is required' });
      if (!BULK_ALLOWED.includes(status)) {
        return res.status(400).json({
          error: `Bulk update only supports statuses that need no replacement: ${BULK_ALLOWED.join(', ')}`,
        });
      }
      if (items.some((i) => !i.sheetTab || !i.parentOrder)) {
        return res.status(400).json({ error: 'Every item requires sheetTab and parentOrder' });
      }
      const updated = await batchUpdateOrders(
        items.map(({ sheetTab, parentOrder, awbNumber }) => ({
          sheetTab, parentOrder, awbNumber: awbNumber || '',
          newOrderId: '-', newAwb: '-', newStatus: status, notes: '', resolvedBy: session.email,
        }))
      );
      return res.status(200).json({ ok: true, updated });
    }

    if (action === 'import') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { csv } = body;
      if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv text is required' });

      let rows;
      try {
        rows = parseCSV(csv);
      } catch (err) {
        return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
      }
      if (!rows.length) return res.status(400).json({ error: 'No data rows found in the CSV' });

      const norm = (v) => String(v ?? '').trim().toLowerCase();
      const { byParent, byParentAwb } = await getOrderIndex();
      const updates = [];
      const errors = [];
      const seenRows = new Set(); // keyed "sheetTab:parentOrder:awbNumber" - the write key, not a row number

      rows.forEach((row, i) => {
        const line = i + 2; // account for the header line
        const parent = norm(row.HYP_Parent_OrderID);
        const awb = norm(row.AWB_Number);
        const status = String(row.Status_2 ?? '').trim();

        if (!parent) return errors.push({ line, reason: 'Missing HYP_Parent_OrderID' });
        if (!status) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Missing Status_2 (nothing to write)' });

        // Prefer an exact parent+AWB match, fall back to parent only. Both indexes are searched
        // across every configured brand already (getOrderIndex), so this finds a row regardless
        // of which brand it actually lives in.
        const ref = (awb && byParentAwb.get(`${parent}||${awb}`)) || byParent.get(parent);

        if (ref == null) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'No matching order in BigQuery' });
        const seenKey = `${ref.sheetTab}:${ref.parentOrder}:${ref.awbNumber}`;
        if (seenRows.has(seenKey)) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Duplicate row in file (skipped)' });
        seenRows.add(seenKey);

        updates.push({
          sheetTab: ref.sheetTab,
          parentOrder: ref.parentOrder,
          awbNumber: ref.awbNumber,
          newOrderId: String(row['New Order ID'] ?? '').trim() || '-',
          newAwb: String(row['New AWB / Tracking'] ?? '').trim() || '-',
          newStatus: status,
          notes: String(row.Notes ?? '').trim(),
          resolvedBy: session.email,
        });
      });

      const updated = updates.length ? await batchUpdateOrders(updates) : 0;
      return res.status(200).json({
        ok: true,
        updated,
        skipped: errors.length,
        total: rows.length,
        // "sheetTab:parentOrder" composite - the client matches these against the same composite
        // it builds from each row's own sheetTab+parentOrder.
        rowNumbers: updates.map((u) => `${u.sheetTab}:${u.parentOrder}`),
        errors: errors.slice(0, 50), // cap payload
      });
    }

    if (action === 'export' || action === 'sample') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const rows = action === 'sample'
        ? [{
            HYP_Parent_OrderID: 'HYP31900000',
            AWB_Number: 'AWB123456789',
            Status_1: 'RTO',
            'New Order ID': 'HYP31999999',
            'New AWB / Tracking': 'AWB987654321',
            Status_2: 'Reshipped',
            Notes: 'Customer confirmed new address',
          }]
        : (await (req.query.type === 'fresh-leads' ? getFreshLeads() : getEligibleOrders())).map((o) => ({
            HYP_Parent_OrderID: o.parentOrder,
            AWB_Number: o.awbNumber,
            Status_1: o.statusAsPerAwb,
            'New Order ID': '',
            'New AWB / Tracking': '',
            Status_2: '',
            Notes: '',
          }));
      const filename = action === 'sample' ? 'escalation-sample-template.csv' : 'escalation-orders.csv';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(toCSV(rows, CSV_HEADERS));
    }

    return res.status(404).json({ error: 'Unknown escalation route' });
  } catch (e) {
    console.error(`api/escalation/${action} error:`, e);
    return res.status(500).json({ error: e.message || 'Escalation request failed' });
  }
};

module.exports = handler;
// The import action accepts a pasted CSV body, so it needs a bigger cap than the 1mb default.
// Vercel reads this export off the route module; under Lambda the equivalent limit is
// api/_lambda/app.js's own express.json({ limit }), which is set to match.
module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };
