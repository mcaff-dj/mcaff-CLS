// The Escalation desk's API surface - the standalone app's eight pages/api/* routes folded into
// one dynamic-segment handler, matching this repo's own api/auth/[action].js and
// api/admin/[action].js convention (and keeping api/_lambda/app.js to a single mount).
//
// Actions: agents | orders | assign | assign-bulk | update | bulk-update | import | export | sample
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
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const {
  getCallingProcessAgents, assignEscalationOrder, unassignEscalationOrder,
  resolveEscalationAssignment, getEscalationAssignments,
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk, setEscalationTags,
  getEligibleOrders, getFreshLeads, getEscalationOrderIndex, getEscalationOrdersForExport,
  getEscalationOrdersFingerprint,
} = require('../_lib/db');

// If-None-Match is a LIST (RFC 9110), and a proxy or the browser may hand back several entries or
// an entry stripped of its W/ prefix - so this compares weakly, per tag, rather than testing the
// raw header for equality. Getting this wrong is only ever a performance bug (a missed 304), never
// a correctness one: a false NEGATIVE just resends the rows. A false positive would serve stale
// data, which is why '*' is not honoured here - nothing issues it against this endpoint, and
// treating it as a match would 304 a client that has no copy at all.
function etagMatches(header, etag) {
  if (!header) return false;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return String(header).split(',').some((t) => strip(t) === strip(etag));
}

