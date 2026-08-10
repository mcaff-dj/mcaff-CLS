# Escalation RTO Queue: Sheet → BigQuery + Postgres hybrid — design

Date: 2026-08-10
Status: awaiting approval

Supersedes [`2026-08-09-escalation-bigquery-direct-ingest-design.md`](2026-08-09-escalation-bigquery-direct-ingest-design.md)
for the application layer. That spec assumed BigQuery DML (`UPDATE`/`MERGE`/`DELETE`) was available.
It is not, on this project: BigQuery returns

```
403 Billing has not been enabled for this project. DML queries are not allowed in the free tier.
```

confirmed live against the actual `sheetdata-501810` project (see `scripts/sync_delivery_tickets_to_bq.py`'s
`--rebuild-since`, added after this was discovered — it works around the same restriction for
`total_times_user_reached` by truncate-rebuilding instead of `MERGE`ing). That 403 breaks every write
path the 08-09 spec proposed for the app (`update`, `bulk-update`, `assign`, `assign-bulk`) and both its
ingest MERGEs. The data model (`escalation.orders`, `assignment_events`, column-ownership-by-writer) is
still sound reasoning; the mechanism for mutating it is not, on a project without billing enabled.

This spec keeps the reasoning, changes the mechanism: BigQuery becomes read-only from the app's
perspective (populated by scheduled truncate-rebuild jobs, never DML), and the app's own mutable
state (assignment + resolution) moves to Postgres, which already does real transactional writes today
with no free-tier restriction.

## Goal

Replace the Sheet as the RTO Action Queue's read source with BigQuery. Do not change how the Sheet
itself works — its four existing writers, its formulas, and everything that reads or writes it today
keep doing exactly that. The only thing that changes is where the **app** reads from and where the
app's **own** state (other than the T:W sheet cells, which it keeps dual-writing) lives.

## Scope

**In scope:** the escalation workbook's read path for the app (`app/escalation/EscalationClient.js` via
`api/escalation/[action].js`), and the assignment/resolution data currently split across Postgres and
Sheet columns T:W.

**Out of scope:** NDR, RTO-CRM (a separate feature/sheet, not to be confused with this "RTO Queue"),
agent roster, dispositions, presence, business hours, auth. The Sheet's own formulas (L:P) and the
external logistics pipeline (Q:S) are untouched and untraced, same as the 08-09 spec.

**Hard constraint from this conversation:** do not touch the Sheet. Concretely:

- `scripts/sync_delivery_tickets_to_sheet.py` — unchanged, keeps writing A:K + Z on its existing schedule.
- Sheet formulas L:P — unchanged.
- External logistics pipeline Q:S — unchanged, still pastes into the same cells.
- The app's write to T:W — **kept**, dual-written alongside the new Postgres write (see below). The
  Sheet must look exactly as it does today to anyone still viewing it directly.

## Architecture

```
MySQL PEP_CLS.hyphen_tickets/mcaff_tickets
  └─ sync_delivery_tickets_to_bq.py [EXISTING — production trigger changes, see below]
       └─> BigQuery escalation.orders_ticket_columns   (truncate-rebuild, every 2h)

Sheet HYPHEN/mCaffeine, READ ONLY (L:S — formulas + logistics paste)
  └─ sync_escalation_sheet_to_bq.py [NEW]
       └─> BigQuery escalation.orders_sheet_columns     (truncate-rebuild, every 2h)

App (Lambda)
  ├─ READS:  BigQuery (orders_ticket_columns JOIN orders_sheet_columns) + Postgres (current state)
  └─ WRITES: Postgres escalation_lead_assignments, extended   (real UPDATE/INSERT)
             + Sheet T:W, dual-written via the existing escalationSheet.batchUpdateOrders
               (unchanged code, now fed row_number from BigQuery instead of a live Sheets read)
```

No BigQuery DML anywhere, ever. BigQuery is written to only by scheduled load jobs
(`WRITE_TRUNCATE`), which are atomic on success and leave the existing table untouched on failure.

## Data model

### `escalation.orders_ticket_columns` (BigQuery)

Already exists — physical table name stays `Delivery_escalation`, not renamed; this doc calls it
`orders_ticket_columns` only to name its role. Built and backfilled this session, no schema change.

`brand, parent_order, awb_number, added_date, query_class, query_category,
delivery_partner_name, order_date, order_month, query_date, query_month, wh_name,
ticket_number, total_times_user_reached, loaded_at`

**Production trigger changes.** `total_times_user_reached` needs periodic recomputation even for
already-loaded rows (a new same-AWB ticket should raise the count on old rows too) — incremental
append-only sync can't do that; a value computed once at insert time goes stale. The proven
`--rebuild-since` truncate-rebuild becomes the sole production path, on a schedule (every 2h, matching
the existing ticket-sync cadence). The incremental `sync_brand`/dedup-by-`ticket_number` append path is
retired — two divergent code paths maintaining the same table is exactly the kind of dead weight this
change should remove, not preserve alongside the new path.

### `escalation.orders_sheet_columns` (BigQuery, NEW)

