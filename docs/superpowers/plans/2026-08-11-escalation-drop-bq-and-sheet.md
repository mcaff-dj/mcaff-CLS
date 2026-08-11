# Escalation: move off BigQuery and the Sheet, onto Supabase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Escalation RTO Queue reads and writes exclusively against the Supabase Postgres database `POSTGRES_URL` already points at — no BigQuery, no Google Sheet, anywhere in this app or its scheduled jobs.

**Architecture:** Add a new `escalation_tickets` table to the same Postgres database `escalation_lead_assignments` already lives in. Replace `escalationBq.js`'s BigQuery-query-plus-JS-merge with one SQL query (`escalation_tickets LEFT JOIN escalation_lead_assignments`) added to `db.js`. Delete `escalationSheet.js`, `bigquery.js`, and both BigQuery sync scripts. Replace the ticket sync with a Python script that upserts into Postgres instead of truncate-rebuilding a BigQuery table. Row identity in the client switches from Sheet-sourced `sheetTab:rowNumber` to `brand:ticketNumber`.

**Tech Stack:** Next.js API routes, plain `pg`-backed Postgres helpers in `api/_lib/db.js` (no ORM), React client component, Python + `psycopg` for the sync script, GitHub Actions.

## Global Constraints

- No live testing or deploy — every verification step is offline (`node --check`, a `require()` load-check, `npm run build`, `grep`, `python --self-check`). No task runs a script against real MySQL/Postgres/BigQuery/Sheets, and no task deploys.
- `api/rto/sheet.js`, `api/ndr/sheet.js`, `scripts/sync_delivery_tickets_to_sheet.py` — different feature / different sheet's own writer — out of scope, do not touch.
- The RTO filter predicate and the five Sheet-only display fields (`city`/`state`/`tat`/`deliveredDate`/`solvDate`) stay dropped — `escalation_tickets`/the read query carry no such filter or columns. Not reopened by this plan.
- Resolution/assignment state stays keyed by `parent_order` in `escalation_lead_assignments` — no schema change to that table.

Spec: [`docs/superpowers/specs/2026-08-11-escalation-drop-bq-and-sheet-design.md`](../specs/2026-08-11-escalation-drop-bq-and-sheet-design.md)

---

### Task 1: `db.js` — add `escalation_tickets`, the read query, and the CSV-import index query

**Files:**
- Modify: `api/_lib/db.js`

**Interfaces:**
- Consumes: `pgSql` (module-local tagged-template helper, unchanged), `ensurePgSchema()` (unchanged, called at the top of every exported function in this file).
- Produces: `getEligibleOrders()`, `getFreshLeads()` — both zero-argument, both `async`, both resolving to the same array shape: `{ brand, parentOrder, awbNumber, addedDate, queryClass, queryCategory, deliveryPartnerName, orderDate, orderMonth, queryDate, queryMonth, whName, ticketNumber, totalTimesConsumerReached, newOrderId, awb, status, notes }[]`. `getEscalationOrderIndex()` — zero-argument, `async`, resolves to `{ byParent: Map<string, {brand}>, byParentAwb: Map<string, {brand}> }`. Task 3 depends on all three names and this exact row shape.

- [ ] **Step 1: Add the `escalation_tickets` table to `ensurePgSchema`**

In `api/_lib/db.js`, immediately after the `email` `DROP NOT NULL` line for `escalation_lead_assignments` (the block ends right before `} catch (e) {`), insert:

```js
  // Ticket data for the Escalation desk - previously BigQuery's Delivery_escalation, moved here
  // so the read path is one query (this table LEFT JOINed with escalation_lead_assignments)
  // instead of two systems merged in JavaScript. Populated by
  // scripts/sync_delivery_tickets_to_pg.py, upserted every 2h, not written by the app itself.
  // Date-shaped columns stay TEXT - they're display-formatted strings
  // (sync_delivery_tickets_to_sheet.py's build_sheet_row), not real timestamps.
  await pgSql`
    CREATE TABLE IF NOT EXISTS escalation_tickets (
      brand TEXT NOT NULL,
      ticket_number TEXT NOT NULL,
      parent_order TEXT NOT NULL,
      awb_number TEXT,
      added_date TEXT,
      query_class TEXT,
      query_category TEXT,
      delivery_partner_name TEXT,
      order_date TEXT,
      order_month TEXT,
      query_date TEXT,
      query_month TEXT,
      wh_name TEXT,
      total_times_user_reached INTEGER,
      loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (brand, ticket_number)
    )
  `;
  await pgSql`CREATE INDEX IF NOT EXISTS escalation_tickets_parent_order_idx ON escalation_tickets (parent_order)`;
```

- [ ] **Step 2: Add the read query and CSV-import index query**

Immediately after `getLiveEscalationAssignments` (the function ending `return rows.map((r) => ({ parentOrder: r.parent_order, email: r.email }));\n}`), insert:

```js
// Escalation desk's read path - one query, replacing what used to be a BigQuery query plus a
// JavaScript-side merge against getEscalationAssignments (two systems, because ticket data and
// resolution data used to live in different databases; now they're both here). The LATERAL
// join picks the single most-recent assignment row per order (highest assigned_at) - the same
// "most recent wins" rule the old JS Map-based merge applied by keeping the first-seen row from
// an assigned_at DESC list. WHERE a.resolved_at IS NULL drops already-resolved orders; an order
// with no assignment row at all still passes (LEFT JOIN LATERAL ... ON true leaves a.* all NULL,
// and NULL IS NULL is true). No predicate beyond that - RTO Queue and Fresh Leads both currently
// return every row; brand/tab-specific filtering rules are a follow-up, not implemented here.
async function getEscalationOrders() {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT t.brand, t.parent_order, t.awb_number, t.added_date, t.query_class, t.query_category,
           t.delivery_partner_name, t.order_date, t.order_month, t.query_date, t.query_month,
           t.wh_name, t.ticket_number, t.total_times_user_reached,
           a.resolution, a.agent_remarks, a.new_order_id, a.new_awb
    FROM escalation_tickets t
    LEFT JOIN LATERAL (
      SELECT resolution, agent_remarks, new_order_id, new_awb, resolved_at
      FROM escalation_lead_assignments a
      WHERE a.parent_order = t.parent_order
      ORDER BY a.assigned_at DESC
      LIMIT 1
    ) a ON true
    WHERE a.resolved_at IS NULL
  `;
  return rows.map((r) => ({
    brand: r.brand,
    parentOrder: r.parent_order || '',
    awbNumber: r.awb_number || '',
    addedDate: r.added_date || '',
    queryClass: r.query_class || '',
    queryCategory: r.query_category || '',
    deliveryPartnerName: r.delivery_partner_name || '',
    orderDate: r.order_date || '',
    orderMonth: r.order_month || '',
    queryDate: r.query_date || '',
    queryMonth: r.query_month || '',
    whName: r.wh_name || '',
    ticketNumber: r.ticket_number || '',
    totalTimesConsumerReached: r.total_times_user_reached ?? '',
    newOrderId: r.new_order_id || '',
    awb: r.new_awb || '',
    status: r.resolution || '',
    notes: r.agent_remarks || '',
  }));
}

// getEligibleOrders/getFreshLeads both call the one query above and currently return identical
// rows - see getEscalationOrders' own comment. Kept as two names (not one, with call sites
// deduplicated) because api/escalation/[action].js's `orders`/`export` actions already branch on
// req.query.type === 'fresh-leads' to pick one or the other, and tab-wise rules that will one day
// make them differ are a known follow-up, not this task's job.
async function getEligibleOrders() {
  return getEscalationOrders();
}

async function getFreshLeads() {
  return getEscalationOrders();
}

// CSV import's row-matching index - a matched row only needs to confirm the order exists and
// learn its brand (there is no Sheet cell to address anymore, so no row_number is carried).
// Replaces the old getSheetIndexFromBq (which queried BigQuery's orders_sheet_columns).
async function getEscalationOrderIndex() {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT parent_order, awb_number, brand FROM escalation_tickets`;
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((r) => {
    const parent = String(r.parent_order || '').trim().toLowerCase();
    if (!parent) return;
    const ref = { brand: r.brand };
    if (!byParent.has(parent)) byParent.set(parent, ref);
    const awbKey = String(r.awb_number || '').trim().toLowerCase();
    if (awbKey) byParentAwb.set(`${parent}||${awbKey}`, ref);
  });
  return { byParent, byParentAwb };
}
```

- [ ] **Step 3: Export the three new functions**

In the `module.exports` block at the end of the file, change:
```js
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk,
```
to:
```js
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk,
  getEligibleOrders, getFreshLeads, getEscalationOrderIndex,
```

- [ ] **Step 4: Verify the file loads and every new export is a function**

Run: `node --check api/_lib/db.js`
Expected: no output (syntax OK).

Run: `node -e "const db = require('./api/_lib/db.js'); ['getEligibleOrders','getFreshLeads','getEscalationOrderIndex'].forEach(k => console.log(k, typeof db[k]))"`
Expected:
```
getEligibleOrders function
getFreshLeads function
getEscalationOrderIndex function
```
This confirms the require chain and export wiring are correct without opening a real Postgres connection (`ensurePgSchema`/`pgSql` aren't called until one of these functions actually runs).

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat: add escalation_tickets table and a single-query read path to db.js"
```

---

### Task 2: Delete `escalationBq.js`, its test, and `bigquery.js`

**Files:**
- Delete: `api/_lib/escalationBq.js`, `api/_lib/escalationBq.test.js`, `api/_lib/bigquery.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — Task 1 already replaced everything these files did; Task 3 removes their last caller.

- [ ] **Step 1: Confirm nothing outside `api/escalation/[action].js` requires these**

Run: `grep -rln "escalationBq\|_lib/bigquery" api app scripts --include=*.js`
Expected: only `api/escalation/[action].js` (handled by Task 3, which runs before this delete lands in the same commit sequence — safe to delete now since Task 3 is the very next task and nothing else references these files).

- [ ] **Step 2: Delete the files**

```bash
git rm api/_lib/escalationBq.js api/_lib/escalationBq.test.js api/_lib/bigquery.js
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete escalationBq.js and bigquery.js, superseded by db.js's single-query read path"
```

---

### Task 3: `api/escalation/[action].js` — read from `db.js`, drop every Sheet/BigQuery touch

**Files:**
- Modify: `api/escalation/[action].js`

**Interfaces:**
- Consumes: `getEligibleOrders`, `getFreshLeads`, `getEscalationOrderIndex` from Task 1's `db.js` exports (exact names and shapes as specified there).
- Produces: HTTP contract Task 5 (client) depends on — `update`/`bulk-update`/`assign` no longer require `rowNumber`/`sheetTab`; `import`'s response `rowNumbers` values are `` `${brand}:${parentOrder}` ``.

- [ ] **Step 1: Replace the file's requires and the now-deleted `getSheetIndexFromBq`/BQ constants**

Replace (original lines 15-51):
```js
const { getSession } = require('../_lib/session');
const { updateOrder, batchUpdateOrders } = require('../_lib/escalationSheet');
const { getEligibleOrders, getFreshLeads } = require('../_lib/escalationBq');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const {
  getCallingProcessAgents, assignEscalationOrder, unassignEscalationOrder,
  resolveEscalationAssignment, getEscalationAssignments,
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk,
} = require('../_lib/db');
const { runQuery } = require('../_lib/bigquery');

const CARD_KEY = 'calling';
const TAB_KEY = 'escalation';
const PROCESS_KEY = 'escalation';

const BQ_PROJECT = process.env.BQ_PROJECT_ID || 'sheetdata-501810';
const BQ_DATASET = process.env.BQ_DATASET || 'escalation';

// CSV import's row-matching index, sourced from orders_sheet_columns instead of a live Sheet
// read (that table already carries row_number/brand for exactly this purpose - see
// docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md).
async function getSheetIndexFromBq() {
  const rows = await runQuery(BQ_PROJECT,
    `SELECT parent_order AS parentOrder, awb_key AS awbKey, row_number AS rowNumber, brand
     FROM \`${BQ_PROJECT}.${BQ_DATASET}.orders_sheet_columns\`
     WHERE deleted_from_sheet_at IS NULL`);
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((r) => {
    const parent = String(r.parentOrder || '').trim().toLowerCase();
    if (!parent) return;
    const ref = { rowNumber: Number(r.rowNumber), sheetTab: r.brand };
    if (!byParent.has(parent)) byParent.set(parent, ref);
    if (r.awbKey) byParentAwb.set(`${parent}||${r.awbKey}`, ref);
  });
  return { byParent, byParentAwb };
}
```
with:
```js
const { getSession } = require('../_lib/session');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const {
  getCallingProcessAgents, assignEscalationOrder, unassignEscalationOrder,
  resolveEscalationAssignment, getEscalationAssignments,
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk,
  getEligibleOrders, getFreshLeads, getEscalationOrderIndex,
} = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'escalation';
const PROCESS_KEY = 'escalation';
```

- [ ] **Step 2: Fix the `update` action**

Replace:
```js
    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumber, sheetTab, parentOrder, newOrderId, newAwb, newStatus, notes } = body;
      if (!rowNumber || !sheetTab || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'rowNumber, sheetTab, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(rowNumber, sheetTab, { newOrderId, newAwb, newStatus, notes: notes || '' });
      if (parentOrder) await resolveEscalationAssignment(parentOrder, newStatus, notes || '', newOrderId, newAwb);
      return res.status(200).json({ ok: true });
    }
```
with:
```js
    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { parentOrder, newOrderId, newAwb, newStatus, notes } = body;
      if (!parentOrder || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'parentOrder, newOrderId, newAwb, and newStatus are all required' });
      }
      await resolveEscalationAssignment(parentOrder, newStatus, notes || '', newOrderId, newAwb);
      return res.status(200).json({ ok: true });
    }
```

- [ ] **Step 3: Fix the `bulk-update` action**

Replace:
```js
      if (items.some((i) => !i.sheetTab)) {
        return res.status(400).json({ error: 'Every item requires sheetTab' });
      }
      const updated = await batchUpdateOrders(
        items.map(({ rowNumber, sheetTab }) => ({ rowNumber, sheetTab, newOrderId: '-', newAwb: '-', newStatus: status }))
      );
      await resolveEscalationAssignmentsBulk(items.map((i) => i.parentOrder).filter(Boolean), status);
      return res.status(200).json({ ok: true, updated });
```
with:
```js
      const parentOrders = items.map((i) => i.parentOrder).filter(Boolean);
      if (!parentOrders.length) return res.status(400).json({ error: 'Every item requires parentOrder' });
      await resolveEscalationAssignmentsBulk(parentOrders, status);
      return res.status(200).json({ ok: true, updated: parentOrders.length });
```

- [ ] **Step 4: Fix the `import` action**

Replace the block from `const { byParent, byParentAwb } = await getSheetIndexFromBq();` through the end of that action's response object with:

```js
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

      await Promise.all(updates.map((u) =>
        resolveEscalationAssignment(u.parentOrder, u.newStatus, u.notes, u.newOrderId, u.newAwb)
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
```

- [ ] **Step 5: Drop the `rowNumber` requirement from `assign`**

Replace:
```js
        const { rowNumber, parentOrder, agentId } = body;
        if (!rowNumber || !parentOrder) return res.status(400).json({ error: 'rowNumber and parentOrder are required' });
```
with:
```js
        const { parentOrder, agentId } = body;
        if (!parentOrder) return res.status(400).json({ error: 'parentOrder is required' });
```

- [ ] **Step 6: Verify the file parses and no Sheet/BigQuery reference survives**

Run: `node --check "api/escalation/[action].js"`
Expected: no output.

Run: `grep -n "escalationSheet\|escalationBq\|_lib/bigquery\|sheetTab\|rowNumber\|orders_sheet_columns" "api/escalation/[action].js"`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add "api/escalation/[action].js"
git commit -m "feat: point the Escalation API at db.js's Postgres-only read/write path, drop Sheet and BigQuery"
```

---

### Task 4: Delete `escalationSheet.js`

**Files:**
- Delete: `api/_lib/escalationSheet.js`

**Interfaces:**
- Consumes: nothing (Task 3 already removed its only caller).
- Produces: nothing.

- [ ] **Step 1: Confirm nothing still requires it**

Run: `grep -rn "escalationSheet" api app scripts --include=*.js`
Expected: no matches.

- [ ] **Step 2: Delete and commit**

```bash
git rm api/_lib/escalationSheet.js
git commit -m "chore: delete escalationSheet.js, dead since the Escalation API stopped writing to the Sheet"
```

---

### Task 5: `app/escalation/EscalationClient.js` — switch row identity to `brand:ticketNumber`

**Files:**
- Modify: `app/escalation/EscalationClient.js`

**Interfaces:**
- Consumes: order shape from Task 1 (`order.brand`, `order.ticketNumber`, no `order.rowNumber`/`order.sheetTab`); `import` response shape from Task 3 (`rowNumbers: string[]` shaped `brand:parentOrder`).
- Produces: nothing consumed by a later task — last code task in this plan.

- [ ] **Step 1: Rewrite `rowKey` and its comment**

Replace:
```js
// Both HYPHEN and mCaffeine tabs feed this page's `orders` list side by side, and each restarts
// its own row numbering at row 2 - rowNumber alone can collide across the two. Anywhere a row
// needs a stable, globally-unique identity (Set/Map keys, React `key`, DOM ids) use this instead
// of raw `order.rowNumber`. Sheet-write calls still send the raw rowNumber + sheetTab separately
// (see api/_lib/escalationSheet.js), which is what actually addresses the write.
function rowKey(o) {
  return `${o.sheetTab}:${o.rowNumber}`;
}
```
with:
```js
// Both HYPHEN and mCaffeine feed this page's `orders` list side by side, and a bare ticketNumber
// isn't guaranteed unique across brands - this is the stable, globally-unique row identity for
// Set/Map keys, React `key`, and DOM ids. ticketNumber is the MySQL ticketing system's own
// per-row ID, unlike parentOrder, which one order can share across multiple ticket rows.
function rowKey(o) {
  return `${o.brand}:${o.ticketNumber}`;
}
```

- [ ] **Step 2: Fix `fId` in `OrderRow`**

Replace:
```js
  const fId = `row-${order.sheetTab}-${order.rowNumber}`;
```
with:
```js
  const fId = `row-${order.brand}-${order.ticketNumber}`;
```

- [ ] **Step 3: Drop `rowNumber`/`sheetTab` from the `update` fetch payload**

Replace:
```js
        body: JSON.stringify({
          rowNumber: order.rowNumber,
          sheetTab: order.sheetTab,
          parentOrder: order.parentOrder,
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
```
with:
```js
        body: JSON.stringify({
          parentOrder: order.parentOrder,
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
```

- [ ] **Step 4: Drop `rowNumber` from the `assign` fetch payload**

Replace:
```js
        body: JSON.stringify({ rowNumber: order.rowNumber, parentOrder: order.parentOrder, agentId: agentId || null }),
```
with:
```js
        body: JSON.stringify({ parentOrder: order.parentOrder, agentId: agentId || null }),
```

- [ ] **Step 5: Fix `handleBulkApply`'s candidate list and filter**

Replace:
```js
  async function handleBulkApply(status) {
    const items = Array.from(selectedRows).map((key) => {
      const o = orders.find((o) => rowKey(o) === key);
      return { rowNumber: o?.rowNumber, sheetTab: o?.sheetTab, parentOrder: o?.parentOrder };
    }).filter((i) => i.rowNumber && i.sheetTab);
```
with:
```js
  async function handleBulkApply(status) {
    const items = Array.from(selectedRows).map((key) => {
      const o = orders.find((o) => rowKey(o) === key);
      return { parentOrder: o?.parentOrder };
    }).filter((i) => i.parentOrder);
```

- [ ] **Step 6: Fix `handleImported`'s matching**

Replace:
```js
  /* --- Bulk upload result --- */
  // `keys` are "sheetTab:rowNumber" composites (see api/escalation/[action].js's import
  // response) - matched against rowKey(o), not a bare rowNumber.
  function handleImported(keys) {
    if (keys?.length) {
      const done = new Set(keys);
      setOrders((p) => p.filter((o) => !done.has(rowKey(o))));
      setResolvedCount((c) => c + keys.length);
      setSelectedRows((p) => {
        const n = new Set(p);
        keys.forEach((k) => n.delete(k));
        return n;
      });
    }
  }
```
with:
```js
  /* --- Bulk upload result --- */
  // `keys` are "brand:parentOrder" composites (see api/escalation/[action].js's import
  // response) - a matched CSV row resolves every ticket row sharing that order, same granularity
  // resolution itself uses, so this filters/deselects by order identity, not by rowKey(o).
  function handleImported(keys) {
    if (keys?.length) {
      const done = new Set(keys);
      const orderKey = (o) => `${o.brand}:${o.parentOrder}`;
      setOrders((p) => p.filter((o) => !done.has(orderKey(o))));
      setResolvedCount((c) => c + keys.length);
      setSelectedRows((p) => {
        const n = new Set(p);
        p.forEach((k) => {
          const o = orders.find((o) => rowKey(o) === k);
          if (o && done.has(orderKey(o))) n.delete(k);
        });
        return n;
      });
    }
  }
```

- [ ] **Step 7: Verify no stale reference survives and the app builds**

Run: `grep -n "sheetTab\|order\.rowNumber\|o\.rowNumber\|o?\.rowNumber" app/escalation/EscalationClient.js`
Expected: no matches.

Run: `npm run build`
Expected: build succeeds (exit code 0). Per this project's no-live-testing rule, do not run `npm run dev` or open the app.

- [ ] **Step 8: Commit**

```bash
git add app/escalation/EscalationClient.js
git commit -m "feat: switch Escalation row identity from Sheet rowNumber to ticketNumber"
```

---

### Task 6: New sync script `sync_delivery_tickets_to_pg.py`, delete the BigQuery ticket sync and `bq_lib.py`

**Files:**
- Create: `scripts/sync_delivery_tickets_to_pg.py`
- Delete: `scripts/sync_delivery_tickets_to_bq.py`, `scripts/bq_lib.py`

**Interfaces:**
- Consumes: `sync_delivery_tickets_to_sheet.fetch_today_delivery_tickets(table, since)`, `.build_sheet_row(row)`, `.fill_missing_awb(rows)`, `.TAB_TABLE` (all unchanged, existing functions in `scripts/sync_delivery_tickets_to_sheet.py`); `lib.get_pg_connection(conn_str)` (unchanged, existing in `scripts/lib.py`).
- Produces: populates Postgres table `escalation_tickets` (Task 1's schema) — Task 7's workflow YAML invokes this script by name.

- [ ] **Step 1: Write the script with its offline self-check**

Create `scripts/sync_delivery_tickets_to_pg.py`:

```python
"""Pushes Delivery-class tickets from PEP_CLS into Supabase Postgres' escalation_tickets table -
the Postgres counterpart of sync_delivery_tickets_to_sheet.py, reading the same MySQL rows on the
same "resolved since <date>" definition. Replaces sync_delivery_tickets_to_bq.py now that ticket
data lives in the same Postgres database escalation_lead_assignments already does (see
docs/superpowers/specs/2026-08-11-escalation-drop-bq-and-sheet-design.md).

Reuses sync_delivery_tickets_to_sheet.py's MySQL query, row-building, and AWB-backfill functions
by import instead of re-implementing "which tickets count" a second time - that script is NOT
modified and keeps writing the sheet exactly as before.

Both brand tabs land in ONE table, distinguished by a `brand` column ('HYPHEN' / 'mCaffeine').

Unlike the BigQuery version, this is a real upsert (ON CONFLICT DO UPDATE), not a truncate-rebuild
- Postgres has no DML billing restriction to work around. total_times_user_reached still needs a
second pass: a --since-windowed fetch only recomputes that count for rows it just touched, so
older rows sharing the same AWB would otherwise go stale. The second UPDATE below fixes exactly
those rows, using the same awb_counts already computed for step one - cheaper than rewriting the
whole table, and more correct than the BigQuery version (which only fixed staleness by rebuilding
everything back to a fixed anchor date).

CREDENTIALS: MYSQL_* (unchanged - same as sync_delivery_tickets_to_sheet.py) plus POSTGRES_URL.
No Google credentials needed - this script never touches Sheets or BigQuery.
"""
import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import sync_delivery_tickets_to_sheet as tickets

TAB_TABLE = tickets.TAB_TABLE  # {"HYPHEN": "hyphen_tickets", "mCaffeine": "mcaff_tickets"}

# Names for build_sheet_row's first 11 slots (Added date .. WH Name), same mapping
# sync_delivery_tickets_to_bq.py used.
TICKET_FIELDS = [
    "added_date", "query_class", "query_category", "parent_order", "awb_number",
    "delivery_partner_name", "order_date", "order_month", "query_date",
    "query_month", "wh_name",
]

UPSERT_SQL = """
    INSERT INTO escalation_tickets
      (brand, ticket_number, parent_order, awb_number, added_date, query_class, query_category,
       delivery_partner_name, order_date, order_month, query_date, query_month, wh_name,
       total_times_user_reached, loaded_at)
    VALUES (%(brand)s, %(ticket_number)s, %(parent_order)s, %(awb_number)s, %(added_date)s,
            %(query_class)s, %(query_category)s, %(delivery_partner_name)s, %(order_date)s,
            %(order_month)s, %(query_date)s, %(query_month)s, %(wh_name)s,
            %(total_times_user_reached)s, %(loaded_at)s)
    ON CONFLICT (brand, ticket_number) DO UPDATE SET
      parent_order = EXCLUDED.parent_order, awb_number = EXCLUDED.awb_number,
      added_date = EXCLUDED.added_date, query_class = EXCLUDED.query_class,
      query_category = EXCLUDED.query_category, delivery_partner_name = EXCLUDED.delivery_partner_name,
      order_date = EXCLUDED.order_date, order_month = EXCLUDED.order_month,
      query_date = EXCLUDED.query_date, query_month = EXCLUDED.query_month, wh_name = EXCLUDED.wh_name,
      total_times_user_reached = EXCLUDED.total_times_user_reached, loaded_at = EXCLUDED.loaded_at
"""

RECOMPUTE_SQL = """
    UPDATE escalation_tickets SET total_times_user_reached = %(count)s
    WHERE brand = %(brand)s AND awb_number = %(awb_number)s
"""


def get_awb_reach_counts(table, awbs):
    """AWB -> total count of Delivery-class tickets ever raised against it in `table` - a
    running total across all history, not scoped to this sync's since/today filter, since "how
    many times has the user reached out" only means something as a lifetime count. Queries MySQL
    directly (not the local Postgres mirror), which can't have every historical row for an AWB
    when this run's fetch is windowed by `since`."""
    awbs = sorted({a for a in awbs if a})
    if not awbs:
        return {}
    placeholders = ",".join(["%s"] * len(awbs))
    rows = tickets.mysql_lib.query(
        f"SELECT disposition_awb_number, COUNT(*) FROM {table} "
        f"WHERE category LIKE %s AND disposition_awb_number IN ({placeholders}) "
        f"GROUP BY disposition_awb_number",
        ("%Delivery%", *awbs), database="PEP_CLS",
    )
    return {awb: count for awb, count in (rows or [])}


def row_to_pg_dict(sheet_row, brand, awb_counts=None):
    """sheet_row is tickets.build_sheet_row()'s output (list: 11 ticket fields, padded to 25,
    then ticket_number appended last) - reused as-is rather than re-deriving the same values from
    the raw DB row a second time. Sliced/indexed by position (not by a fixed length), so padding
    column count changes in build_sheet_row don't break this mapping."""
    d = {"brand": brand}
    d.update(zip(TICKET_FIELDS, sheet_row))
    d["ticket_number"] = sheet_row[-1]
    d["loaded_at"] = datetime.now(timezone.utc)
    awb = d["awb_number"]
    # get_awb_reach_counts counts by the ticket table's own disposition_awb_number column, which
    # is blank on exactly the rows fill_missing_awb had to backfill from Item_level_data - those
    # rows won't self-match that count. This row is still one genuine instance of the AWB, so 1
    # is the floor, never 0/None for a row that does have an AWB.
    d["total_times_user_reached"] = max((awb_counts or {}).get(awb, 0), 1) if awb else None
    return d


def sync(since, dry_run):
    if not os.environ.get("POSTGRES_URL"):
        raise RuntimeError("POSTGRES_URL env var is required")

    all_rows = []
    all_awb_counts = {}
    for brand, table in TAB_TABLE.items():
        db_rows = tickets.fetch_today_delivery_tickets(table, since=since)
        print(f"  {brand} ({table}): {len(db_rows)} Delivery-class ticket(s) since {since}")
        sheet_rows = [tickets.build_sheet_row(r) for r in db_rows]
        tickets.fill_missing_awb(sheet_rows)
        awb_counts = get_awb_reach_counts(table, [r[4] for r in sheet_rows])
        all_rows.extend(row_to_pg_dict(r, brand, awb_counts) for r in sheet_rows)
        for awb, count in awb_counts.items():
            all_awb_counts[(brand, awb)] = count

    print(f"  {len(all_rows)} row(s) total to {'would upsert' if dry_run else 'upsert'}")
    if dry_run:
        for r in all_rows[:5]:
            print("   ", r)
        if len(all_rows) > 5:
            print(f"    ... and {len(all_rows) - 5} more")
        return

    conn = lib.get_pg_connection(os.environ["POSTGRES_URL"])
    try:
        with conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, all_rows)
            # Recompute total_times_user_reached on every row sharing a touched AWB, not just the
            # ones this run fetched - see module docstring for why a plain upsert can't do this.
            recompute = [{"brand": b, "awb_number": awb, "count": c} for (b, awb), c in all_awb_counts.items()]
            if recompute:
                cur.executemany(RECOMPUTE_SQL, recompute)
        conn.commit()
    finally:
        conn.close()
    print(f"  upserted {len(all_rows)} row(s), recomputed total_times_user_reached for {len(all_awb_counts)} AWB(s)")


def self_check():
    """Offline check of the row mapping - no MySQL, no Postgres."""
    db_row = ("TCK-1", "Late", "ORD-1", "", "AWB-1", "Delhivery",
              datetime(2026, 8, 1), datetime(2026, 8, 2), datetime(2026, 8, 3), "WH1")
    sheet_row = tickets.build_sheet_row(db_row)
    out = row_to_pg_dict(sheet_row, "HYPHEN", awb_counts={"AWB-1": 3})
    assert out["brand"] == "HYPHEN", out
    assert out["ticket_number"] == "TCK-1", out
    assert out["parent_order"] == "ORD-1", out
    assert out["wh_name"] == "WH1", out
    assert out["order_month"] == tickets.format_month(datetime(2026, 8, 1)), out
    assert out["total_times_user_reached"] == 3, out
    assert "loaded_at" in out

    out2 = row_to_pg_dict(sheet_row, "HYPHEN", awb_counts={})
    assert out2["total_times_user_reached"] == 1, out2

    no_awb_row = tickets.build_sheet_row(("TCK-2", "Late", "ORD-2", "", "", "Delhivery",
                                           datetime(2026, 8, 1), datetime(2026, 8, 2), datetime(2026, 8, 3), "WH1"))
    out3 = row_to_pg_dict(no_awb_row, "HYPHEN", awb_counts={})
    assert out3["total_times_user_reached"] is None, out3
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no Postgres writes")
    parser.add_argument("--since", metavar="YYYY-MM-DD", required=False,
                         help="Backfill everything resolved from this date through today, not just today.")
    parser.add_argument("--self-check", action="store_true", help="Run the offline row-mapping check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    sync(args.since, args.dry_run)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the self-check**

Run: `python scripts/sync_delivery_tickets_to_pg.py --self-check`
Expected: `self-check ok`

- [ ] **Step 3: Delete the files this replaces**

Run: `grep -rln "sync_delivery_tickets_to_bq\|bq_lib" api app scripts .github --include=*.js --include=*.py --include=*.yml`
Expected: only `scripts/sync_delivery_tickets_to_bq.py`, `scripts/bq_lib.py`, and `.github/workflows/sync-escalation-bq.yml` (handled by Task 7).

```bash
git add scripts/sync_delivery_tickets_to_pg.py
git rm scripts/sync_delivery_tickets_to_bq.py scripts/bq_lib.py
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: replace the BigQuery ticket sync with a Postgres upsert into escalation_tickets"
```

---

### Task 7: Retire the Sheet-sweep script, rename and rewrite the CI workflow

**Files:**
- Delete: `scripts/sync_escalation_sheet_to_bq.py`
- Create: `.github/workflows/sync-escalation-pg.yml`
- Delete: `.github/workflows/sync-escalation-bq.yml`

**Interfaces:**
- Consumes: `scripts/sync_delivery_tickets_to_pg.py` (Task 6, invoked by name from the new workflow).
- Produces: nothing — last task in this plan.

- [ ] **Step 1: Confirm nothing still references the sheet-sweep script**

Run: `grep -rln "sync_escalation_sheet_to_bq\|orders_sheet_columns" api app scripts .github --include=*.js --include=*.py --include=*.yml`
Expected: only `scripts/sync_escalation_sheet_to_bq.py` itself.

- [ ] **Step 2: Delete the sheet-sweep script**

```bash
git rm scripts/sync_escalation_sheet_to_bq.py
```

- [ ] **Step 3: Create the new workflow, delete the old one**

Create `.github/workflows/sync-escalation-pg.yml`:

```yaml
name: Rebuild escalation_tickets

on:
  schedule:
    - cron: '0 */2 * * *'   # every 2 hours, matching the existing ticket-sync cadence
  workflow_dispatch:
    inputs:
      since:
        description: "Backfill from this date (YYYY-MM-DD) through today; leave blank for today only"
        required: false

permissions:
  contents: read

concurrency:
  group: sync-escalation-pg
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Sync escalation_tickets from MySQL
        env:
          MYSQL_HOST: ${{ secrets.MYSQL_HOST }}
          MYSQL_USER: ${{ secrets.MYSQL_USER }}
          MYSQL_PASSWORD: ${{ secrets.MYSQL_PASSWORD }}
          MYSQL_DATABASE: ${{ secrets.MYSQL_DATABASE }}
          MYSQL_PORT: ${{ secrets.MYSQL_PORT }}
          POSTGRES_URL: ${{ secrets.POSTGRES_URL }}
        run: python scripts/sync_delivery_tickets_to_pg.py ${{ github.event.inputs.since && format('--since {0}', github.event.inputs.since) || '' }}
```

This is an incremental upsert, not a truncate-rebuild, so the scheduled trigger omits `--since`
entirely (today-only, same as `sync-delivery-tickets.yml`'s own scheduled runs) — history
accumulates in the table across runs instead of being reconstructed from a fixed anchor every
time. `--since` is only for a manual backfill via `workflow_dispatch`, same pattern that workflow
already uses.

```bash
git add .github/workflows/sync-escalation-pg.yml
git rm .github/workflows/sync-escalation-bq.yml
```

- [ ] **Step 4: Verify the new YAML parses**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/sync-escalation-pg.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: retire the BigQuery sync workflow, add the Postgres one in its place"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the spec's `escalation_tickets` data model and read-query section; Task 2/4/6/7 cover every file the spec's file-by-file table marks "Delete"; Task 3 covers every write action plus CSV-import re-sourcing; Task 5 covers the client row-identity change; Task 6 covers the sync script (upsert + targeted recompute, exactly as specified). The spec's "Open items" (tab-wise filtering, Sheet display fields) are explicitly deferred, not tasks here.
- **Placeholder scan:** no TBD/TODO; every step has literal code.
- **Type consistency:** `getEscalationOrders`'s return shape (Task 1) matches what Task 3's `orders`/`export` actions and Task 5's `order.brand`/`order.ticketNumber` reads assume. `row_to_pg_dict`'s dict keys (Task 6) match `UPSERT_SQL`'s named placeholders exactly (`%(brand)s`, `%(ticket_number)s`, etc. against `d["brand"]`, `d["ticket_number"]`, ...) - checked key-by-key while writing the plan.
