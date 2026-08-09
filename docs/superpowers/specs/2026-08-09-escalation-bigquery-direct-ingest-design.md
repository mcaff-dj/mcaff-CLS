# Escalation on BigQuery, direct ingest — design

Date: 2026-08-09
Status: awaiting approval

Supersedes [`2026-08-09-escalation-bigquery-migration-design.md`](2026-08-09-escalation-bigquery-migration-design.md),
which is left in place unchanged for reference. That spec assumed the Google Sheet was the only
ingest surface. It is not: the sheet's largest column block already comes from MySQL through a
scheduled job in this repo, so tickets can be written to BigQuery directly instead of being
round-tripped through the sheet.

## What changed since the first spec

Tracing the sheet's writers turned up four of them, not one:

| Cols | Writer | Mechanism |
|---|---|---|
| A:K, Z | `scripts/sync_delivery_tickets_to_sheet.py` | GitHub Actions cron `0 */2 * * *`. Reads MySQL `PEP_CLS.hyphen_tickets` / `mcaff_tickets`; AWB gaps filled from `mcaff_prod.Item_level_data`. Column Z is a synthetic ticket-number dedup key. |
| L:P | The sheet itself | Spreadsheet formulas. The same job drags them down into appended rows. |
| Q:S | An external logistics pipeline | Not in this repo. Cadence unknown. |
| T:W | The Escalation app | The writer this migration removes. |

Two consequences killed parts of the first design:

1. **Apps Script triggers do not fire for Sheets API writes.** The 2-hourly Python job writes
   through the API, so the `onChange` trigger the first spec relied on would never see the
   largest source of new rows.
2. **A:K never needed the sheet.** The job holds those rows as Python objects straight out of
   MySQL and then writes them to Sheets purely so the app can read them back. BigQuery removes
   the reason for that round trip.

What has *not* changed: L:P are formulas whose definitions live in the spreadsheet, and Q:S comes
from a pipeline nobody has traced. Those columns still have to come out of the sheet.

## Goal

BigQuery becomes the Escalation desk's only store. Tickets are written to it directly from MySQL.
The sheet is demoted to a formula-evaluation surface whose computed columns are swept back into
BigQuery. The app reads and writes BigQuery exclusively.

## Scope

**In scope:** the escalation workbook (`1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w`, tabs
`HYPHEN` and `mCaffeine`), the ticket sync job that feeds it, and the escalation
assignment/resolution data currently in Postgres.

**Out of scope:** the NDR and RTO sheets, the agent roster, dispositions, presence, business
hours, and auth. Those stay where they are.

**Deferred at the user's request:** the trigger and cadence for the sheet sweep (the user will
supply the logic), and any investigation of the logistics pipeline behind Q:S.

## Architecture

Three writers, each owning a disjoint set of columns. No column has two authorities.

```
MySQL PEP_CLS.hyphen_tickets / mcaff_tickets
  │
  ├─ sync_delivery_tickets_to_sheet.py   [EXISTING, UNCHANGED]
  │    └──> Sheet  HYPHEN / mCaffeine   A:K + Z        [formula engine only]
  │              │
  │              │  L:P recalculate · logistics pastes Q:S
  │              ▼
  │        sync_escalation_sheet_to_bq.py   [NEW]
  │              └──> BigQuery  escalation.orders   L:S only
  │
  └─ sync_delivery_tickets_to_bq.py      [NEW]
       └──> BigQuery  escalation.orders   A:K + ticket_number   [AUTHORITATIVE]

App (Lambda) ──> BigQuery  escalation.orders  T:W equivalents + assignment
             ──> BigQuery  escalation.assignment_events
```

The sheet still receives A:K because the L:P formulas need a row to compute against and the
logistics pipeline needs a row to paste onto. It is no longer read by the application.

### Two jobs, not one modified job

`sync_delivery_tickets_to_sheet.py` is **not modified**. The BigQuery load is a separate script
with a separate workflow. Each job has exactly one destination, so a BigQuery outage cannot break
the sheet write that keeps the formulas alive, and vice versa. It also means the existing job —
which has accumulated real operational knowledge about formula dragging, filter conflicts, and
column-B row anchoring — keeps working exactly as it does today.

