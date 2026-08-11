# Escalation RTO Queue: drop BigQuery and the Sheet, move entirely to Supabase — design

Date: 2026-08-11
Status: approved

Supersedes [`2026-08-11-escalation-drop-sheet-design.md`](2026-08-11-escalation-drop-sheet-design.md)
(the Sheet-only removal) and the BigQuery half of
[`2026-08-10-escalation-bigquery-postgres-hybrid-design.md`](2026-08-10-escalation-bigquery-postgres-hybrid-design.md).
That spec's Postgres half stands unchanged — `escalation_lead_assignments`, keyed by
`(brand, parent_order)`, is untouched by this change. What changes is where ticket data
(`Delivery_escalation`, BigQuery) lives: this spec moves it into the SAME Supabase Postgres
database `escalation_lead_assignments` already lives in (confirmed live: `POSTGRES_URL` names a
`*.pooler.supabase.com` host — see `api/_lib/db.js`'s `getPgPool`).

## Why this is better than the prior plan, not just a different vendor

The prior (BigQuery) design's read path was two systems merged in JavaScript: query BigQuery,
query Postgres, `Map`-join by `parentOrder` in `escalationBq.js`. That split existed only because
ticket data and resolution data lived in different systems. Once both live in the same Postgres
database, that whole merge step collapses into one SQL query — `escalation_tickets LEFT JOIN
escalation_lead_assignments`, one round trip, one function, nothing to unit-test as a separate
pure-merge step (matching how every other table in `db.js` already works: no `mergeOrderRow`-style
helper exists for `lead_assignments`/`ndr_lead_assignments` either).

It also removes a real constraint the BigQuery design had to work around. That project has no
billing enabled, so `UPDATE`/`MERGE`/`DELETE` are flatly rejected — the reason
`sync_delivery_tickets_to_bq.py` did a full `WRITE_TRUNCATE` rebuild every run just to keep
`total_times_user_reached` correct on rows loaded in an earlier run. Postgres has no such
restriction, and this repo already has an established pattern for exactly this shape of write
(`scripts/lib.py`'s `gokwik_refund_checks` upsert in `assign_leads.py`) — a real `ON CONFLICT DO
UPDATE` upsert, plus one small targeted `UPDATE` for the one field (`total_times_user_reached`)
that can go stale on rows outside the current run's fetch window. Cheaper (no full-table rewrite
every 2h) and more correct (rows outside the "since" window that share a touched AWB still get
fixed, not just the ones this run fetched).

## Scope

**In scope:** `api/_lib/escalationBq.js` (deleted, replaced by a query in `db.js`),
`api/_lib/bigquery.js` (deleted), `api/escalation/[action].js` (CSV-import matching + all write
actions re-sourced from Postgres), `app/escalation/EscalationClient.js` (same row-identity change
as the Sheet-drop spec — `brand:ticketNumber` replaces `sheetTab:rowNumber`), the ticket-sync
script and its CI schedule.

**Out of scope:** everything the Sheet-drop spec already scoped out — `api/rto/sheet.js`,
`api/ndr/sheet.js`, agent roster, auth, `escalationCsv.js`. Also out of scope: the RTO filter
predicate and the five Sheet-only display fields (`city`/`state`/`tat`/`deliveredDate`/
`solvDate`) — already dropped per that spec's decision (show all data, tab-wise rules later);
this pivot doesn't reopen that.

## Architecture

```
MySQL PEP_CLS.hyphen_tickets/mcaff_tickets
  └─ sync_delivery_tickets_to_pg.py [NEW, replaces sync_delivery_tickets_to_bq.py]
       └─> Supabase Postgres escalation_tickets   (UPSERT + targeted recompute, every 2h)

App (Lambda)
  ├─ READS:  Supabase Postgres — one query, escalation_tickets LEFT JOIN escalation_lead_assignments
  └─ WRITES: Supabase Postgres escalation_lead_assignments only (unchanged)

BigQuery: touched nowhere in this app anymore. Google Sheet: touched nowhere in this app anymore.
```

## Data model

### `escalation_tickets` (Postgres, NEW — created in `db.js`'s `ensurePgSchema`, same pattern as
`escalation_lead_assignments`)

```sql
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
```
Plus `CREATE INDEX IF NOT EXISTS escalation_tickets_parent_order_idx ON escalation_tickets (parent_order)`
(the join key with `escalation_lead_assignments`).

Date-shaped columns (`added_date`, `order_date`, etc.) stay `TEXT`, not `TIMESTAMP` — they're
display-formatted strings (`"Aug 1, 2026"`, `"7_Jul'26"`) produced by
`sync_delivery_tickets_to_sheet.py`'s `build_sheet_row`, reused as-is by the new sync script
(same reasoning the BigQuery table used: don't re-derive formatting a shared function already
owns, and don't risk a parse of a format that was never designed to round-trip).

`ticket_number` is the MySQL ticketing system's own per-row ID — the natural primary key
component, and already this app's row identity (`brand:ticketNumber`, from the Sheet-drop spec).

### `escalation_lead_assignments` (Postgres) — unchanged

No schema change. Still keyed by `(brand, parent_order)` conceptually (physically just
`parent_order` — brand isn't a column on this table today and this change doesn't add one; a
`parent_order` collision across brands was already possible before this change and is not
introduced by it).

## Application layer

### Reads (`orders`, `export`, `sample` actions)

One function in `db.js`, replacing `escalationBq.js` entirely:

```sql
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
```

The `LATERAL` join picks the single most-recent assignment row per order (mirrors exactly what
`escalationBq.js`'s `byParentOrder` `Map` — built from `getEscalationAssignments()`'s
`assigned_at DESC` history, keeping the first-seen-per-key — used to do in JavaScript);
`WHERE a.resolved_at IS NULL` drops already-resolved orders, the same filter
`queryOrders`'s `.filter((row) => !row.status)` used to apply after the fact. No predicate beyond
that — same "show everything, tab-wise rules later" decision as the Sheet-drop spec.

`getEligibleOrders()` and `getFreshLeads()` keep their existing zero-argument signatures (both
call this one query, both currently return identical rows) — `api/escalation/[action].js` needs
no change to which functions it calls, only where they come from (`require('../_lib/db')`
instead of `require('../_lib/escalationBq')`).

### Writes — unchanged from the Sheet-drop spec

`update`/`bulk-update`/`assign`/`assign-bulk` already point at Postgres only in that spec (the
Sheet dual-write was what that spec removed) — this pivot doesn't touch them again.

### CSV import matching

`getOrderIndexFromBq`'s BigQuery query becomes a Postgres query in the same shape, against
`escalation_tickets` instead of `orders_sheet_columns` — same `byParent`/`byParentAwb` maps, same
`{ brand }` ref value, just a different table on a different (already-connected) database.

## Sync script

`scripts/sync_delivery_tickets_to_pg.py` replaces `scripts/sync_delivery_tickets_to_bq.py`.
Reuses `sync_delivery_tickets_to_sheet.py`'s `fetch_today_delivery_tickets`, `build_sheet_row`,
`fill_missing_awb` — unchanged imports, same as the BigQuery version did.

1. Fetch today's Delivery-class tickets per brand (`fetch_today_delivery_tickets(table, since=...)`),
   same "since" anchor semantics as today.
2. Compute each row's `total_times_user_reached` via `get_awb_reach_counts` — unchanged, still
   queries MySQL directly for the lifetime count (not the local Postgres mirror: a `--since`-windowed
   fetch may not carry every historical row for an AWB, so MySQL, which has all of them, stays the
   source of truth for this count — the same reasoning the BigQuery version already documented).
3. `executemany` an `INSERT ... ON CONFLICT (brand, ticket_number) DO UPDATE SET <every column>,
   loaded_at = now()` for this run's rows — an upsert, not a truncate-rebuild.
4. `executemany` a second, smaller `UPDATE escalation_tickets SET total_times_user_reached = %s
   WHERE brand = %s AND awb_number = %s` over the same `awb_counts` dict already computed in step
   2 — this is what keeps OLD rows (outside this run's fetch window, sharing a touched AWB)
   correct, replacing what full truncate-rebuild used to guarantee by brute force.

No Google credentials needed by this script at all (unlike the BigQuery version, which needed
`GOOGLE_SA_KEY_JSON` to authenticate to BigQuery's REST API with the Sheets service account) —
only `MYSQL_*` and `POSTGRES_URL`.

Connection: `lib.get_pg_connection(os.environ["POSTGRES_URL"])`, one connection for the whole run
(a few seconds to a couple minutes), same pattern every other Python script writing to this
Postgres already uses. Supabase's pooler caps the WHOLE project at 15 concurrent clients
(`api/_lib/db.js`'s `getPgPool` comment) — a single short-lived cron connection every 2h is a
negligible addition to that budget, same as the existing `assign-leads.yml` (every 5 minutes) and
`sync-lead-assignments.yml` jobs already are.

## Scheduled jobs

`.github/workflows/sync-escalation-bq.yml` → renamed `sync-escalation-pg.yml`, drops the Sheet-sweep
step (per the Sheet-drop spec) and its `GOOGLE_SA_KEY_JSON`/`BQ_PROJECT_ID` secrets, adds
`POSTGRES_URL` (the same secret name `assign-leads.yml`/`sync-lead-assignments.yml` already use).
Same `0 */2 * * *` schedule.

## Testing

Per this project's no-live-testing rule: offline only.

- `sync_delivery_tickets_to_pg.py` keeps a `--self-check` in the same style as the script it
  replaces — pure row-mapping assertions, no MySQL/Postgres connection.
- No test file for the `db.js` read query: consistent with every other query function in that
  file (`getEscalationAssignments`, `assignEscalationOrder`, etc.), none of which have one — SQL
  correctness against a live database isn't something this repo's no-live-testing rule lets an
  offline test meaningfully check. `escalationBq.test.js` (which tested the now-deleted JS-side
  merge function) is deleted, not ported — there is no equivalent pure function left to test.

## File-by-file

| File | Change |
|---|---|
| `api/_lib/db.js` | Add `escalation_tickets` DDL to `ensurePgSchema`; add the read query (replaces `escalationBq.js`); add the CSV-import order-index query. |
| `api/_lib/escalationBq.js` + `.test.js` | **Delete.** |
| `api/_lib/bigquery.js` | **Delete.** |
| `api/escalation/[action].js` | Read/import functions now come from `db.js`, not `escalationBq`/`bigquery`. Write-action changes are as already specified in the Sheet-drop spec. |
| `app/escalation/EscalationClient.js` | As already specified in the Sheet-drop spec (row identity, payloads). |
| `scripts/sync_delivery_tickets_to_pg.py` | **New**, replaces `sync_delivery_tickets_to_bq.py`. |
| `scripts/sync_delivery_tickets_to_bq.py` | **Delete.** |
| `scripts/bq_lib.py` | **Delete** (no caller left once both BQ sync scripts are gone). |
| `scripts/sync_escalation_sheet_to_bq.py` | **Delete** (per the Sheet-drop spec, unchanged by this pivot). |
| `.github/workflows/sync-escalation-bq.yml` | Renamed `sync-escalation-pg.yml`; MySQL + Postgres secrets only, no Google credentials. |

## Open items

Unchanged from the Sheet-drop spec: tab-wise filtering rules (RTO Queue vs. Fresh Leads currently
identical), the five Sheet-only display fields have no replacement source yet.