// The only tag keys that can be stored - mirrors TAGS in app/escalation/EscalationClient.js.
// Validated here rather than trusting the client: `tags` is written straight into a TEXT[] and
// read back onto every row, so an unrecognized key would persist forever and render as nothing.
const VALID_TAGS = ['sos', 'social', 'ceo'];

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
      // This response is the app's largest Supabase egress item and the desk refetches it on every
      // load, view switch and bulk action - so revalidate before resending. The ETag is a
      // fingerprint of the whole table (getEscalationOrdersFingerprint), and on a match the
      // expensive query never runs at all: the browser replays its own cached copy and Postgres
      // moves ~60 bytes instead of megabytes.
      //
      // `no-cache` means STORE but always revalidate - not "don't cache" (that is `no-store`).
      // `private` keeps any shared proxy from holding one desk's rows. Nothing changes in
      // EscalationClient.js: a plain fetch() of a URL the browser has an ETag for sends
      // If-None-Match on its own and serves the cached body on a 304, so res.json() still sees
      // the full { orders, total }.
      const type = req.query.type === 'fresh-leads' ? 'fresh-leads' : 'queue';
      // Scoped by `type`: the two views hit the same URL path with different query strings and
      // return different row sets, so one shared fingerprint would let a Fresh Leads copy answer
      // an RTO Queue request.
      const etag = `W/"${type}-${await getEscalationOrdersFingerprint()}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end();
      // { orders, total } - total is the true pending count, which can exceed the rows returned
      // (see getEscalationOrders' cap, and why an uncapped response 500s at the Lambda layer).
      const { orders, total } = type === 'fresh-leads' ? await getFreshLeads() : await getEligibleOrders();
      return res.status(200).json({ orders, total });
    }

    if (action === 'assign') {
      if (req.method === 'GET') {
        const live = await getLiveEscalationAssignments();
        const assignments = {};
        live.forEach((r) => { assignments[r.parentOrder] = { agentId: r.email }; });
        return res.status(200).json({ assignments });
      }
      if (req.method === 'POST') {
        const { parentOrder, agentId } = body;
        if (!parentOrder) return res.status(400).json({ error: 'parentOrder is required' });
        if (!agentId) await unassignEscalationOrder(parentOrder);
        else await assignEscalationOrder(parentOrder, agentId);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'assign-bulk') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { assignments } = body; // [{ parentOrder, agentId }]
      if (!Array.isArray(assignments) || !assignments.length) {
        return res.status(400).json({ error: 'assignments array is required' });
      }
      await Promise.all(assignments.map(({ parentOrder, agentId }) =>
        agentId ? assignEscalationOrder(parentOrder, agentId) : unassignEscalationOrder(parentOrder)
      ));
      return res.status(200).json({ ok: true, assigned: assignments.length });
    }

    if (action === 'assignments') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return res.status(200).json({ assignments: await getEscalationAssignments() });
    }

    if (action === 'tag') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { parentOrder, tags } = body; // tags = the order's FULL tag set after the toggle
      if (!parentOrder) return res.status(400).json({ error: 'parentOrder is required' });
      if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags array is required' });
      const clean = [...new Set(tags.filter((t) => VALID_TAGS.includes(t)))];
      await setEscalationTags(parentOrder, clean);
      return res.status(200).json({ ok: true, tags: clean });
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { parentOrder, newOrderId, newAwb, newStatus, notes } = body;
      if (!parentOrder || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'parentOrder, newOrderId, newAwb, and newStatus are all required' });
      }
      // Whoever resolves a lead claims it - resolveEscalationAssignment itself stamps the
      // Google sign-in session email onto `email` on the same row it resolves.
      await resolveEscalationAssignment(parentOrder, newStatus, notes || '', newOrderId, newAwb, session.email);
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
      const parentOrders = items.map((i) => i.parentOrder).filter(Boolean);
      if (!parentOrders.length) return res.status(400).json({ error: 'Every item requires parentOrder' });
      await resolveEscalationAssignmentsBulk(parentOrders, status, session.email);
      return res.status(200).json({ ok: true, updated: parentOrders.length });
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
      const { byParent, byParentAwb } = await getEscalationOrderIndex();
      const updates = [];
      const errors = [];
      const seenOrders = new Set(); // keyed "brand:parentOrder" - one order can carry multiple ticket rows

      rows.forEach((row, i) => {
        const line = i + 2; // account for the header line
        const parent = norm(row.HYP_Parent_OrderID);
        const awb = norm(row.AWB_Number);
        const status = String(row.Status_2 ?? '').trim();

        if (!parent) return errors.push({ line, reason: 'Missing HYP_Parent_OrderID' });
        if (!status) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Missing Status_2 (nothing to write)' });

        // Prefer an exact parent+AWB match, fall back to parent only.
        const ref = (awb && byParentAwb.get(`${parent}||${awb}`)) || byParent.get(parent);

        if (ref == null) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'No matching order found' });
        const seenKey = `${ref.brand}:${parent}`;
        if (seenOrders.has(seenKey)) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Duplicate row in file (skipped)' });
        seenOrders.add(seenKey);

        updates.push({
          brand: ref.brand,
          parentOrder: row.HYP_Parent_OrderID,
          newOrderId: String(row['New Order ID'] ?? '').trim() || '-',
          newAwb: String(row['New AWB / Tracking'] ?? '').trim() || '-',
          newStatus: status,
          notes: String(row.Notes ?? '').trim(),
        });
      });

      // Same claim-on-resolve rule as the 'update'/'bulk-update' actions - a CSV import used to
      // leave email NULL forever (no assignee to fall back on), so every bulk-uploaded row went
      // unattributed in the assignment filter and every agent stat that reads off `email`.
      await Promise.all(updates.map((u) =>
        resolveEscalationAssignment(u.parentOrder, u.newStatus, u.notes, u.newOrderId, u.newAwb, session.email)
      ));
      return res.status(200).json({
        ok: true,
        updated: updates.length,
        skipped: errors.length,
        total: rows.length,
        // "brand:parentOrder" composite - the client matches these against every ticket row
        // sharing that order, not a single row (resolution is per-order, not per-ticket-row).
        rowNumbers: updates.map((u) => `${u.brand}:${u.parentOrder}`),
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
        // Higher cap than the queue's: a CSV row is 7 short columns, not the queue's 18, so far
        // more rows fit in the same 6MB response. Still capped - an uncapped read is what broke
        // the queue. Reads getEscalationOrdersForExport, not getEligibleOrders/getFreshLeads:
        // three columns are all this mapping uses, and at 20000 rows the difference is the
        // largest single read the app can make (see that function's comment).
        : (await getEscalationOrdersForExport(20000, { includeResolved: req.query.type !== 'fresh-leads' })).map((o) => ({
            HYP_Parent_OrderID: o.parentOrder,
            AWB_Number: o.awbNumber,
            // `status` (the resolution), not the never-populated statusAsPerAwb this used to read -
            // Status_1 exported blank for every row.
            Status_1: o.status,
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
// Exported for api/_lib/db.cache.test.js only - nothing in the app calls this directly.
module.exports.etagMatches = etagMatches;
// The import action accepts a pasted CSV body, so it needs a bigger cap than the 1mb default.
// Vercel reads this export off the route module; under Lambda the equivalent limit is
// api/_lambda/app.js's own express.json({ limit }), which is set to match.
module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };
