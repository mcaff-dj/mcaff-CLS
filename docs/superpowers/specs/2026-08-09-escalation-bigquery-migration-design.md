# Escalation desk on BigQuery — design

Date: 2026-08-09
Status: approved, ready for implementation planning

## Problem

The Escalation desk (`app/escalation/`, `api/escalation/[action].js`) reads its queue by
pulling `A2:Z` from two tabs of a Google Sheet on every page load, and splits its writes
across two stores: order resolutions go back into sheet columns T–W, while assignments and
resolution history go into Postgres (`escalation_lead_assignments`).

Three problems drive the change:

1. **Sheet reads are slow and quota-bound.** Every queue load re-reads ~4,000 rows across
   both tabs, filters them in JavaScript, and does it again on the next refresh.
2. **No analytics.** Escalation data cannot be joined against NDR, RTO, or anything else,
   and there is no SQL surface for trends or dashboards.
3. **No single source of truth.** An order's state is split between the sheet (T–W) and
   Postgres (assignment, resolution, remarks).

## Goal

Move the Escalation desk onto BigQuery: the Google Sheet becomes an ingest-only feed that
syncs into BigQuery on change, and every application read and write happens in BigQuery.
Neither the sheet nor Postgres is written by the app for escalation data any more.

## Scope

**In scope:** the escalation workbook (`1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w`, tabs
`HYPHEN` and `mCaffeine`) and the escalation assignment/resolution data currently in Postgres.

**Out of scope:** the NDR sheet (`12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI`), the RTO
sheet (`1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI`), the agent roster
(`calling_process_agents`), dispositions, agent presence, business hours, and
authentication/permissions. Those stay in Postgres and MySQL: they are shared configuration
used by other processes, not escalation rows.

## Phasing

The original intent was to retire the Google Sheet entirely. That cannot complete in one
step, because what populates the sheet-owned columns of the two tabs is not currently known — it
may be a mix of manual entry, Apps Script, and an external export. Retiring the sheet without
identifying every upstream writer would silently drop data.

**Phase 1 (this spec).** The sheet becomes ingest-only. It is still where the sheet-owned columns
arrive, and it syncs into BigQuery on change. The application reads and writes BigQuery exclusively:
no sheet writes, no Postgres writes for escalation.

**Phase 2 (separate work, once upstream is identified).** Repoint whatever fills the sheet
directly at BigQuery and delete the sheet. This is a loader swap; no application code changes,
because after Phase 1 nothing in the app depends on the sheet except the sync job.

All work below is Phase 1.

## Architecture

```
Sheet edit (sheet-owned columns)
  └─ Apps Script onChange trigger (30s debounce, per-tab)
       └─ POST /api/escalation/sync {tab}          [shared-secret header]
            ├─ read tab A2:Z                        (existing readTabRows)
            ├─ BigQuery load job → escalation.orders_staging
            │    (WRITE_TRUNCATE, NDJSON, multipart upload)
            └─ MERGE staging → escalation.orders
                 · overwrites sheet-owned columns only
                 · never touches agent-owned or assignment columns
                 · row absent from sheet → soft-delete stamp, not DELETE

App (Lambda)
  ├─ reads  → SELECT from escalation.orders
  └─ writes → UPDATE / MERGE on escalation.orders
              + INSERT into escalation.assignment_events
```

### Why load jobs rather than streaming inserts

This is the decision that makes row-level `UPDATE` viable. Rows written through the streaming
API sit in a streaming buffer where `UPDATE`, `DELETE`, and `MERGE` fail with
"would affect rows in the streaming buffer" for up to 90 minutes. Load jobs write directly to
managed storage, so DML against freshly synced rows works immediately. Load jobs are also free,
whereas streaming inserts are billed per byte.

### Why two tables

`escalation.orders` holds mutable current state and is the target of row-level `UPDATE`.

`escalation.assignment_events` is append-only and exists because the Assignments panel reads
assignment *history* — `assignedAt`, `reassignedAwayAt`, `resolvedAt`, `resolution`,
`agentRemarks`. A current-state-only table cannot answer those questions. The Postgres table
being replaced already models history this way (a row is closed by stamping
`reassigned_away_at`, never overwritten), and that behaviour must be preserved.

### Why REST rather than the BigQuery client library