Swept from the Sheet's L:S columns by `sync_escalation_sheet_to_bq.py`, truncate-rebuilt every 2h
(matching the ticket loader's cadence):

`brand, parent_order, awb_key, row_number, delivered_date, status_as_per_awb, solv_date, tat,
update_from_logistics, city, state, deleted_from_sheet_at, synced_at`

`awb_key = LOWER(TRIM(COALESCE(awb_number, '')))`, the same normalization the 08-09 spec used, needed
because two sheet rows can legitimately share a key when the AWB is blank.

Deliberately **not** swept: the Sheet's own `totalTimesConsumerReached` (column L). `orders_ticket_columns`
already carries a better-sourced version of that exact metric — computed straight from MySQL ticket
data, not a sheet formula scanning sheet rows — so sweeping the Sheet's copy would just be a second,
worse-sourced number for the same concept.

`status_as_per_awb` (N) and `update_from_logistics` (Q) **are** the RTO queue's filter predicate and
their logic isn't ours to reimplement (a Sheet formula and an untraced external pipeline,
respectively) — this table has to keep sweeping them regardless of anything else in this design.

`row_number` + `brand` (mapped to `sheetTab`) are carried specifically so the app's dual-write to T:W
can address the right cell without a live Sheets read at write time.

Read at query time via `JOIN` on `brand, parent_order` and
`LOWER(TRIM(COALESCE(orders_ticket_columns.awb_number, ''))) = orders_sheet_columns.awb_key` —
`orders_ticket_columns` is not changed to carry a physical `awb_key` column; the normalization is
applied inline in the join instead, since only `orders_sheet_columns` needs it as a dedup key at
write time.

### Postgres — `escalation_lead_assignments`, extended

New columns, alongside the existing assignment-cycle columns, keyed by `(brand, parent_order)`:

`status, notes, new_order_id, new_awb, resolved_at, resolved_by`

These are the T:W equivalents. Postgres becomes the single source of truth the app reads current
state from; the Sheet's T:W cells become a mirror the app also writes to, not a source of truth.

## Application layer

### Reads (`orders` action, and `export`)

1. Query BigQuery: `orders_ticket_columns JOIN orders_sheet_columns ON (brand, parent_order, awb_key)`,
   filtered by the RTO predicate — `LOWER(status_as_per_awb) LIKE '%rto%' AND LOWER(update_from_logistics)
   LIKE '%rto%' AND deleted_from_sheet_at IS NULL`. Same predicate as today, still not filtered on `tat`
   (every pending RTO row carries "Forced to be marked as RTO" there — gating on open-TAT would empty
   the queue, same reasoning as the 08-09 spec).
2. Fetch current resolution/assignment state from Postgres for the matching `parent_order`s.
3. Drop rows already resolved (this filter moves from a Sheet-column check to a Postgres lookup, since
   resolution state no longer lives in the row BigQuery returns).
4. Merge: BigQuery row + Postgres row, keyed by `parent_order`.

`assign` (GET) already returns `{parentOrder: {agentId}}`, which `EscalationClient.js` joins
client-side — extending it to also carry `status, notes, newOrderId, newAwb, resolvedAt, resolvedBy`
reuses that existing join pattern instead of inventing a new one.

### Writes

| Action | Target(s) |
|---|---|
| `update` (single resolve) | Postgres `UPDATE` **+** `escalationSheet.batchUpdateOrders` (dual-write T:W), using `row_number` carried from the BigQuery read |
| `bulk-update` | Same, batched |
| `import` (CSV) | Matches rows against BigQuery (not a live Sheet read) to find `row_number`, then same dual-write |
| `assign` | Postgres only — assignment was never a Sheet column, no dual-write needed |
| `assign-bulk` *(new)* | Postgres only, single statement, replaces today's one-`POST`-per-row `Promise.all` |

`escalationSheet.js` is **not deleted**. Its write function (`batchUpdateOrders`) is kept exactly as-is.
Its read functions (`getEligibleOrders`, `getFreshLeads`, live-Sheet row matching for CSV import) are
removed — BigQuery replaces those reads, and dead code shouldn't be kept "just in case."

### Client (`EscalationClient.js`)

- Write payloads carry `{brand, parentOrder, awbNumber}` instead of `{sheetTab, rowNumber}` for the
  *read* side's identity; the row's own `rowNumber` (now sourced from BigQuery) still travels with it
  for the *sheet dual-write* to address the right cell.
- Auto-Assign All becomes one `assign-bulk` call.
- Resolution fields (`status`, `notes`, etc.) are read from the assignments map instead of the row
  itself.
- Optimistic UI stays as today's pattern; write latency changes from Sheets' 2-5s to Postgres's
  sub-second.

## Migration

Lighter than the 08-09 spec's, since only resolution history needs moving — assignments are already in
Postgres, ticket columns are already populated, and sheet columns get created by the sweep's first run
(truncate-rebuild *is* the backfill for that table, no separate script needed):

1. `ALTER TABLE escalation_lead_assignments ADD COLUMN status, notes, new_order_id, new_awb,
   resolved_at, resolved_by`.
