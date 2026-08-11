# Escalation RTO Queue: drop the Sheet entirely — design

Date: 2026-08-11
Status: approved

Supersedes the "keep dual-writing/sweeping the Sheet" parts of
[`2026-08-10-escalation-bigquery-postgres-hybrid-design.md`](2026-08-10-escalation-bigquery-postgres-hybrid-design.md).
That spec's hard constraint was "do not touch the Sheet" — reads had already moved to BigQuery +
Postgres, but `orders_sheet_columns` (BigQuery, swept from the Sheet every 2h) still supplied the
RTO filter predicate and five display fields, and the app still dual-wrote resolutions into the
Sheet's T:W cells. This spec removes both: the app and its scheduled jobs stop touching the Sheet
anywhere.

## Why now

`status_as_per_awb` and `update_from_logistics` — the two Sheet-only fields that defined "RTO" —
have no other source (one's a Sheet formula, the other an untraced external paste) and were
already a known open item in the prior design ("Retiring the Sheet's formulas entirely: not
attempted here"). Rather than solve that unknown now, the RTO filter is dropped: the queue shows
all rows from `Delivery_escalation`, unfiltered. Per-brand/tab filtering rules will be specified
later; until then "RTO Queue" and "Fresh Leads" both show the same unfiltered set.

## Scope

**In scope:** `api/_lib/escalationBq.js`, `api/escalation/[action].js`, `api/_lib/escalationSheet.js`
(deleted), `app/escalation/EscalationClient.js` (row identity + payloads), the sheet-sweep script
and its CI schedule.

**Out of scope:** `api/rto/sheet.js`, `api/ndr/sheet.js` — a different feature/sheet, not this RTO
Queue. Agent roster, dispositions, presence, auth, `escalationCsv.js` (already Sheet-free).

## Architecture

```
MySQL PEP_CLS.hyphen_tickets/mcaff_tickets
  └─ sync_delivery_tickets_to_bq.py [UNCHANGED]
       └─> BigQuery escalation.Delivery_escalation   (truncate-rebuild, every 2h)

App (Lambda)
  ├─ READS:  BigQuery Delivery_escalation (no join, no predicate) + Postgres (current state)
  └─ WRITES: Postgres escalation_lead_assignments only — no Sheet write, anywhere

Sheet: no longer read or written by anything in this repo's app/API/scheduled-job layer.
```

`escalation.orders_sheet_columns` (BigQuery) stops being written to (its sweep script is deleted)
and stops being read. Dropping the table itself is an infra follow-up, not part of this change —
the code simply never touches it again.

## Data model

No schema changes. `Delivery_escalation` already carries everything the read path needs:
`brand, parent_order, awb_number, added_date, query_class, query_category,
delivery_partner_name, order_date, order_month, query_date, query_month, wh_name,
ticket_number, total_times_user_reached`.

`ticket_number` is the MySQL ticketing system's own per-row ID (see
`scripts/sync_delivery_tickets_to_bq.py`'s `row_to_bq_dict`) — unique per ticket row, unlike
`parent_order` (one order can have multiple ticket rows, as today's live queue already shows for
`HYP34735920`). `brand:ticketNumber` replaces `sheetTab:rowNumber` as the row identity used
throughout the client for list keys, checkboxes, and CSV-import result matching.

Resolution/assignment state remains keyed by `(brand, parent_order)` in Postgres — unchanged from
the prior hybrid design. This means resolving one ticket row resolves every row sharing that
`parent_order`; that's pre-existing behavior (Postgres was already keyed this way), not a change
introduced here.

## Application layer

### Reads (`orders`, `export`, `sample` actions)

`escalationBq.js`'s `queryOrders` drops the `LEFT JOIN orders_sheet_columns` and the `WHERE`
predicate entirely: `SELECT ... FROM Delivery_escalation t`, no filter beyond dropping
already-resolved rows (via the Postgres merge, unchanged). `getEligibleOrders()` and
`getFreshLeads()` both call this with no predicate — identical results until tab-wise rules are
specified. `mergeOrderRow` drops `rowNumber`, renames `sheetTab` → `brand`, and stops emitting
`deliveredDate, statusAsPerAwb, solvDate, tat, updateFromLogistics, city, state` (simply absent —
the client already guards every read of these with `|| ''`/`|| '—'`, so they render blank, not
broken).

### Writes (`update`, `bulk-update`, `import`, `assign`, `assign-bulk`)

| Action | Before | After |
|---|---|---|
| `update` | Sheet `updateOrder` (needs `rowNumber`+`sheetTab`) + Postgres | Postgres only; `rowNumber`/`sheetTab` dropped from required fields |
| `bulk-update` | Sheet `batchUpdateOrders` (needs `sheetTab` per item) + Postgres | Postgres only; `sheetTab` requirement dropped |
| `import` | Matches CSV rows against `orders_sheet_columns` (for `rowNumber`/`sheetTab`), then Sheet write + Postgres | Matches CSV rows against `Delivery_escalation` directly (for `brand`, to validate the order exists); Postgres only |
| `assign` / `assign-bulk` | Required `rowNumber` for validation only (never used in the write itself) | `rowNumber` requirement dropped; unchanged otherwise |

`api/_lib/escalationSheet.js` is deleted — its only caller is this file, and its one remaining job
(the T:W dual-write) goes away with it.

CSV import's row-matching helper is rewritten against `Delivery_escalation` (`getOrderIndexFromBq`
replaces `getSheetIndexFromBq`): same `byParent`/`byParentAwb` maps, keyed by normalized
`parent_order`/`awb_number`, but the map value is now `{ brand }` — no `rowNumber`, since there's
no Sheet cell left to address. The `import` response's per-row field (used by the client to highlight which rows imported) keeps
its `rowNumbers` JSON key (minimal client diff) but its string values switch from
`sheetTab:rowNumber` to `brand:ticketNumber` shape — but note CSV rows match by `parent_order`, and
a `parent_order` can span multiple ticket rows; since `getOrderIndexFromBq`'s map value is only
`{ brand }` (no per-ticket-row info), the response emits `` `${brand}:${parentOrder}` `` per matched
CSV row. The client's highlight-matching effect must therefore compare against
`` `${order.brand}:${order.parentOrder}` `` for import-highlight purposes specifically, not the
`brand:ticketNumber` `rowKey()` used everywhere else — a matched CSV row highlights every ticket
row sharing that order, consistent with resolution's own `(brand, parent_order)` granularity.

### Client (`EscalationClient.js`)

- `rowKey(order)` becomes `` `${order.brand}:${order.ticketNumber}` ``. Every caller that built
  `sheetTab:rowNumber` (row DOM id, `handleSubmit`/`handleAssign` payloads, the CSV-import
  highlight-matching effect) switches to this.
- `update`/`assign` fetch payloads drop `rowNumber`/`sheetTab`, send `parentOrder` (+ `newOrderId`,
  `newAwb`, `newStatus`, `notes` for `update`; `agentId` for `assign`).
- **`handleBulkApply`'s (the "mark selected as Delivered" bulk action) candidate filter is a real
  fix, not just a rename**: it currently builds `{ rowNumber, sheetTab, parentOrder }` per selected
  row and does `.filter((i) => i.rowNumber && i.sheetTab)` — with both fields gone, this would
  silently filter out every selected row and the button would resolve nothing. Becomes
  `{ parentOrder }` filtered by `.filter((i) => i.parentOrder)`. (`handleAutoAssign` already only
  ever used `parentOrder`/`agentId` — nothing to fix there.)
- Fields that render Sheet-sourced data (`city`/`state` location string, `statusAsPerAwb` RTO
  badge, the Status filter dropdown) are left as-is — they already tolerate missing data and will
  just show blank/inert until tab-wise filtering rules are specified. Not touched in this change.

## Scheduled jobs

- `scripts/sync_escalation_sheet_to_bq.py` and `scripts/test_escalation_sheet_sweep.py` — deleted.
- `.github/workflows/sync-escalation-bq.yml` — drop the "Sweep sheet-computed columns
  (orders_sheet_columns)" step; keep the "Rebuild ticket columns (Delivery_escalation)" step
  unchanged.
- `scripts/sync_delivery_tickets_to_sheet.py` — untouched. It writes the Sheet for reasons outside
  this app (the Sheet's own formulas, the external logistics paste, and whoever else still views it
  directly); this change only removes *this app's* dependency on the Sheet, not the Sheet's other
  writers.

## Error handling

No new failure modes: dropping a JOIN and a predicate can't fail in new ways the existing query
didn't already handle; dropping the Sheet write removes a failure mode (`escalationSheet`'s fetch
to the Sheets API — a plausible cause of the "Failed to load" error seen in production, one of the
two required-request paths in `Promise.all` that a resolve/import action drove).

