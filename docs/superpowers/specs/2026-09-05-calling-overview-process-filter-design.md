# Calling Team Overview — Process filter (RTO / NDR) design

## Goal

Add a "Process" filter (RTO / NDR) to the Calling Team Overview page
(`app/calling-overview/`). RTO already works end-to-end off `CLS_RTO_calling`.
Selecting NDR must show the equivalent NDR-side metrics: KPI tiles, Delivery
Partner Breakdown (expandable into a per-partner NDR-reason funnel), and a
top-level NDR Reason Breakdown — same shapes as the existing RTO tables, same
Payment mode / Brand / Date range filters, minus the Refunds tile (no refund
concept in NDR calling).

## Why this isn't a small filter add

`ndr_lead_assignments` (the NDR calling mirror table) only has
`awb_number, email, assigned_at, reassigned_away_at, disposed_at, disposition,
agent_remarks`. Courier, NDR reason, payment mode and brand — the fields RTO's
breakdown tables group by — live only in the Google Sheet roster, read live
per-lead by `api/ndr/next-lead.js` and `scripts/assign_ndr_leads.py`, never
mirrored into MySQL. This design mirrors them in, going forward, plus a
one-off backfill for existing rows still visible in the live sheets.

## 1. Schema

Add to `ndr_lead_assignments` (in `api/_lib/db.js`'s `ensureSchema`, same
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`-style migration this file already
uses elsewhere):

```sql
ALTER TABLE ndr_lead_assignments
  ADD COLUMN delivery_partner VARCHAR(64) NULL,
  ADD COLUMN ndr_reason VARCHAR(255) NULL,
  ADD COLUMN payment_mode VARCHAR(20) NULL,
  ADD COLUMN brand VARCHAR(20) NULL;
```

No new `connected` or `outcome` column. Both derive from the existing
`disposition` text at query time:

- `disposition` is written as the full dash-joined leaf path picked in the
  NDR disposition tree (`ndrDispSelection` in `NdrCallingClient.js`, e.g.
  `"Connected - New order Placed"`, `"Not Connected - Reattempt"`).
- **connected** ⇔ `LOWER(TRIM(disposition)) LIKE 'connected%'` (excludes
  `"Not Connected..."`, which starts with "not").
- **converted** (NDR's "Reorders Converted") ⇔
  `LOWER(disposition) LIKE '%new order placed%'` — same case-insensitive
  spirit as commit `efe2d09`'s `ndrIsReorderOutcome` fix, applied to the
  stored MySQL string instead of the sheet's live `outcome` cell.

## 2. Snapshot points (write path)

The 4 new columns are populated wherever a lead is claimed — both existing
mirror-write call sites, no new call sites:

**JS — `api/ndr/next-lead.js` + `api/_lib/db.js`:**
- `buildCandidateList()` (`next-lead.js` ~L111) already reads
  `attempts/latestNdrReason/paymentMode/brand` per candidate row off the
  `A2:T` range. Add `COL_COURIER = 5` (column F, "Courier Company") and a
  `courier: cell(COL_COURIER)` field on the candidate object.
- `claimNdrLead(awbNumber, email)` (`db.js` ~L1715) gains 4 optional params
  — `claimNdrLead(awbNumber, email, { courier, reason, paymentMode, brand })`
  — written into the new columns on the `INSERT IGNORE`. The call site at
  `next-lead.js` ~L258 passes `c.courier, c.latestNdrReason, c.paymentMode, c.brand`
  from the candidate it just assigned.

**Python — `scripts/assign_ndr_leads.py`:**
- Add `COL_COURIER = 5` alongside the other `COL_*` constants.
- `assign_for_run()`'s `unassigned` tuples (~L367) already carry
  `reason, payment_mode, brand` — add `courier` (read the same way as the
  others, defaulting to `""` when the row is short).
- `new_assignments.append((awb, email))` (~L461) becomes
  `new_assignments.append((awb, email, courier, reason, payment_mode, brand))`.
- `record_new_assignments()` (~L264) extends its `INSERT`/`UPDATE` statements
  to write the 4 extra columns alongside `awb_number, email, assigned_at`.

`disposeNdrLead`'s own fallback INSERT (`db.js` ~L1734, fired only when the
UPDATE matches zero rows) is left untouched — it has no sheet row in hand at
dispose time, so it inserts the 4 new columns as NULL, same as any other
disposal race; a later backfill run or the next claim's mirror write is what
would fill them in, not this path.

## 3. Backfill (one-off script)

New `scripts/backfill_ndr_lead_attributes_from_sheet.py`, same shape as the
existing `scripts/backfill_delivery_escalation_from_csv.py`:

1. Resolve the active team list exactly the way `assign_ndr_leads.py`'s
   `main()` already does: `fetch_active_ndr_teams()`, then 0 active → single
   synthetic run against `SPREADSHEET_ID`/`SHEET_TAB`; 1 active → that row's
   own sheet; 2+ → one run per team. (Import and reuse `fetch_active_ndr_teams`
   from `assign_ndr_leads.py` rather than re-deriving this.)
2. For each run's sheet, read `A2:Q` (covers Order ID, Courier Company,
   Payment Method, Latest NDR Reason), build
   `awb_number -> {delivery_partner, ndr_reason, payment_mode, brand}`
   (brand via the same `brand_of(order_id)` helper `assign_ndr_leads.py`
   already has).
3. Batch-`UPDATE ndr_lead_assignments SET delivery_partner=%s, ndr_reason=%s,
   payment_mode=%s, brand=%s WHERE awb_number=%s` for every matched AWB —
   updates every historical cycle for that AWB (lead-level facts, not
   cycle-level), not just the live row.
4. AWBs no longer present in any active sheet are left as-is (NULL) —
   acceptable; those rows show as "Unknown"/excluded the same way a filter
   with genuinely no data does elsewhere on this page.
5. Print a summary (rows matched / updated / AWBs not found), no dry-run
   flag needed — this only ever fills NULLs, never overwrites a
   non-NULL value, so it's safe to re-run.

## 4. Query layer (`api/_lib/db.js`)

Three new functions, parallel to the existing RTO ones, querying
`ndr_lead_assignments` instead of `CLS_RTO_calling`:

- `getNdrCallingOverviewStats(dateFrom, dateTo)` — same
  assigned/disposed/pending/connected grain split as
  `getCallingOverviewStats` (assigned/pending use `reassigned_away_at IS
  NULL` + `assigned_at` bounds; disposed/connected/converted use every cycle
  + `disposed_at` bounds), `COUNT(DISTINCT awb_number)` in place of
  `order_id`. No refund fields at all (omitted from the returned object;
  UI hides the tile rather than rendering a zero).
- `getNdrCallingReasonBreakdown(dateFrom, dateTo, paymentMode, brand)` — top
  Reason Breakdown table, `GROUP BY COALESCE(ndr_reason, 'Unknown')`. No
  category rollup (no NDR equivalent of `categorizeRtoReason` — NDR reasons
  are free text, grouped as-is).
- `getNdrCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode, brand)`
  — `GROUP BY delivery_partner, ndr_reason`, same
  assigned/connected/converted `SUM(CASE WHEN ...)` shape as
  `getCallingPartnerReasonBreakdown`, same JS-side reassembly into
  `{ deliveryPartner, ...totals, reasons: [...] }`.

`getCallingOverviewData(query)` reads `query.process` (`'RTO'` default, or
`'NDR'`) and calls either the RTO function set (unchanged) or the NDR set
above. `hourly` and `partnerBreakdown` (the plain, non-reason partner
breakdown) are RTO-only and omitted for NDR — confirmed unused by
`CallingOverviewClient.js` today.

## 5. API

No route change needed: `api/report/data/[key].js` already forwards
`req.query` verbatim into `route.query(req.query)`, so a `process` query
param just needs to be sent by the client and read by
`getCallingOverviewData`.

## 6. UI (`app/calling-overview/CallingOverviewClient.js`)

- New `PROCESS_OPTIONS = [{value:'RTO',label:'RTO'},{value:'NDR',label:'NDR'}]`
  and `const [process, setProcess] = useState('RTO')`, a new filter group in
  the filterbar (placed first, before Date range) — same `<select>` pattern
  as `PAYMENT_MODE_OPTIONS`/`BRAND_OPTIONS`.
- `process` added to the fetch's `URLSearchParams` and to the effect's
  dependency array.
- Refunds KPI tile: rendered only when `process !== 'NDR'`.
- `REASON_COLUMNS` label and the two table titles/hints ("RTO Reason
  Breakdown" / "Click a partner to see its RTO reason funnel.") swap to
  "NDR Reason" / "NDR reason funnel" when `process === 'NDR'` — computed
  from `process` instead of the current module-level constants.
- Everything else (sortable columns, expand/collapse, totals row, Payment
  mode / Brand / Date range filters) is unchanged and shared by both
  processes, since the API returns the same `stats` /
  `partnerReasonBreakdown` / (renamed generically, see below) shape either
  way.

**API payload field naming:** rename `rtoReasonBreakdown` →
`reasonBreakdown` in the JSON payload (process-agnostic now that the same
key serves both RTO and NDR rows) and update the one consumer
(`CallingOverviewClient.js`) accordingly. Confirmed via grep that no other
file reads `data.rtoReasonBreakdown` from this endpoint.

## Testing

- `api/_lib/ndrAssignment.test.js` / `api/ndr/next-lead.test.js`-style unit
  tests for the extended `buildCandidateList`/`claimNdrLead` signatures.
- A Python unit test for `record_new_assignments`'s extended write (mirroring
  existing `scripts/test_assign_ndr_leads.py` patterns).
- Manual check of the Overview page in both Process modes after backfill
  runs once against a real sheet.
