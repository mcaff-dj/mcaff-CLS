// The Escalation desk's API surface - the standalone app's eight pages/api/* routes folded into
// one dynamic-segment handler, matching this repo's own api/auth/[action].js and
// api/admin/[action].js convention (and keeping api/_lambda/app.js to a single mount).
//
// Actions: agents | orders | assign | update | bulk-update | import | export | sample
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
const { updateOrder, batchUpdateOrders } = require('../_lib/escalationSheet');
const { getEligibleOrders, getFreshLeads } = require('../_lib/escalationBq');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const {
  getCallingProcessAgents, assignEscalationOrder, unassignEscalationOrder,
  resolveEscalationAssignment, getEscalationAssignments,
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk,
} = require('../_lib/db');

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
        const { rowNumber, parentOrder, agentId } = body;
        if (!rowNumber || !parentOrder) return res.status(400).json({ error: 'rowNumber and parentOrder are required' });
        if (!agentId) await unassignEscalationOrder(parentOrder);
        else await assignEscalationOrder(parentOrder, agentId);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'assignments') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return res.status(200).json({ assignments: await getEscalationAssignments() });
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumber, sheetTab, parentOrder, newOrderId, newAwb, newStatus, notes } = body;
      if (!rowNumber || !sheetTab || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'rowNumber, sheetTab, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(rowNumber, sheetTab, { newOrderId, newAwb, newStatus, notes: notes || '' });
      if (parentOrder) await resolveEscalationAssignment(parentOrder, newStatus, notes || '');
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
      if (items.some((i) => !i.sheetTab)) {
        return res.status(400).json({ error: 'Every item requires sheetTab' });
      }
      const updated = await batchUpdateOrders(
        items.map(({ rowNumber, sheetTab }) => ({ rowNumber, sheetTab, newOrderId: '-', newAwb: '-', newStatus: status }))
      );
      await resolveEscalationAssignmentsBulk(items.map((i) => i.parentOrder).filter(Boolean), status);
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
      const { byParent, byParentAwb } = await getSheetIndex();
      const updates = [];
      const errors = [];
      const seenRows = new Set(); // keyed "sheetTab:rowNumber" - a bare rowNumber can collide across tabs

      rows.forEach((row, i) => {
        const line = i + 2; // account for the header line
        const parent = norm(row.HYP_Parent_OrderID);
        const awb = norm(row.AWB_Number);
        const status = String(row.Status_2 ?? '').trim();

        if (!parent) return errors.push({ line, reason: 'Missing HYP_Parent_OrderID' });
        if (!status) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Missing Status_2 (nothing to write)' });

        // Prefer an exact parent+AWB match, fall back to parent only. Both indexes are searched
        // across every configured tab already (getSheetIndex), so this finds a row regardless of
        // which brand tab it actually lives in.
        const ref = (awb && byParentAwb.get(`${parent}||${awb}`)) || byParent.get(parent);

        if (ref == null) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'No matching order in sheet' });
        const seenKey = `${ref.sheetTab}:${ref.rowNumber}`;
        if (seenRows.has(seenKey)) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Duplicate row in file (skipped)' });
        seenRows.add(seenKey);

        updates.push({
          rowNumber: ref.rowNumber,
          sheetTab: ref.sheetTab,
          newOrderId: String(row['New Order ID'] ?? '').trim() || '-',
          newAwb: String(row['New AWB / Tracking'] ?? '').trim() || '-',
          newStatus: status,
          notes: String(row.Notes ?? '').trim(),
        });
      });

      const updated = updates.length ? await batchUpdateOrders(updates) : 0;
      return res.status(200).json({
        ok: true,
        updated,
        skipped: errors.length,
        total: rows.length,
        // "sheetTab:rowNumber" composite - the client matches these against the same composite
        // it builds from each row's own sheetTab+rowNumber (rowNumber alone isn't unique
        // across tabs).
        rowNumbers: updates.map((u) => `${u.sheetTab}:${u.rowNumber}`),
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