`@google-cloud/bigquery` pulls in a large dependency tree. The Lambda bundle already runs close
to the 6MB payload ceiling, and this repo has an established pattern of talking to Google APIs
over plain `fetch` with a `google-auth-library` JWT — see `api/_lib/escalationSheet.js`,
`api/rto/sheet.js`, and `api/ndr/sheet.js`. The BigQuery integration follows the same pattern.

The existing `GOOGLE_SHEETS_CLIENT_EMAIL` / `GOOGLE_SHEETS_PRIVATE_KEY` service account is
reused, with the `https://www.googleapis.com/auth/bigquery` scope added alongside the existing
spreadsheets scope. That account needs the BigQuery Data Editor and BigQuery Job User roles on
the target project.

## Data model

### Row key

The merge key is `(sheet_tab, parent_order, awb_number)`.

`row_number` is deliberately *not* part of the key. Today `batchUpdateOrders` writes to
`{sheetTab}!T{rowNumber}:W{rowNumber}`, which is only correct while nobody sorts, inserts, or
deletes a row in the sheet. A single sort reattaches every pending resolution to the wrong
order. A business key removes that class of bug permanently. `row_number` is retained as a
plain column for provenance and debugging.

`parent_order` alone is not unique. `getSheetIndex()` already maintains a `parent||awb` index
for exact matching and documents that "the last tab read still wins byParent on a genuine tie".
Including `awb_number` makes the key exact.

The key column is `awb_key`, a generated `LOWER(TRIM(COALESCE(awb_number, '')))`, not the raw
`awb_number`. Two reasons: AWBs arrive from the sheet with inconsistent casing and stray
whitespace, and rows with a blank AWB must still key deterministically rather than on `NULL`.

Because a blank `awb_key` is possible, two sheet rows can still collide on
`(sheet_tab, parent_order, awb_key)`. BigQuery rejects that outright — a MERGE whose source
matches a target row more than once fails with "UPDATE/MERGE must match at most one source row"
and the whole sync aborts. The `USING` clause therefore deduplicates by keeping the lowest
`row_number` per key:

```sql
USING (
  SELECT * FROM `escalation.orders_staging`
  WHERE sheet_tab = @tab
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY sheet_tab, parent_order, awb_key ORDER BY row_number
  ) = 1
) S
```

The sync response reports how many rows were dropped as duplicates, so a sheet developing
genuine key collisions is visible rather than silent.

### `escalation.orders`

Clustered by `(sheet_tab, parent_order)`. Not partitioned — the table holds a few thousand rows,
where partition metadata costs more than it saves.

| Group | Columns | Written by |
|---|---|---|
| Identity | `sheet_tab STRING NOT NULL`, `parent_order STRING NOT NULL`, `awb_number STRING`, `awb_key STRING NOT NULL` | sync (key) |
| Sheet-owned (A–S and Z) | `added_date`, `query_class`, `query_category`, `delivery_partner_name`, `order_date`, `order_month`, `query_date`, `query_month`, `wh_name`, `total_times_consumer_reached`, `delivered_date`, `status_as_per_awb`, `solv_date`, `tat`, `update_from_logistics`, `city`, `state`, `ticket_number` — all `STRING`; plus `row_number INT64` | sync only |
| App-owned | `new_order_id STRING`, `new_awb STRING`, `status STRING`, `notes STRING`, `resolved_at TIMESTAMP`, `resolved_by STRING`, `assigned_to STRING`, `assigned_at TIMESTAMP` | app only |
| Lifecycle | `synced_at TIMESTAMP`, `deleted_from_sheet_at TIMESTAMP` | sync |

Column mapping against the sheet's 26-column layout: `parent_order` (D) and `awb_number` (E) are
the identity columns; columns T–W (`newOrderId`, `awb`, `status`, `notes`) become the app-owned
columns; `ticketNumber` (Z) is sheet-owned; and columns X and Y — carried as `_v1` and `_v2` in
`COLUMNS`, unused by the application — are not carried into BigQuery.

The two ownership groups never overlap. The sync MERGE writes sheet-owned columns and never
mentions app-owned ones; application writes touch app-owned columns and never mention
sheet-owned ones. This is what allows a sync to run while agents are working.

Sheet columns stay `STRING`. The sheet is untyped and dates arrive in whatever format someone
typed. Casting at load time would silently null out malformed values with no signal. A view
applying `SAFE.PARSE_DATE` over the columns that matter serves the analytics use case, keeping
the raw value inspectable when a parse fails.

### `escalation.assignment_events`

Append-only.

```sql
parent_order   STRING
sheet_tab      STRING
awb_number     STRING
email          STRING
event          STRING     -- 'assigned' | 'reassigned_away' | 'unassigned' | 'resolved'
resolution     STRING
agent_remarks  STRING
ts             TIMESTAMP
```

### Soft delete

When a row disappears from the sheet, the MERGE stamps `deleted_from_sheet_at` rather than
deleting the row. A hard delete would destroy agent resolutions the moment someone filters,
trims, or reorganises the sheet. Queue reads filter `deleted_from_sheet_at IS NULL`. A row that
reappears in a later sync has the stamp cleared.

## Sync pipeline

### Apps Script

Checked in as `scripts/escalation_sync.gs` and pasted into the workbook once as an installable
`onChange` trigger. `onChange` is used rather than `onEdit` because it also fires on row
inserts, row deletes, and programmatic writes.

```javascript
function onSheetChange(e) {
  var tab = SpreadsheetApp.getActiveSheet().getName();
  if (tab !== 'HYPHEN' && tab !== 'mCaffeine') return;
  var cache = CacheService.getScriptCache();
  if (cache.get('pending:' + tab)) return;   // a sync is already queued within the window
  cache.put('pending:' + tab, '1', 30);
  Utilities.sleep(30000);                     // coalesce a burst of edits into one sync
  cache.remove('pending:' + tab);
  UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Sync-Secret': SECRET },
    payload: JSON.stringify({ tab: tab }),
    muteHttpExceptions: true,
  });
}
```

The debounce matters: pasting 500 rows fires `onChange` many times, and without coalescing each
one would trigger a full reload of the tab.

### Sync endpoint

`POST /api/escalation/sync` is the only escalation route that is not session-gated, because
Apps Script cannot carry a session cookie. It is gated instead by a constant-time comparison of
the `X-Sync-Secret` header against the `ESCALATION_SYNC_SECRET` environment variable, and it
accepts nothing from the caller but a tab name checked against a fixed allowlist. The request
body carries no data — the endpoint reads the sheet itself — so a leaked secret at worst
triggers a re-read of data the caller cannot see.

The endpoint reuses `readTabRows` from `api/_lib/escalationSheet.js` unchanged, serialises to
NDJSON, submits a load job with `writeDisposition: WRITE_TRUNCATE` and
`sourceFormat: NEWLINE_DELIMITED_JSON` against `escalation.orders_staging`, polls the job to
`DONE`, then runs the MERGE.

### MERGE

```sql
MERGE `escalation.orders` T
USING (SELECT * FROM `escalation.orders_staging` WHERE sheet_tab = @tab) S
ON  T.sheet_tab    = S.sheet_tab
AND T.parent_order = S.parent_order
AND T.awb_number   = S.awb_number
WHEN MATCHED THEN UPDATE SET
  added_date = S.added_date,
  /* … the remaining sheet-owned columns, and only those … */
  row_number = S.row_number,
  synced_at = CURRENT_TIMESTAMP(),
  deleted_from_sheet_at = NULL
WHEN NOT MATCHED BY TARGET THEN
  INSERT (sheet_tab, parent_order, awb_number, /* …A–S… */, row_number, synced_at)
  VALUES (S.sheet_tab, S.parent_order, S.awb_number, /* … */, S.row_number, CURRENT_TIMESTAMP())
WHEN NOT MATCHED BY SOURCE
  AND T.sheet_tab = @tab
  AND T.deleted_from_sheet_at IS NULL
THEN UPDATE SET deleted_from_sheet_at = CURRENT_TIMESTAMP();
```

The `T.sheet_tab = @tab` guard on the `NOT MATCHED BY SOURCE` arm is load-bearing. Without it,
syncing `HYPHEN` soft-deletes every `mCaffeine` row, because they are absent from the source.

### Known ceilings

Both are marked in code with `ponytail:` comments naming the upgrade path.

