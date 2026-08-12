# Refund CSV Export (Calling Team → Exports tab)

## Problem

The Calling Team sidebar has an "Exports" sub-item (`app/HomeClient.js`'s `CALLING_TEAM_SUBITEMS.exports`) that has stood as a placeholder ("Exports workspace is coming soon") since it was added — no `url`, so it renders nothing. `api/_lib/tabs.js` already lists `exports` as a grantable tab under the `calling` card, so admins can invite people to it, but there is no page or endpoint behind the invite.

Separately, a MySQL table `refund_all_brands` (schema `PEP_CLS`, same RDS instance the app's other MySQL tables live on) holds refund records fed by GoKwik across all brand storefronts (`api/refund/gokwik-initiate.js` is the refund-initiation side of this data, for context — it does not write this table itself). Nothing in the app currently reads it. This spec wires the Exports tab up to a real, filtered CSV export of this table.

## Data (verified against the live table, read-only)

`PEP_CLS.refund_all_brands`, 90,301 rows as of 2026-08-12, 26 columns:

| Group | Columns |
|---|---|
| IDs | `s_no, order_number, payment_id, platform_order_number, rrn_no, refund_id, reference_id, moid, transaction_payment_id, chargeback_case_id` |
| Money / status | `amount, status (Completed/Initiated/Failed/Rejected), refund_type (Full/Partial), auto_refund, is_chargeback, chargeback_case_status, source (Shopify/Payment Link/Others), initiated_by` |
| Dates | `created_at, refunded_at` — **both VARCHAR**, not real timestamps (see below) |
| PII | `customer_name, customer_phone, customer_email, shipping_address, billing_address` |
| Other | `refund_request_description` |

There is no brand column and `order_number` carries no brand-identifying prefix (all values are GoKwik `KWIK...` IDs) — confirmed by direct query. Per discussion, **no brand filter is built**; filtering is on the real columns only.

### `created_at` / `refunded_at` format

Both columns mix two text formats (confirmed by sampling rows where the first numeric component is >12, which disambiguates day vs. month):

- `D/M/YYYY h:mm AM/PM` — e.g. `13/4/2026 10:58 PM`, `31/5/2026 11:18 PM`
- `DD-MM-YYYY HH:MM` (24h) — e.g. `18-03-2026 13:31`

Both are **day-first**. SQL-side parsing uses:

```sql
COALESCE(
  STR_TO_DATE(created_at, '%d/%c/%Y %h:%i %p'),
  STR_TO_DATE(created_at, '%d-%m-%Y %H:%i')
)
```

applied identically wherever `created_at` needs to be compared as a date. Only `created_at` is filterable (per decision); `refunded_at` is exported as a plain column, not parsed.

### Row size / export cap

Measured actual byte length (all 26 columns, `SUM(CHAR_LENGTH(...))` per row) across the full table: average 438 bytes/row, true max 1,104 bytes/row. A CSV export is capped at **10,000 rows** — worst realistic case (10,000 × ~1,100 bytes ≈ 11MB) would be tight against Lambda's 6MB response ceiling only if every single row hit the true max simultaneously, which the measured distribution (avg 438B, p99 ~700B from a 2,000-row sample) makes implausible; the expected size at the cap is ~4.4MB, leaving comfortable headroom. If a filtered query matches more than 10,000 rows, the export is refused with a 400 rather than silently truncated or left to fail past the payload limit.

## Access control

Two independent gates, both enforced server-side (never trusting the client):

1. **Tab invite** — same shape as `api/escalation/[action].js`'s `checkAccess`: requires the `calling` card, and — only if the account has tab-level restrictions set — the `exports` tab specifically (`report_tab_permissions`, card `calling`, tab `exports`).
2. **PII columns** — `customer_name, customer_phone, customer_email, shipping_address, billing_address` are included in the CSV only when `session.isAdmin` (the existing company-wide admin flag from `getSession`, same one `app/HomeClient.js` already uses to show "Administrator"/the admin link). Everyone else with `exports` access gets the other 21 columns. This is decided entirely server-side in the export handler — the frontend has no column-visibility logic of its own.

## API — `api/refund-export.js`

New flat file (single GET action, no `[action].js` dynamic dispatch — there's only one operation, unlike escalation/admin/auth which have many), mounted in `api/_lambda/app.js`:

```js
mount('get', '/api/refund-export', '../refund-export.js');
```

Request: `GET /api/refund-export?from=YYYY-MM-DD&to=YYYY-MM-DD&status=Completed,Failed&refundType=Full&source=Shopify`

- `from`, `to` — **required**. 400 if either missing, unparseable, or `to < from`.
- `status`, `refundType`, `source` — optional, comma-separated; each becomes an `IN (...)` clause when present, otherwise unfiltered on that column.

Handler flow:
1. `getSession(req)` → 401 if absent.
2. `checkAccess(session)` (calling card + exports tab) → 403 if denied.
3. Validate/parse `from`/`to` → 400 on bad input.
4. `getRefundExportCount(filters)` → if `> 10000`, 400 with `{ error, count }` so the UI can show "N rows match — narrow your date range".
5. `getRefundExportRows(filters, { includePii: session.isAdmin })` → capped `SELECT`.
6. `toCSV(rows, headers)` — reuses the existing generic CSV builder from `api/_lib/escalationCsv.js` (it already takes rows + a header list; nothing escalation-specific about the function itself).
7. Response: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="refund-export_<from>_to_<to>.csv"`, body = CSV text. An empty result set (count 0) still returns a valid header-only CSV, not an error.

### DB helpers (`api/_lib/db.js`)

Two new functions added alongside the other data-fetchers already in that file (matches the existing convention — escalation/RTO/NDR helpers all live here too, rather than splitting one file per feature):

- `getRefundExportCount(filters)` — same WHERE-building logic as below, `SELECT COUNT(*)`.
- `getRefundExportRows(filters, { includePii })` — builds the column list (base 21, +5 if `includePii`), same WHERE clause, `LIMIT 10000`.

The WHERE-clause construction (date range + optional IN-lists) is factored into one small pure function (e.g. `buildRefundExportWhere(filters)` returning `{ where, params }`) so it can be unit-tested without a DB connection (see Testing).

## Frontend — `app/refund-export/`

New Next.js page, same shape as `app/rto-crm`, `app/ndr-calling`:

- `page.js` — metadata + renders `RefundExportClient`.
- `RefundExportClient.js`:
  - Filter form: two native `<input type="date">` for `from`/`to` (both required, enforced before enabling the download button), a `<select multiple>` or checkbox group for `status`, plain `<select>` for `refundType` and `source` (all optional — "All" when nothing's selected).
  - "Download CSV" button, disabled while a request is in flight or while `from`/`to` are empty.
  - On click: `fetch('/api/refund-export?' + params)`, check `res.ok` — on failure, parse the JSON error body and show it (e.g. via a toast, matching whatever lightweight pattern the calling pages already use) rather than downloading garbage; on success, `res.blob()` → temporary `<a download>` click → revoke object URL. This mirrors `EscalationClient.js`'s existing `handleExport` exactly, not RTO CRM's client-side Blob-from-already-loaded-data pattern (that one applies when the data is already in page state; here it isn't — it's queried fresh per export).
  - No admin/PII-specific UI branching — the server decides what's in the file.

## Wiring the tab live

- `app/HomeClient.js`: change
  ```js
  exports: { label: 'Exports', text: 'Exports workspace is coming soon.' }
  ```
  to
  ```js
  exports: { label: 'Exports', text: 'Refund export', url: '/refund-export' }
  ```
  (matches the shape of `overview`/`rto`/`ndr`/`escalation` entries — `url` present means `selectCallingTeamView` routes the iframe there instead of showing the placeholder).
- `api/_lib/tabs.js` — no change; `exports` is already listed as a grantable tab under `calling`.

## Error handling summary

| Case | Response |
|---|---|
| Not signed in | 401 |
| No `calling` card / tab-restricted without `exports` | 403 |
| Missing/invalid `from` or `to`, or `to < from` | 400 |
| Filtered result `> 10,000` rows | 400, `{ error, count }` |
| Filtered result = 0 rows | 200, header-only CSV |
| DB error | 500 (logged server-side, matches every other handler in this codebase) |

## Testing

Per project convention, no script is run against the live table/DB from this session — verification of the actual export is the user's own. What ships with the change:

- One small assert-based test for `buildRefundExportWhere` (the WHERE/params builder): covers date-only, date+status, date+all filters, and comma-splitting into `IN (...)` lists — pure function, no DB needed.
- No test for `STR_TO_DATE` parsing itself (that's MySQL's own function, already exercised implicitly by the row-length/format checks done during this design).
