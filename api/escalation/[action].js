// The Escalation desk's API surface - ported back in from Escalations/ (the standalone app's
// own pages/api/* routes), folded into one dynamic-segment handler matching this repo's own
// api/auth/[action].js and api/admin/[action].js convention (and keeping api/_lambda/app.js to a
// single mount), same shape the previous Postgres-backed version of this file used.
//
// Actions: agents | orders | assign | tag | update | bulk-update | import | export | sample
//
// Data source is the live Google Sheet the standalone app read/wrote directly (see
// api/_lib/escalationSheet.js) rather than Postgres - row identity here is a "tab:rowNumber"
// key (two tabs, HYPHEN and mCaffeine, share one row-number space), not a parentOrder key. Every
// route sits behind the same session/permission gate
// api/ndr/sheet.js uses for its own proxy: a valid session, the 'calling' card, and - when
// tab-level restrictions are set on the account - the 'escalation' tab.
const { getSession } = require('../_lib/session');
const { parseCSV, toCSV } = require('../_lib/csv');
const { getCallingProcessAgents } = require('../_lib/db');
const {
  getEligibleOrders, updateOrder, batchUpdateOrders, getSheetIndex,
  getAssignments, assignOrder, unassignOrder, setTags, getOrdersForExport,
} = require('../_lib/escalationSheet');

const CARD_KEY = 'calling';
const TAB_KEY = 'escalation';
const PROCESS_KEY = 'escalation';

// The only tag keys that can be stored - mirrors TAGS in app/escalation/EscalationClient.js.
// Validated here rather than trusting the client: `tags` is written straight into the sheet and
// read back onto every row, so an unrecognized key would persist forever and render as nothing.
const VALID_TAGS = ['sos', 'social', 'ceo'];

// Only statuses that need NO replacement order/AWB can be bulk-applied - anything else has to be
// filled in per row, where the form can require the new order id/AWB.
const BULK_ALLOWED = ['Delivered'];

// Canonical header for the bulk template / round-trip - the file format agents already have
// saved spreadsheets against.
const CSV_HEADERS = [
  'HYP_Parent_OrderID', 'AWB_Number', 'Status_1',
  'New Order ID', 'New AWB / Tracking', 'Status_2', 'Notes',
];

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Escalation.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Escalation.';
  return null;
}

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
      const orders = await getEligibleOrders();
      return res.status(200).json({ orders });
    }

    if (action === 'assign') {
      if (req.method === 'GET') {
        return res.status(200).json({ assignments: await getAssignments() });
      }
      if (req.method === 'POST') {
        const { rowNumber, agentId } = body;
        if (!rowNumber) return res.status(400).json({ error: 'rowNumber is required' });
        if (!agentId) await unassignOrder(rowNumber);
        else await assignOrder(rowNumber, agentId);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'tag') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumber, tags } = body; // tags = the row's FULL tag set after the toggle
      if (!rowNumber) return res.status(400).json({ error: 'rowNumber is required' });
      if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags array is required' });
      const clean = [...new Set(tags.filter((t) => VALID_TAGS.includes(t)))];
      await setTags(rowNumber, clean);
      return res.status(200).json({ ok: true, tags: clean });
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumber, newOrderId, newAwb, newStatus, notes } = body;
      if (!rowNumber || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'rowNumber, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(rowNumber, { newOrderId, newAwb, newStatus, notes: notes || '' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'bulk-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumbers, status } = body;
      if (!Array.isArray(rowNumbers) || !rowNumbers.length) {
        return res.status(400).json({ error: 'rowNumbers array is required' });
      }
      if (!status) return res.status(400).json({ error: 'status is required' });
      if (!BULK_ALLOWED.includes(status)) {
        return res.status(400).json({
          error: `Bulk update only supports statuses that need no replacement: ${BULK_ALLOWED.join(', ')}`,
        });
      }
      const updated = await batchUpdateOrders(
        rowNumbers.map((rowNumber) => ({ rowNumber, newOrderId: '-', newAwb: '-', newStatus: status }))
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
      const { byParent, byParentAwb } = await getSheetIndex();
      const updates = [];
      const errors = [];
      const seenRows = new Set();

      rows.forEach((row, i) => {
        const line = i + 2; // account for the header line
        const parent = norm(row.HYP_Parent_OrderID);
        const awb = norm(row.AWB_Number);
        const status = String(row.Status_2 ?? '').trim();

        if (!parent) return errors.push({ line, reason: 'Missing HYP_Parent_OrderID' });
        if (!status) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Missing Status_2 (nothing to write)' });

        let rowNumber = awb ? byParentAwb.get(`${parent}||${awb}`) : undefined;
        if (rowNumber == null) rowNumber = byParent.get(parent);

        if (rowNumber == null) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'No matching order in sheet' });
        if (seenRows.has(rowNumber)) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Duplicate row in file (skipped)' });
        seenRows.add(rowNumber);

        updates.push({
          rowNumber,
          newOrderId: String(row['New Order ID'] ?? '').trim() || '-',
          newAwb: String(row['New AWB / Tracking'] ?? '').trim() || '-',
          newStatus: status,
          notes: String(row.Notes ?? '').trim(),
        });
      });

      let updated = 0;
      if (updates.length) updated = await batchUpdateOrders(updates);

      return res.status(200).json({
        ok: true,
        updated,
        skipped: errors.length,
        total: rows.length,
        rowNumbers: updates.map((u) => u.rowNumber),
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
        : (await getOrdersForExport()).map((o) => ({
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