- **Upload size.** Roughly 4,000 rows across 26 columns is 2–4MB of NDJSON. Multipart upload is
  comfortable to about 10MB; beyond that, switch to a resumable upload or stage the file through
  GCS. This is the same 6MB Lambda payload ceiling that has already caused problems in this repo.
- **Apps Script quota.** `Utilities.sleep(30000)` consumes execution time against the 6-minute
  per-execution and 90-minute daily quotas. At a few hundred edits per day this is comfortable.
  A sheet edited continuously all day should instead set a dirty flag and let a time-driven
  trigger poll it once a minute.

## Application changes

### Reads

Executed through `jobs.query` with `useQueryCache: true`. Expect 1–2s per query. The table is a
few megabytes, so query cost sits well inside the free tier, and the cache makes repeat page
loads free until a write invalidates it.

| Today | After |
|---|---|
| `getEligibleOrders()` — read A2:Z from both tabs, filter in JS | `WHERE LOWER(status_as_per_awb) LIKE '%rto%' AND LOWER(update_from_logistics) LIKE '%rto%' AND COALESCE(status,'') = '' AND deleted_from_sheet_at IS NULL` |
| `getFreshLeads()` | `WHERE LOWER(TRIM(COALESCE(tat,''))) IN ('', 'unresolved', '#n/a') AND deleted_from_sheet_at IS NULL` |
| `getLiveEscalationAssignments()` (Postgres) | `SELECT parent_order, assigned_to FROM orders WHERE assigned_to IS NOT NULL AND resolved_at IS NULL` |
| `getEscalationAssignments()` (Postgres) | pivot `assignment_events` into per-cycle rows, newest first, `LIMIT 5000` — same soft ceiling as today |

The Fresh Leads filter keeps its current semantics: it is driven by `tat` alone, irrespective of
`status` or the RTO columns. The queue filter keeps its current semantics too, including *not*
filtering on `tat` — every pending RTO row carries "Forced to be marked as RTO" there, so gating
the queue on the open-TAT values would empty it.

### Writes

- **`update`** — one `UPDATE escalation.orders SET new_order_id, new_awb, status, notes,
  resolved_at, resolved_by WHERE sheet_tab = @t AND parent_order = @p AND awb_number = @a`,
  followed by one `INSERT` into `assignment_events`.
- **`bulk-update` and `import`** — a single `MERGE … USING UNNEST(@items)`, never a loop.
  Issuing 4,000 individual `UPDATE` statements would exhaust the DML queue; one MERGE is one job.
  This replaces `batchUpdateOrders`.
- **`assign` / unassign** — `UPDATE escalation.orders SET assigned_to, assigned_at`, plus an
  event insert. Reassignment writes a `reassigned_away` event for the outgoing agent before the
  `assigned` event for the incoming one, preserving the cycle model the Postgres implementation
  uses today.
- **`assign-bulk`** — a new action, required by Auto-Assign All. The client currently issues one
  POST per unassigned order in a `Promise.all`, which against BigQuery means thousands of
  concurrent DML statements and a guaranteed failure. The new action accepts
  `{ items: [{ sheetTab, parentOrder, awbNumber, agentId }] }` and applies them as one
  `MERGE … USING UNNEST(@items)` plus one batched event insert. The client calls it once.

Every write path in this desk is therefore bounded to a constant number of BigQuery statements,
regardless of how many rows the user selected.

Two costs of the row-level UPDATE model, accepted rather than designed around:

- **Write latency of roughly 2–5 seconds.** The client already holds the row in state, so each
  action applies optimistically and reconciles against the response. A failed write reverts the
  row and surfaces an error. No spinner blocks the queue.
- **DML concurrency.** BigQuery runs about 20 concurrent mutating statements per table and
  queues the remainder. Ten agents resolving orders is far below that. Marked with a
  `ponytail:` comment; if it ever binds, the upgrade is a short write-batching queue in front
  of the endpoint.

### Client

`app/escalation/EscalationClient.js` changes in two places:

- The assign POST currently sends `{ rowNumber, parentOrder, agentId }`. It sends
  `{ sheetTab, parentOrder, awbNumber, agentId }` instead. The row object rendered in the queue
  already carries both new fields. `bulk-update` items gain `awbNumber` for the same reason.
