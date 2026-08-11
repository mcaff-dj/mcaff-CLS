# Escalation: drop the Sheet dependency entirely — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Escalation RTO Queue app stops reading from or writing to the Google Sheet anywhere — reads come from BigQuery's `Delivery_escalation` table alone (no join, no RTO predicate — shows all rows), writes go to Postgres only.

**Architecture:** Drop `escalationBq.js`'s join against `orders_sheet_columns` and its RTO filter predicate. Delete `escalationSheet.js` (the Sheet write module) and its one caller's Sheet-write code paths in `api/escalation/[action].js`. Row identity switches from Sheet-sourced `sheetTab:rowNumber` to `brand:ticketNumber` (a real column already in `Delivery_escalation`) everywhere in `EscalationClient.js`. Delete the now-unused sheet-sweep script and its CI schedule.

**Tech Stack:** Next.js API routes (`api/escalation/[action].js`), plain Node (no test framework — offline tests are `assert`-based scripts run with `node file.test.js`), React client component (`app/escalation/EscalationClient.js`), Python sync scripts, GitHub Actions.

## Global Constraints

- No live testing or deploy — every verification step in this plan is offline (`node --check`, `node file.test.js`, `npm run build`, `grep`). No task may run a script against real BigQuery/Postgres/Sheets/DB, and no task deploys.
- `api/rto/sheet.js` and `api/ndr/sheet.js` are a different feature/sheet — out of scope, do not touch.
- `scripts/sync_delivery_tickets_to_sheet.py` is untouched — it writes the Sheet for reasons outside this app.
- Resolution/assignment state stays keyed by `(brand, parent_order)` in Postgres — unchanged.

Spec: [`docs/superpowers/specs/2026-08-11-escalation-drop-sheet-design.md`](../specs/2026-08-11-escalation-drop-sheet-design.md)

---

### Task 1: `escalationBq.js` — drop the Sheet-sourced join and RTO predicate

**Files:**
- Modify: `api/_lib/escalationBq.js`
- Test: `api/_lib/escalationBq.test.js`

**Interfaces:**
- Consumes: `runQuery(project, sql)` from `api/_lib/bigquery.js` (unchanged signature), `getEscalationAssignments()` from `api/_lib/db.js` (unchanged signature).
- Produces: `mergeOrderRow(bqRow, resolutionRow)` — now returns an object with `brand` (not `sheetTab`), no `rowNumber`, and no `deliveredDate`/`statusAsPerAwb`/`solvDate`/`tat`/`updateFromLogistics`/`city`/`state` keys. `getEligibleOrders()` and `getFreshLeads()` keep their existing zero-argument signatures and both return the same unfiltered row set. Task 2 and Task 4 depend on this shape.

- [ ] **Step 1: Update the test file's assertions to the new row shape (this is the failing test)**

Replace the whole body of `api/_lib/escalationBq.test.js` with:

```js
// Offline test for escalationBq.js's pure merge/filter logic - no BigQuery, no Postgres, no
// network. Run with `node api/_lib/escalationBq.test.js`.
const assert = require('assert');
const { mergeOrderRow } = require('./escalationBq');

(async () => {
  // 1. A BigQuery row with no matching Postgres resolution merges through with resolution
  //    fields empty - this is the common case (a pending, never-touched order).
  const bqRow = {
    brand: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1', ticketNumber: 'T1',
    addedDate: 'Aug 1, 2026', queryClass: 'Delivery', queryCategory: 'Delayed Order',
    deliveryPartnerName: 'Delhivery', orderDate: 'Jul 30, 2026', orderMonth: "7_Jul'26",
    queryDate: 'Aug 1, 2026', queryMonth: "8_Aug'26", whName: 'WH1',
    totalTimesConsumerReached: '2',
  };
  const merged = mergeOrderRow(bqRow, null);
  assert.strictEqual(merged.brand, 'HYPHEN');
  assert.strictEqual(merged.ticketNumber, 'T1');
  assert.strictEqual(merged.rowNumber, undefined, 'rowNumber no longer exists - nothing addresses a Sheet cell');
  assert.strictEqual(merged.sheetTab, undefined, 'sheetTab is renamed to brand');
  assert.strictEqual(merged.city, undefined, 'Sheet-only display fields are absent, not blank');
  assert.strictEqual(merged.statusAsPerAwb, undefined, 'Sheet-only display fields are absent, not blank');
  assert.strictEqual(merged.status, '', 'no resolution -> blank status');
  assert.strictEqual(merged.totalTimesConsumerReached, '2', 'field name unchanged for the frontend');

  // 2. A resolved order is identifiable via its merged status - the caller (getEligibleOrders)
  //    is responsible for filtering these out, this function only merges.
  const resolved = mergeOrderRow(bqRow, { resolution: 'Delivered', agentRemarks: 'ok', newOrderId: 'HYP2', newAwb: 'AWB2' });
  assert.strictEqual(resolved.status, 'Delivered');
  assert.strictEqual(resolved.notes, 'ok');
  assert.strictEqual(resolved.newOrderId, 'HYP2');
  assert.strictEqual(resolved.awb, 'AWB2', 'the original sheet field name is "awb", not "newAwb"');

  console.log('escalationBq.test.js: all assertions passed');
})();
```

- [ ] **Step 2: Run the test to verify it fails against the current implementation**

Run: `node api/_lib/escalationBq.test.js`
Expected: `AssertionError` — `merged.brand` is `undefined` (current code sets `sheetTab`, not `brand`), or a later assertion fails once that one's fixed. Any failure is fine here; the point is confirming the test exercises code that hasn't changed yet.

- [ ] **Step 3: Rewrite `escalationBq.js`**

Replace the full contents of `api/_lib/escalationBq.js`:

```js
// Reads for the Escalation desk - queries BigQuery's Delivery_escalation table directly, no
// join, no filter predicate. Previously joined a second table (orders_sheet_columns) swept from
// the Sheet to get an RTO filter predicate and five display fields; that join and predicate are
// gone (see docs/superpowers/specs/2026-08-11-escalation-drop-sheet-design.md) - this app no
// longer touches the Sheet or anything derived from it, anywhere.
const { runQuery } = require('./bigquery');
const { getEscalationAssignments } = require('./db');

const PROJECT = process.env.BQ_PROJECT_ID || 'sheetdata-501810';
const DATASET = process.env.BQ_DATASET || 'escalation';

// One row of Delivery_escalation merged with its Postgres resolution row (or null if never
// assigned/resolved). `brand` replaces the old Sheet-derived `sheetTab`; there is no `rowNumber`
// (nothing addresses a Sheet cell anymore) and no city/state/tat/deliveredDate/solvDate/
// statusAsPerAwb/updateFromLogistics (those only ever existed via the Sheet sweep) - EscalationClient.js
// already renders every one of those fields with a `|| ''`/`|| '—'` fallback, so their absence
// renders blank rather than breaking anything.
function mergeOrderRow(bqRow, resolutionRow) {
  return {
    brand: bqRow.brand,
    addedDate: bqRow.addedDate || '',
    queryClass: bqRow.queryClass || '',
    queryCategory: bqRow.queryCategory || '',
    parentOrder: bqRow.parentOrder || '',
    awbNumber: bqRow.awbNumber || '',
    deliveryPartnerName: bqRow.deliveryPartnerName || '',
    orderDate: bqRow.orderDate || '',
    orderMonth: bqRow.orderMonth || '',
    queryDate: bqRow.queryDate || '',
    queryMonth: bqRow.queryMonth || '',
    whName: bqRow.whName || '',
    totalTimesConsumerReached: bqRow.totalTimesConsumerReached ?? '',
    ticketNumber: bqRow.ticketNumber || '',
    // Resolution fields - blank when there is no Postgres row yet.
    newOrderId: resolutionRow?.newOrderId || '',
    awb: resolutionRow?.newAwb || '',
    status: resolutionRow?.resolution || '',
    notes: resolutionRow?.agentRemarks || '',
  };
}

// No predicate, no join - every row in Delivery_escalation, merged with its Postgres resolution
// (if any) and with already-resolved rows dropped. getEligibleOrders and getFreshLeads both call
// this with no arguments and currently return identical results; tab-wise filtering rules (which
// rows count as "RTO Queue" vs. "Fresh Leads") are a follow-up, not implemented here.
async function queryOrders() {
  const sql = `
    SELECT brand, parent_order AS parentOrder, awb_number AS awbNumber,
           added_date AS addedDate, query_class AS queryClass, query_category AS queryCategory,
           delivery_partner_name AS deliveryPartnerName, order_date AS orderDate,
           order_month AS orderMonth, query_date AS queryDate, query_month AS queryMonth,
           wh_name AS whName, ticket_number AS ticketNumber,
           total_times_user_reached AS totalTimesConsumerReached
    FROM \`${PROJECT}.${DATASET}.Delivery_escalation\`
  `;
  const bqRows = await runQuery(PROJECT, sql);

  const resolutions = await getEscalationAssignments();
  const byParentOrder = new Map();
  resolutions.forEach((r) => { if (!byParentOrder.has(r.parentOrder)) byParentOrder.set(r.parentOrder, r); });

  return bqRows
    .map((row) => mergeOrderRow(row, byParentOrder.get(row.parentOrder) || null))
    .filter((row) => !row.status); // drop already-resolved orders
}

async function getEligibleOrders() {
  return queryOrders();
}

async function getFreshLeads() {
  return queryOrders();
}

module.exports = { getEligibleOrders, getFreshLeads, mergeOrderRow };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node api/_lib/escalationBq.test.js`
Expected: `escalationBq.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js api/_lib/escalationBq.test.js
git commit -m "feat: drop the Sheet-sourced join and RTO predicate from escalation reads"
```

---

### Task 2: `api/escalation/[action].js` — remove every Sheet write, re-source CSV import matching from BigQuery

**Files:**
- Modify: `api/escalation/[action].js`

**Interfaces:**
- Consumes: `mergeOrderRow`/`getEligibleOrders`/`getFreshLeads` shape from Task 1 (`brand`, no `rowNumber`/`sheetTab`). `runQuery(project, sql)` from `api/_lib/bigquery.js` (unchanged).
- Produces: HTTP contract changes Task 5 (client) depends on — `update`/`bulk-update`/`assign` no longer require `rowNumber`/`sheetTab` in the request body; `import`'s JSON response keeps the `rowNumbers` key but its string values are now `` `${brand}:${parentOrder}` `` (not `sheetTab:rowNumber`).

- [ ] **Step 1: Remove the `escalationSheet` import and its two call sites**

In `api/escalation/[action].js`, delete line 16:
```js
const { updateOrder, batchUpdateOrders } = require('../_lib/escalationSheet');
```

- [ ] **Step 2: Replace `getSheetIndexFromBq` with `getOrderIndexFromBq`, querying `Delivery_escalation`**

Replace the whole function (originally lines 33-51):

```js
// CSV import's row-matching index, sourced from Delivery_escalation directly - a matched row
// only needs to confirm the order exists and learn its brand; there is no Sheet cell left to
// address, so no row_number is carried.
async function getOrderIndexFromBq() {
  const rows = await runQuery(BQ_PROJECT,
    `SELECT parent_order AS parentOrder, awb_number AS awbNumber, brand
     FROM \`${BQ_PROJECT}.${BQ_DATASET}.Delivery_escalation\``);
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((r) => {
    const parent = String(r.parentOrder || '').trim().toLowerCase();
    if (!parent) return;
    const ref = { brand: r.brand };
    if (!byParent.has(parent)) byParent.set(parent, ref);
    const awbKey = String(r.awbNumber || '').trim().toLowerCase();
    if (awbKey) byParentAwb.set(`${parent}||${awbKey}`, ref);
  });
  return { byParent, byParentAwb };
}
```

- [ ] **Step 3: Fix the `update` action — drop the Sheet write and its required fields**

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

- [ ] **Step 4: Fix the `bulk-update` action — drop the Sheet write and `sheetTab` requirement**

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

- [ ] **Step 5: Fix the `import` action — match against BigQuery, drop the Sheet write, fix the response shape and error copy**

Replace the whole `import` block body from `const { byParent, byParentAwb } = await getSheetIndexFromBq();` through the closing `});` of the response with:

```js
      const norm = (v) => String(v ?? '').trim().toLowerCase();
      const { byParent, byParentAwb } = await getOrderIndexFromBq();
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

        if (ref == null) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'No matching order in Delivery_escalation' });
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

- [ ] **Step 6: Drop the `rowNumber` requirement from `assign`**

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

- [ ] **Step 7: Verify the file still parses and no Sheet reference survives**

Run: `node --check "api/escalation/[action].js"`
Expected: no output (syntax OK).

Run: `grep -n "escalationSheet\|sheetTab\|rowNumber\|orders_sheet_columns" "api/escalation/[action].js"`
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add "api/escalation/[action].js"
git commit -m "feat: drop the Sheet write path from the Escalation API, re-source CSV import matching from BigQuery"
```

---

### Task 3: Delete `escalationSheet.js`

**Files:**
- Delete: `api/_lib/escalationSheet.js`

**Interfaces:**
- Consumes: nothing (Task 2 already removed its only caller).
- Produces: nothing — this file's whole purpose was the Sheet write Task 2 removed.

- [ ] **Step 1: Confirm nothing still requires it**

Run: `grep -rn "escalationSheet" api app scripts --include=*.js`
Expected: no matches (Task 2 already removed the one `require`).

- [ ] **Step 2: Delete the file**

```bash
git rm api/_lib/escalationSheet.js
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete escalationSheet.js, dead since the Escalation API stopped writing to the Sheet"
```

---

### Task 4: `app/escalation/EscalationClient.js` — switch row identity from `sheetTab:rowNumber` to `brand:ticketNumber`

**Files:**
- Modify: `app/escalation/EscalationClient.js`

**Interfaces:**
- Consumes: order shape from Task 1/2 (`order.brand`, `order.ticketNumber`, no `order.rowNumber`/`order.sheetTab`); `import` response shape from Task 2 (`rowNumbers: string[]` shaped `brand:parentOrder`).
- Produces: nothing consumed by a later task in this plan — this is the last code task.

- [ ] **Step 1: Rewrite `rowKey` and its comment**

Replace (originally lines 86-93):
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
// per-row ID (see scripts/sync_delivery_tickets_to_bq.py), unlike parentOrder, which one order
// can share across multiple ticket rows.
function rowKey(o) {
  return `${o.brand}:${o.ticketNumber}`;
}
```

- [ ] **Step 2: Fix `fId` in `OrderRow`**

Replace (originally line 686):
```js
  const fId = `row-${order.sheetTab}-${order.rowNumber}`;
```
with:
```js
  const fId = `row-${order.brand}-${order.ticketNumber}`;
```

- [ ] **Step 3: Drop `rowNumber`/`sheetTab` from the `update` fetch payload**

Replace (originally lines 715-727):
```js
      const res = await fetch('/api/escalation/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rowNumber: order.rowNumber,
          sheetTab: order.sheetTab,
          parentOrder: order.parentOrder,
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
      });
```
with:
```js
      const res = await fetch('/api/escalation/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentOrder: order.parentOrder,
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
      });
```

- [ ] **Step 4: Drop `rowNumber` from the `assign` fetch payload**

Replace (originally line 749):
```js
        body: JSON.stringify({ rowNumber: order.rowNumber, parentOrder: order.parentOrder, agentId: agentId || null }),
```
with:
```js
        body: JSON.stringify({ parentOrder: order.parentOrder, agentId: agentId || null }),
```

- [ ] **Step 5: Fix `handleBulkApply`'s candidate list and filter**

Replace (originally lines 1197-1201):
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

- [ ] **Step 6: Fix `handleImported`'s matching — the response now carries `brand:parentOrder`, not `rowKey`**

Replace (originally lines 1244-1258):
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

- [ ] **Step 7: Verify no stale reference survives and the app still builds**

Run: `grep -n "sheetTab\|order\.rowNumber\|o\.rowNumber\|o?\.rowNumber" app/escalation/EscalationClient.js`
Expected: no matches.

Run: `npm run build`
Expected: build succeeds (exit code 0) — this compiles the whole Next.js app, including this file and Task 2's route handler, catching any syntax/reference error offline. Per this project's no-live-testing rule, do not run `npm run dev` or open the app.

- [ ] **Step 8: Commit**

```bash
git add app/escalation/EscalationClient.js
git commit -m "feat: switch Escalation row identity from Sheet rowNumber to ticketNumber"
```

---

### Task 5: Retire the Sheet-sweep script and its CI schedule

**Files:**
- Delete: `scripts/sync_escalation_sheet_to_bq.py`
- Modify: `.github/workflows/sync-escalation-bq.yml`

**Interfaces:**
- Consumes: nothing (Tasks 1-4 already stopped anything from reading `orders_sheet_columns`).
- Produces: nothing — last task in this plan.

- [ ] **Step 1: Confirm nothing still references the sweep script or its table**

Run: `grep -rln "sync_escalation_sheet_to_bq\|orders_sheet_columns" api app scripts .github --include=*.js --include=*.py --include=*.yml`
Expected: only `scripts/sync_escalation_sheet_to_bq.py` itself and `.github/workflows/sync-escalation-bq.yml` — both handled by this task's remaining steps.

- [ ] **Step 2: Delete the sweep script**

```bash
git rm scripts/sync_escalation_sheet_to_bq.py
```

- [ ] **Step 3: Drop the sweep step from the workflow**

In `.github/workflows/sync-escalation-bq.yml`, delete this step (the last one in the file):
```yaml
      - name: Sweep sheet-computed columns (orders_sheet_columns)
        env:
          GOOGLE_SA_KEY_JSON: ${{ secrets.GOOGLE_SA_KEY }}
          BQ_PROJECT_ID: ${{ secrets.BQ_PROJECT_ID }}
        run: python scripts/sync_escalation_sheet_to_bq.py
```
Rename the workflow's `name:` from `Sync escalation data to BigQuery` to `Rebuild Delivery_escalation` (it now does one job, not two) and shorten the remaining step's own name to match. Result:

```yaml
name: Rebuild Delivery_escalation

on:
  schedule:
    - cron: '0 */2 * * *'   # every 2 hours
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: sync-escalation-bq
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

      - name: Rebuild Delivery_escalation
        env:
          GOOGLE_SA_KEY_JSON: ${{ secrets.GOOGLE_SA_KEY }}
          MYSQL_HOST: ${{ secrets.MYSQL_HOST }}
          MYSQL_USER: ${{ secrets.MYSQL_USER }}
          MYSQL_PASSWORD: ${{ secrets.MYSQL_PASSWORD }}
          MYSQL_DATABASE: ${{ secrets.MYSQL_DATABASE }}
          MYSQL_PORT: ${{ secrets.MYSQL_PORT }}
          BQ_PROJECT_ID: ${{ secrets.BQ_PROJECT_ID }}
        run: python scripts/sync_delivery_tickets_to_bq.py --rebuild-since 2026-07-01
```

- [ ] **Step 4: Verify the YAML parses**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/sync-escalation-bq.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 5: Verify the sync script's own offline self-check still passes (this script is untouched by this task, confirming the deletion above didn't collaterally break its sibling)**

Run: `python scripts/sync_delivery_tickets_to_bq.py --self-check`
Expected: `self-check ok`

- [ ] **Step 6: Commit**

```bash
git add scripts/sync_escalation_sheet_to_bq.py .github/workflows/sync-escalation-bq.yml
git commit -m "chore: retire the Sheet-sweep script and its CI schedule, nothing reads orders_sheet_columns anymore"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the read path (escalationBq.js data model section); Task 2 covers all five write actions in the spec's write-path table; Task 3 covers the escalationSheet.js deletion; Task 4 covers every client-side item in the spec's "Client" subsection including the `handleBulkApply` fix and the `handleImported` matching-granularity note; Task 5 covers the scheduled-jobs section. The spec's "Open items" (tab-wise filtering, Sheet display fields, dropping the BigQuery table) are explicitly deferred, not tasks here.
- **Placeholder scan:** no TBD/TODO; every step has literal code, not a description of code.
- **Type consistency:** `mergeOrderRow`'s output shape (Task 1) is the shape Task 2's `orders`/`export` responses and Task 4's `order.brand`/`order.ticketNumber` reads all assume — checked against each other while writing the plan, no drift.