The new script does not duplicate that job's query logic. It imports it:

```python
import sync_delivery_tickets_to_sheet as tickets

rows = tickets.fetch_today_delivery_tickets(table, since=since)
tickets.fill_missing_awb(rows)
```

Those functions are pure MySQL reads with no sheet side effects, and the old script guards its
entry point with `if __name__ == "__main__"`, so importing it runs nothing. One definition of
"which tickets count", two consumers, zero edits to the existing file.

### Ingest lives in Python, not the API

All ingest is batch work that already has a home: `scripts/` has the MySQL access, the Sheets
helpers, and the GitHub Actions runners. `scripts/lib.py` also already mints its own Google JWT
and calls Google REST endpoints directly ([`_get_token`](../../../scripts/lib.py#L78)), so a
BigQuery helper there is a thin addition with no new pip dependency.

Putting ingest in Python deletes four things the first spec needed: the `/api/escalation/sync`
endpoint, the `ESCALATION_SYNC_SECRET` shared secret, the unauthenticated route carve-out in the
handler, and the Apps Script trigger. The Node side is left with only what a request path
genuinely needs — reads and writes.

### Why the sheet write stays

Dual-writing looks redundant until you ask what happens without it. The sheet write is what keeps
`status_as_per_awb` (N) and `tat` (P) alive, and those two are the RTO queue's own filter
predicate. Drop the sheet write and the queue goes empty. The sheet is not being kept out of
caution; it is currently the only implementation of five columns.

## Data model

Unchanged from the first spec except where noted.

### Table inventory

**Both brands share one table.** There is no `orders_hyphen` / `orders_mcaffeine` split, and no
per-brand dataset. `escalation.orders` holds every row from both tabs, separated only by the
`brand` column, whose value is the literal `HYPHEN` or `mCaffeine` — the same strings the sheet
tabs and the `hyphen_tickets` / `mcaff_tickets` MySQL mapping already use, so nothing has to
translate them.

Three tables exist in total, and each earns its place:

| Table | Rows | Why it is separate |
|---|---|---|
| `escalation.orders` | one per order, both brands | The desk's current state. Everything the queue renders. |
| `escalation.assignment_events` | one per agent action | Assignment *history*. An order reassigned three times has three cycles with their own timestamps; the Assignments panel reads them per cycle. A single row per order cannot represent that. |
| `escalation.orders_staging` | transient | The load-job landing zone for the sheet sweep, truncated on every run. Never read by the application. Required because a load job cannot MERGE — it can only write a whole table. |

### Row key

`(brand, parent_order, awb_key)`, where `awb_key` is `LOWER(TRIM(COALESCE(awb_number, '')))`.

The column is named `brand`, not `sheet_tab` — the ticket loader has no sheet in its path, so
naming it after a spreadsheet tab would be misleading. Values are `HYPHEN` and `mCaffeine`. The
Node layer maps `brand` back to the `sheetTab` key in the order objects it returns, so
`app/escalation/EscalationClient.js` and its `rowKey()` are untouched by the rename.

`ticket_number` is carried as a column and is unique where present, but it is **not** the key:
sheet rows predating the ticket job have a blank column Z, and those rows must still be
identifiable. One key that works for every row beats two key paths.

`row_number` is a nullable provenance column set only by the sheet sweep. Loader-inserted rows
have no sheet row to record.

### `escalation.orders`

Clustered by `(brand, parent_order)`. Not partitioned.

| Group | Columns | Written by |
|---|---|---|
| Identity | `brand`, `parent_order`, `awb_number`, `awb_key` | whichever writer inserts the row first |
| Ticket (A:K, Z) | `added_date`, `query_class`, `query_category`, `delivery_partner_name`, `order_date`, `order_month`, `query_date`, `query_month`, `wh_name`, `ticket_number` | ticket loader |
| Sheet-computed (L:S) | `total_times_consumer_reached`, `delivered_date`, `status_as_per_awb`, `solv_date`, `tat`, `update_from_logistics`, `city`, `state` | sheet sweep |
| App (T:W + assignment) | `new_order_id`, `new_awb`, `status`, `notes`, `resolved_at`, `resolved_by`, `assigned_to`, `assigned_at` | app |
| Lifecycle | `synced_at`, `ticket_loaded_at`, `deleted_from_sheet_at`, `row_number` | ingest |

All text columns are `STRING`. The sheet is untyped and dates arrive as whatever was typed;
casting at load would silently null out malformed values. A view applying `SAFE.PARSE_DATE`
serves analytics while keeping the raw value inspectable.

Columns X and Y (`_v1`, `_v2` in `escalationSheet.COLUMNS`) are unused and not carried across.

### `escalation.assignment_events`

Append-only, both brands in the one table like `orders`:

```sql
parent_order   STRING NOT NULL
brand          STRING              -- 'HYPHEN' | 'mCaffeine'
awb_key        STRING
email          STRING
event          STRING NOT NULL     -- 'assigned' | 'reassigned_away' | 'unassigned' | 'resolved'
resolution     STRING
agent_remarks  STRING
ts             TIMESTAMP NOT NULL
```

It replaces the Postgres `escalation_lead_assignments` table and preserves its cycle model: a
cycle is closed by writing a `reassigned_away` event, never by overwriting the previous one.
`getEscalationAssignments()` rebuilds the panel's rows from these events; `assigned_to` on
`orders` answers "who has it right now" without scanning the log.

## Ingest path A — ticket loader

`scripts/sync_delivery_tickets_to_bq.py`, new, running on its own GitHub Actions schedule. It
reuses the existing job's MySQL functions by import and writes ticket-owned columns to BigQuery:

```sql
MERGE `escalation.orders` T
USING UNNEST(@items) S
ON  T.brand = S.brand AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key
WHEN MATCHED THEN UPDATE SET
  added_date = S.added_date, /* …ticket-owned columns only… */
  ticket_number = S.ticket_number,
  ticket_loaded_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED BY TARGET THEN INSERT (…) VALUES (…)
```

**Dedup is independent of the sheet.** The existing job dedups against column Z; this one dedups
against `escalation.orders.ticket_number`, so neither job can starve the other. The MERGE is
idempotent on top of that, which makes a re-run — after a failure, or with `--since` to backfill a
missed day — always safe rather than duplicating rows.

The two jobs are unordered with respect to each other. A row can reach BigQuery before the sheet
or after it, and either way converges: the loader owns A:K and the sweep owns L:S, so whichever
arrives second fills in the other half of the row rather than fighting over it.

The `--since YYYY-MM-DD` and `--dry-run` flags mirror the existing job's, so the same
operational habits apply to both.

Schedule: `0 */2 * * *`, matching the existing ticket job. There is no reason for the two to
drift apart — they read the same MySQL rows on the same definition of "today".

## Ingest path B — sheet sweep

A new script, `scripts/sync_escalation_sheet_to_bq.py`, reads a tab's `A2:Z` and MERGEs into
`escalation.orders`. Its two arms differ, and the difference is the whole design:

- **Matched** — updates the sheet-computed columns L:S, plus `row_number` and `synced_at`. It
  does **not** touch ticket-owned columns, so it can never overwrite loader data with a stale
  sheet value.
- **Not matched by target** — inserts the row with all its sheet columns, ticket columns
  included. This is what backfills the thousands of legacy rows predating the ticket job, and
  what repairs any row whose loader MERGE failed.
- **Not matched by source** — soft-deletes, stamping `deleted_from_sheet_at`, scoped by
  `T.brand = @brand`. Without that guard, sweeping HYPHEN soft-deletes every mCaffeine row. Rows
  are never hard-deleted: a hard delete would destroy agent resolutions the moment someone
  filters or trims the sheet. A row that reappears has its stamp cleared.

The source is deduplicated before the MERGE — BigQuery rejects a MERGE whose source matches a
target row more than once, and two rows can legitimately share a key when the AWB is blank:

```sql
USING (
  SELECT * FROM `escalation.orders_staging`
  WHERE brand = @brand
  QUALIFY ROW_NUMBER() OVER (PARTITION BY brand, parent_order, awb_key ORDER BY row_number) = 1
) S
```

The run reports how many rows it dropped as duplicates, so a sheet developing genuine key
collisions is visible rather than silent.

**Load jobs, never streaming inserts.** Rows written by the streaming API sit in a buffer where
`UPDATE`/`MERGE` fails for up to 90 minutes, which would break every application write. Load jobs
write straight to managed storage, and are free.

### Trigger — deferred

The sweep ships as a CLI (`python scripts/sync_escalation_sheet_to_bq.py --tab HYPHEN`) and a
`workflow_dispatch` GitHub Actions job, both fully functional. No schedule is committed, because
the user has reserved that decision. Adding one later is a `schedule:` block in the workflow and
nothing else.

Until a schedule exists, the sweep must be run manually for the queue to see formula or logistics
changes. That is a real operational gap, stated here so it is a choice rather than a surprise.

## Application layer

The Node side shrinks to reads and writes. No sync endpoint, no shared secret, no Apps Script.

### Reads

Executed through `jobs.query` with `useQueryCache: true`, roughly 1–2s.

| Today | After |
|---|---|
| `getEligibleOrders()` — read A2:Z both tabs, filter in JS | `WHERE LOWER(status_as_per_awb) LIKE '%rto%' AND LOWER(update_from_logistics) LIKE '%rto%' AND COALESCE(status,'') = '' AND deleted_from_sheet_at IS NULL` |
| `getFreshLeads()` | `WHERE LOWER(TRIM(COALESCE(tat,''))) IN ('', 'unresolved', '#n/a') AND deleted_from_sheet_at IS NULL` |
| `getLiveEscalationAssignments()` (Postgres) | `SELECT parent_order, assigned_to FROM orders WHERE assigned_to IS NOT NULL AND resolved_at IS NULL` |
| `getEscalationAssignments()` (Postgres) | pivot `assignment_events` into per-cycle rows, newest first, `LIMIT 5000` |

Both filters keep their current semantics exactly, including the queue *not* filtering on `tat` —
every pending RTO row carries "Forced to be marked as RTO" there, so gating the queue on the
open-TAT values would empty it.

### Writes

- `update` — one `UPDATE` on the row key, plus one `assignment_events` insert.
- `bulk-update` and `import` — one `MERGE … USING UNNEST(@items)`, never a loop.
- `assign` / unassign — `UPDATE` plus an event insert. Reassignment writes `reassigned_away` for
  the outgoing agent before `assigned` for the incoming one, preserving the Postgres cycle model.
- `assign-bulk` — a new action. Auto-Assign All currently fires one POST per unassigned order in a
  `Promise.all`; against BigQuery that is thousands of concurrent DML statements and a guaranteed
  failure. One MERGE, one client call.

Every write path is bounded to a constant number of statements regardless of selection size.

Accepted costs, unchanged from the first spec: writes take roughly 2–5s, so the client applies
them optimistically and reverts on error; and BigQuery runs about 20 concurrent mutating
statements per table, which is far above this desk's load.

### Client

- Assign and update POSTs send `{ sheetTab, parentOrder, awbNumber }` instead of `rowNumber`.
- Auto-Assign All makes a single `assign-bulk` call.
- Write actions apply optimistically and revert on failure.
- The resolution toast stops saying "synced to sheet".

## Migration

`scripts/migrate_escalation_to_bq.py`, run once:

1. Create the dataset and tables.
2. Sweep both tabs — this loads every existing row, including the legacy ones and the historical
   resolutions sitting in columns T–W, which are real agent work and must not be lost.
3. Copy `escalation_lead_assignments` from Postgres into `assignment_events`, stamping
   `assigned_to` / `assigned_at` onto rows whose assignment is still live.
4. Reconcile: row counts per tab, resolved-row counts sheet versus BigQuery, live assignment
   counts Postgres versus BigQuery. Print a diff, exit non-zero on mismatch.

`escalation_lead_assignments` is not dropped. It stays unread as the rollback path, to be removed
in a later cleanup.

## Testing

Per the project's no-live-testing rule, every check is offline with stubbed transport. No test
touches real BigQuery, the real sheet, or the real database.

- `scripts/test_escalation_bq.js` — Node side. Query-parameter encoding, load-job configuration,
  row mapping, and the predicate parity of both queue filters against a fixture.
- `scripts/test_escalation_ingest.py` — Python side, in the style of
  `sync_delivery_tickets_to_sheet.py`'s existing `--self-check` ([line 256](../../../scripts/sync_delivery_tickets_to_sheet.py#L256)):
  plain `assert`, no framework, no network. Row mapping, `awb_key` normalisation, and
  duplicate-key counting.

Two assertions carry most of the weight, because they catch the failures that would silently
destroy data:

- The **sweep MERGE's matched arm names no ticket-owned or app-owned column.** If it ever did, one
  sweep would overwrite loader data or wipe agent resolutions.
- The **loader MERGE names no sheet-computed or app-owned column.**

## File-by-file

| File | Change |
|---|---|
| `scripts/bq_lib.py` | **New.** BigQuery over REST, reusing `lib._get_token` with the bigquery scope. `query()`, `load_ndjson()`, job polling. No new pip dependency. |
| `scripts/escalation_bq_schema.py` | **New.** Table DDL, column-ownership lists, and the row mapping shared by the loader, the sweep, and the migration. One definition, three consumers. |
| `scripts/sync_delivery_tickets_to_sheet.py` | **Unchanged.** Keeps writing the sheet exactly as today. Imported by the new loader for its MySQL functions. |
| `scripts/sync_delivery_tickets_to_bq.py` | **New.** The ticket loader. MySQL → BigQuery, dedup on `ticket_number`, `--since` and `--dry-run` flags. |
| `scripts/sync_escalation_sheet_to_bq.py` | **New.** The sheet sweep. CLI plus `workflow_dispatch`; no schedule. |
| `scripts/migrate_escalation_to_bq.py` | **New.** One-off backfill and reconciliation. |
| `scripts/test_escalation_ingest.py` | **New.** Offline self-check for the Python side. |
| `.github/workflows/sync-escalation-bq.yml` | **New.** Runs both new Python jobs. Loader on a schedule; sweep `workflow_dispatch` only until the user supplies the cadence. |
| `.github/workflows/sync-delivery-tickets.yml` | **Unchanged.** |
| `api/_lib/bigquery.js` | **New.** BigQuery REST transport for the request path. |
| `api/_lib/escalationBq.js` | **New.** Reads and writes. No sync code. |
| `api/_lib/escalationSheet.js` | **Delete.** Nothing in the API reads or writes the sheet any more. |
| `api/escalation/[action].js` | **Modify.** Point at `escalationBq`; add `assign-bulk`. |
| `api/_lib/db.js` | **Modify.** Remove the six escalation functions from exports; export `pgSql` for the migration. Table DDL stays. |
| `app/escalation/EscalationClient.js` | **Modify.** Payload keys, single-call auto-assign, optimistic writes, toast copy. |
| `scripts/test_escalation_bq.js` | **New.** Offline self-check for the Node side. |

## Configuration

| Name | Where | Purpose |
|---|---|---|
| `BQ_PROJECT_ID` | Lambda + Actions | Target GCP project. |
| `BQ_DATASET` | Lambda + Actions | Dataset name, default `escalation`. |

Node reuses `GOOGLE_SHEETS_CLIENT_EMAIL` / `GOOGLE_SHEETS_PRIVATE_KEY`; Python reuses the
`GOOGLE_SA_KEY` Actions secret. Both service accounts need **BigQuery Data Editor** and
**BigQuery Job User** on `BQ_PROJECT_ID`.

No `ESCALATION_SYNC_SECRET` — the endpoint that needed it no longer exists.

## Open items

- **Sweep schedule.** Deferred to the user. Until set, the sweep runs manually.
- **Logistics pipeline behind Q:S.** Untraced, explicitly out of scope for now.
- **Retiring the sheet.** Requires re-expressing the five L:P formulas as SQL and re-homing Q:S.
  `city` and `state` already have a known MySQL source
  (`Item_level_data.Shipping_Address_City` / `_State` by `Tracking_Number`, as
  `scripts/gen_geo_insights.py` does), so those two are the easy first step whenever that work
  starts.