- Auto-Assign All stops issuing one request per row and makes a single `assign-bulk` call.
- Write actions apply optimistically and revert on error, to absorb BigQuery write latency.
- Resolution copy changes: the success toast currently reads "synced to sheet", which stops
  being true.

## Migration

A one-off script, `scripts/migrate_escalation_to_bq.js`:

1. Create the dataset and both tables if absent.
2. Full load of both tabs, including existing columns T–W into the app-owned columns. Those are
   real historical resolutions written by agents, not sheet-sourced data, and must not be lost.
3. Copy `escalation_lead_assignments` from Postgres into `assignment_events`, and stamp
   `assigned_to` / `assigned_at` onto rows whose assignment is still live.
4. Reconcile: compare row counts per tab, count of rows with a non-empty `status` in the sheet
   versus BigQuery, and live assignment count in Postgres versus BigQuery. Print a diff and exit
   non-zero on any mismatch.

`escalation_lead_assignments` is **not** dropped. It remains in place, unread, as the rollback
path for the first weeks of operation. Dropping it is a later cleanup commit.

## Error handling

A sync failure returns a non-2xx response and logs the BigQuery job error. Apps Script records
it (`muteHttpExceptions: true`) and the next sheet edit retries. Because the load is
`WRITE_TRUNCATE` and the MERGE is idempotent, a retry is always safe and a partially completed
sync leaves no inconsistent state.

An agent write failure surfaces as an error in the UI and reverts the optimistic row update.
Each action is a single statement, so no write lands half-applied.

## Testing

Per the project's no-live-testing rule, verification is a single `assert`-based self-check,
`scripts/test_escalation_bq.js`, with no test framework and no live BigQuery calls:

- A sheet row round-trips through the NDJSON mapping with all 26 columns in order.
- The MERGE builder emits only sheet-owned columns in its `UPDATE SET` clause. The test asserts
  that `status`, `notes`, `assigned_to`, `new_order_id`, `new_awb`, `resolved_at`, and
  `resolved_by` never appear. This is the check that catches a sync silently wiping agent work.
- The `WHEN NOT MATCHED BY SOURCE` arm carries the `sheet_tab = @tab` guard.
- The bulk builder emits one MERGE for N items rather than N statements.
- The queue and fresh-leads predicates match the current JavaScript filter behaviour against a
  fixture of representative rows, including the "Forced to be marked as RTO" TAT case.

## File-by-file

| File | Change |
|---|---|
| `api/_lib/bigquery.js` | New. JWT auth, `query()`, `loadJob()`, job polling. REST only, roughly 100 lines. |
| `api/_lib/escalationBq.js` | New. Table DDL, `syncTab()`, and drop-in replacements for every `escalationSheet` and escalation-related `db` function. |
| `api/_lib/escalationSheet.js` | Reduced to `readTabRows`, `readAllRows`, and `COLUMNS`. `updateOrder`, `batchUpdateOrders`, and `getSheetIndex` are deleted. |
| `api/escalation/[action].js` | Swap imports to `escalationBq`. Add the `sync` action with its own secret gate, bypassing the session check. |
| `api/_lib/db.js` | Remove the six escalation functions from exports. Leave the `escalation_lead_assignments` DDL and table in place. |
| `app/escalation/EscalationClient.js` | Assign POST sends `sheetTab` + `awbNumber`; write actions become optimistic. |
| `scripts/escalation_sync.gs` | New. Apps Script source, checked in for review and re-pasting. |
| `scripts/migrate_escalation_to_bq.js` | New. One-off backfill and reconciliation. |
| `scripts/test_escalation_bq.js` | New. Self-check described above. |

## Configuration

New environment variables:

| Name | Purpose |
|---|---|
| `BQ_PROJECT_ID` | Target GCP project for the dataset and jobs. |
| `BQ_DATASET` | Dataset name, defaulting to `escalation`. |
| `ESCALATION_SYNC_SECRET` | Shared secret checked against the `X-Sync-Secret` header on the sync endpoint. |

Existing `GOOGLE_SHEETS_CLIENT_EMAIL` and `GOOGLE_SHEETS_PRIVATE_KEY` are reused. The service
account needs BigQuery Data Editor and BigQuery Job User on `BQ_PROJECT_ID`, in addition to its
existing Editor access on the escalation workbook.