2. One-off script (`scripts/migrate_escalation_resolutions_to_postgres.py`) reads the Sheet's current
   T:W columns and writes them into those new Postgres columns, keyed by `parent_order` — preserves
   historical resolutions before relying on Postgres as the read source.
3. Reconciliation: resolved-row counts, Sheet vs Postgres, before cutover. Print a diff; do not proceed
   silently on a mismatch.
4. Cutover: point `api/escalation/[action].js` at BigQuery + Postgres. No dual-write *transition*
   period is needed for reads (Postgres is made authoritative by step 2 before the switch) — the
   ongoing dual-write is only ever for the Sheet's T:W cells, which continues indefinitely per the
   "don't touch the Sheet" constraint.

## Testing

Per this project's no-live-testing rule: offline only, no real BigQuery/Sheet/Postgres/DB touch.

- `scripts/test_escalation_sheet_sweep.py` — row mapping, `awb_key` normalization, duplicate-key
  handling before the truncate-rebuild — same `--self-check` style as the existing scripts
  (`sync_delivery_tickets_to_sheet.py`, `sync_delivery_tickets_to_bq.py`).
- Offline test for the BigQuery-result + Postgres-result merge in `api/_lib/escalationBq.js` — a pure
  function (two arrays in, one joined-and-filtered array out), testable with fixtures, no network.

Two assertions carry the most weight, same reasoning as the 08-09 spec:

- The sheet sweep never writes a ticket-owned column (it only ever touches `orders_sheet_columns`,
  a table the ticket loader never touches — column-ownership is now enforced by table separation,
  not by a MERGE clause naming specific columns).
- The dual-write to Sheet T:W uses the `row_number` carried from the BigQuery read, never a
  freshly-scanned one — a mismatch here would silently write resolution data into the wrong sheet row.

## File-by-file

| File | Change |
|---|---|
| `scripts/sync_escalation_sheet_to_bq.py` | **New.** Sheet sweep, truncate-rebuild `orders_sheet_columns`. |
| `scripts/sync_delivery_tickets_to_bq.py` | **Modify.** `--rebuild-since` becomes the sole production path; retire incremental `sync_brand`/dedup-by-`ticket_number`. |
| `.github/workflows/sync-escalation-bq.yml` | **New.** Schedules both rebuilds, every 2h. |
| `scripts/migrate_escalation_resolutions_to_postgres.py` | **New, one-off.** Sheet T:W → Postgres. |
| `scripts/test_escalation_sheet_sweep.py` | **New.** Offline self-check. |
| `api/_lib/bigquery.js` | **New.** Node-side BigQuery REST read client (mirrors `scripts/bq_lib.py`'s approach — reuse the existing service-account JWT, no new dependency). |
| `api/_lib/escalationBq.js` | **New.** Reads + the BigQuery/Postgres merge. |
| `api/_lib/escalationSheet.js` | **Modify.** Keep `batchUpdateOrders`; drop the read functions (`getEligibleOrders`, `getFreshLeads`, CSV row-matching). |
| `api/_lib/db.js` | **Modify.** Extend `escalation_lead_assignments` schema/queries with resolution columns. |
| `api/escalation/[action].js` | **Modify.** Point reads at `escalationBq`; point writes at Postgres + the retained Sheet dual-write; add `assign-bulk`. |
| `app/escalation/EscalationClient.js` | **Modify.** Payload keys, resolution fields sourced from the assignments map, single-call auto-assign, toast copy. |

## Configuration

| Name | Where | Purpose |
|---|---|---|
| `BQ_PROJECT_ID` | Lambda + Actions | Target GCP project (already in use by `scripts/sync_delivery_tickets_to_bq.py`). |
| `BQ_DATASET` | Lambda + Actions | Dataset name, default `escalation`. |

Node reuses `GOOGLE_SHEETS_CLIENT_EMAIL`/`GOOGLE_SHEETS_PRIVATE_KEY` for both Sheets and BigQuery
(same service account, same pattern `scripts/lib.py`/`scripts/bq_lib.py` already use on the Python
side). No new secret for a sync endpoint — there is no such endpoint; all ingest is scheduled Python,
as in the 08-09 spec.

## Open items

- **Logistics pipeline behind Q:S.** Still untraced, still out of scope.
- **Retiring the Sheet's formulas entirely.** Not attempted here — `status_as_per_awb` and
  `update_from_logistics` are load-bearing for the queue's own definition and their source logic
  (a formula, an external pipeline) is unknown. `total_times_user_reached` is the one L:P-equivalent
  metric already re-derived independently, ahead of this design, as a byproduct of an earlier
  request in this same session.
- **BigQuery billing.** If billing is ever enabled on this project, the 08-09 spec's DML-based
  ingest (`MERGE`) becomes viable again and could replace the truncate-rebuild mechanism — but the
  Postgres-for-app-writes decision in this spec stands independently of that, since Postgres already
  had no DML restriction to begin with and moving it back to BigQuery would gain nothing.