## Testing

Per this project's no-live-testing rule: offline only, no real BigQuery/Postgres/DB touch.

- `api/_lib/escalationBq.test.js` (existing) — update fixtures for the new `mergeOrderRow` shape
  (no `rowNumber`, `sheetTab` → `brand`, missing sheet-sourced fields absent rather than present).
- No test file exists for `escalationSheet.js`'s deletion to threaten; nothing to update there.
- Manual smoke check (client-side logic only, no live call): the Auto-Assign-All filter's fix is the
  one piece of this change with a real regression risk (silently assigning zero orders) — worth a
  quick `.filter()` sanity read against the new field shape.

## File-by-file

| File | Change |
|---|---|
| `api/_lib/escalationBq.js` | Drop `orders_sheet_columns` JOIN + predicate; `mergeOrderRow` drops `rowNumber`, renames `sheetTab`→`brand`, drops sheet-sourced fields. |
| `api/_lib/escalationSheet.js` | **Delete.** |
| `api/escalation/[action].js` | Drop `escalationSheet` require/calls; drop `rowNumber`/`sheetTab` from required fields in `update`/`bulk-update`/`assign`; replace `getSheetIndexFromBq` with `getOrderIndexFromBq` (queries `Delivery_escalation`) in `import`. |
| `app/escalation/EscalationClient.js` | `rowKey()` → `brand:ticketNumber`; update/assign payloads drop `rowNumber`/`sheetTab`; fix Auto-Assign-All's candidate filter. |
| `api/_lib/escalationBq.test.js` | Update fixtures for the new row shape. |
| `scripts/sync_escalation_sheet_to_bq.py` | **Delete.** |
| `scripts/test_escalation_sheet_sweep.py` | **Delete.** |
| `.github/workflows/sync-escalation-bq.yml` | Drop the sheet-sweep step. |

## Open items

- **Tab-wise filtering.** RTO Queue vs. Fresh Leads currently return identical unfiltered data;
  criteria to be specified later (per this conversation).
- **Sheet-sourced display fields** (`city`, `state`, `tat`, `deliveredDate`, `solvDate`,
  `statusAsPerAwb`) have no replacement source yet — blank until one exists.
- **`escalation.orders_sheet_columns` BigQuery table** — no longer written or read; dropping it is
  an infra cleanup outside this change's scope.
