# Product Calling — Design Spec

**Date:** 2026-09-16
**Status:** Approved in chat, awaiting written-spec review before writing the implementation plan
**Follows:** `2026-09-05-nps-calling-round-robin-design.md` (auto-assign trigger pattern this spec
copies) and `2026-09-06-nps-calling-product-leads-design.md` (the closest prior example of adding
a new pool to the calling system).

## Goal

Add a fifth Calling Team sidebar item, "Product Calling", below "NPS-Calling" — a full agent
calling workspace (not a report), reusing the already-scaffolded `productkyc` process key in
`api/_lib/callingProcesses.json` (currently `implemented: false`, label "Product KYC Calling",
business hours already set to 10:00-19:00 IST Mon-Sat).

## Scope decisions (confirmed with user)

| Decision | Choice |
| --- | --- |
| Process identity | Reuse existing `productkyc` key. Rename label to "Product Calling". Flip `implemented: true`. |
| Lead source | Unknown/TBD — user will share the real phone-number sheet later. Until then, leads enter via admin CSV upload directly into this process's own MySQL table. |
| Assignment model | Round-robin auto-assign, same trigger shape as NPS-Calling (`detractor`) — not RTO's manual-claim-from-queue model. |
| Disposition tree | Admin-configured later from the Admin Panel's existing generic Disposition List UI — no code needed, no seed data. |
| Per-product bespoke KYC question form (`productkyc_config.py`'s categorical/freeText fields) | Out of scope for this spec. The call form captures a generic disposition + remarks, same as NDR/Escalation. Revisit only if the user asks for the bespoke survey-by-phone form later. |
| Lead-type / brand split | None. One shared pool, one shared quota — unlike NPS-Calling's delivery/product split, there is no second pool here to split against. |

## Why this differs from NPS-Calling's copy-on-assign pattern

NPS-Calling copies rows out of a read-only DWH table (`nps_delivery`/`nps_product`) into
`CLS_NPS_calling` at claim time, because the DWH table is the durable source of truth and must
stay untouched. Product Calling has no such external source table yet — the CSV upload writes
leads straight into this process's own table as unassigned rows (`agent_email IS NULL`). Claiming
a lead is therefore a single `UPDATE ... WHERE agent_email IS NULL LIMIT 1`-shaped claim, not an
`INSERT ... SELECT`-shaped copy. When the real sheet/source is confirmed later, swapping the CSV
importer for a scheduled pull is a contained change to the import path only — the table shape,
claim/assign/dispose functions, and every API/UI piece above them are unaffected.

## Schema — `api/_lib/db.js`

### `CLS_productcalling` — new table

```sql
CREATE TABLE IF NOT EXISTS CLS_productcalling (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lead_ref VARCHAR(64) NOT NULL,        -- import-supplied external id, for dedup on re-upload
  customer_name VARCHAR(255),
  customer_phone VARCHAR(32) NOT NULL,
  customer_email VARCHAR(255),
  product_key VARCHAR(100),             -- free text at import time; not validated against
                                         -- productkyc_config.py's PKYC_PRODUCTS in this spec
  product_category VARCHAR(100),
  notes TEXT,                           -- whatever context column(s) the CSV brings, concatenated
  imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  imported_by VARCHAR(320),
  agent_email VARCHAR(320) NULL,
  assigned_at TIMESTAMP NULL,
  reassigned_away_at TIMESTAMP NULL,
  disposed_at TIMESTAMP NULL,
  disposition TEXT,
  agent_remarks TEXT,
  connected VARCHAR(10),
  attempt INT,
  live_lead_ref VARCHAR(80) GENERATED ALWAYS AS
    (IF(reassigned_away_at IS NULL, lead_ref, NULL)) VIRTUAL,
  UNIQUE KEY cls_productcalling_live_lead_ref_key (live_lead_ref)
)
```

`live_lead_ref` is the same live-cycle trick `CLS_NPS_calling.live_response_id` and
`CLS_RTO_calling.live_order_id` already use: `NULL` once reassigned, so a retired cycle and its
replacement can coexist under one `UNIQUE KEY`. No `lead_type`/`team_id` columns — this process
has neither split.

### `calling_agent_process` — no new columns

Reused as-is with `process_key = 'productkyc'`. No brand/category filter column, unlike NPS-
Calling's `detractor_brand_filter` — YAGNI until the user asks for one.

### `calling_process_dispositions` — no schema change

Already generic per `process_key`. Rows for `productkyc` get created later from the Admin Panel;
nothing to migrate.

## Claim / assignment logic — `api/_lib/db.js`

New functions, same shape as their `*Detractor*` equivalents but against the single local table:

- `PRODUCTCALLING_FALLBACK_QUOTA = 15` — same fallback constant pattern as
  `DETRACTOR_FALLBACK_QUOTA` (db.js:1864).
- `getProductCallingAgentQuota(email)` / `getProductCallingAgentAvailability(email)` — read
  `calling_agent_process` filtered to `process_key = 'productkyc'`, same shape as
  `getDetractorAgentQuota`/`getDetractorAgentAvailability` (db.js:1869-1895).
- `getProductCallingLoadByAgent(email)` — `COUNT(*)` of this agent's undisposed live rows, same
  shape as `getDetractorLoadByAgent` (db.js:1900-1907).
- `getProductCallingQuotaAndLoad(email)` — same override → `calling_process_settings.default_quota`
  → fallback chain as `getDetractorQuotaAndLoad` (db.js:1914-1920).
- `claimNextProductCallingLead(email)` — the one real departure from the Detractor shape: instead
  of peek-then-insert-copy, this is `UPDATE CLS_productcalling SET agent_email=?, assigned_at=NOW()
  WHERE agent_email IS NULL ORDER BY imported_at [ASC|DESC per getCallingLeadOrder('productkyc')]
  LIMIT 1` followed by a `SELECT` of the claimed row (MySQL has no `UPDATE ... RETURNING`). Wrapped
  the same `ER_DUP_ENTRY`-retry way `assignDetractorLeadsToAgent`'s inner loop already handles, in
  case of a race between two agents' claims (the `UPDATE ... LIMIT 1` itself is not race-free
  across two simultaneous callers without that retry, same reasoning as RTO's claim path).
- `assignProductCallingLeadsToAgent(email, maxCount)` — same claim-loop shape as
  `assignDetractorLeadsToAgent` (db.js:2183-2206), calling `claimNextProductCallingLead`.
- `topUpProductCallingAgent(email, deps = {})` — same shape as `topUpDetractorAgent`
  (db.js:2229-2238): checks availability, then quota vs. load, then assigns the gap.
- `disposeProductCallingLead(leadRef, disposition, agentRemarks, connected, attempt, email,
  { allowAnyAgent = false } = {})` — same shape as `disposeDetractorLead` (db.js:2294-2315),
  ownership enforced in the `WHERE` clause, `allowAnyAgent` for admin override.
- `getProductCallingTicketsForAgent(email)` / `getAllProductCallingTickets()` — same shape as
  db.js:2318-2331.
- `getUnassignedProductCallingLeads(limit = 20)` — read-only preview for the admin "Next to Assign"
  tab, single-pool (no delivery/product merge needed), oldest/newest by `imported_at`.

## Lead intake — CSV import

New `api/productcalling/upload.js`, admin-only (mirrors the admin-gating in `api/ndr/upload.js` /
`api/rto/upload.js`), but a lighter-weight importer than `rtoCsvImport.js`'s engine — that engine's
job is syncing rows into a **live Google Sheet** (column-letter mapping, header-drift detection,
scientific-notation AWB handling), which doesn't apply here since Product Calling has no backing
Sheet at all, same as NPS-Calling. Instead:

- Required CSV headers: `Customer Name`, `Customer Phone`. `Lead Ref` is optional; when the CSV
  omits it, `customer_phone` is used as `lead_ref` (phone is the only field guaranteed present and
  stable across a re-upload until the real export defines a proper external id).
- Optional headers: `Customer Email`, `Product`, `Product Category`, `Notes`.
- Row-level validation: phone required and non-empty; malformed rows are skipped and reported back
  to the uploader by row number (same "never silently drop, always report" convention
  `ndrCsvImport.js`'s `attemptCountAllowed`/`describeAttemptRule` follow), not written.
- Dedup on `lead_ref` (or phone, if that's the interim key) via `INSERT IGNORE` against
  `CLS_productcalling.lead_ref` — a re-upload of the same export does not duplicate live rows.
- This importer is intentionally isolated to its own file/route so that swapping it for a scheduled
  pull from the real source later touches nothing else in this spec.

## Trigger wiring — `api/auth/[action].js`

Two existing hardcoded `processKey === 'detractor'` branches gate NPS-Calling's auto-assign
triggers:

- `handleProcessPresence`'s going-Online fill (`api/auth/[action].js:368` region, the
  `body.processKey === 'detractor' && body.status === 'Online'` branch, and the twin at line 588).
- `handlePresence`'s 2-minute heartbeat top-up (same file, ~line 368 as read above).

Add analogous `body.processKey === 'productkyc' && ...` branches calling
`topUpProductCallingAgent(session.email)`, gated by a new `hasProductCallingAccess(session)` helper
— same shape as `hasDetractorAccess` (api/auth/[action].js:17-21), checking
`session.tabPerms.calling` includes `'productkyc'`.

Self-refill on dispose: `api/productcalling/lead-assignment.js`'s dispose handler re-checks
availability/quota and calls `assignProductCallingLeadsToAgent(email, 1)` after a successful
dispose, same shape as `api/detractor/lead-assignment.js:62-80`.

## API routes — new

- `api/productcalling/lead-assignment.js` — POST-only, single `dispose` action (no manual claim —
  leads only arrive via auto-assign, same as NPS-Calling), triggers self-refill.
- `api/productcalling/tickets.js` — GET-only: agent's own tickets, admin `?scope=all` /
  `?scope=unassigned` preview.
- `api/productcalling/upload.js` — POST, admin-only, CSV import described above.

## Permissions / sidebar / business hours — no new code

- `api/_lib/tabs.js:75-83` already generates the Admin → Permissions → Calling checkbox from every
  `callingProcesses.json` entry — `productkyc` already appears there today. No change needed beyond
  the label rename.
- Business hours, roster, presence are already generic over `process_key` via
  `api/_lib/callingTeams.js` and `callingProcesses.json`'s per-process `businessHours` block — no
  change needed beyond flipping `implemented: true`.
- `app/HomeClient.js`'s `CALLING_TEAM_SUBITEMS` (line 71-82): add
  `productkyc: { label: 'Product Calling', text: 'Product Calling Agent Portal', url:
  '/product-calling' }` immediately after the `detractor` entry, before `exports` — object key
  order is render order (line 229/236), so this alone places it directly below NPS-Calling with no
  other layout change.

## Frontend

- `app/product-calling/page.js` — trivial Server Component wrapper, same shape as
  `app/nps-calling/page.js` (9 lines).
- `app/product-calling/ProductCallingClient.js` — modeled directly on `NpsCallingClient.js`'s
  overall shape but simpler (no lead_type split, no per-area survey rendering):
  - `useCallingSession('productkyc', {...})` for auth/roster/status.
  - Reuses `useBusinessHours`/`CallingHoursCard`, `useDefaultQuota`/`DefaultQuotaCard`,
    `useLeadOrder`/`LeadOrderCard`, `useProcessDispositions`/`ProcessDispositionsCard` from
    `app/_calling/CallingAdminPanel.js`, unmodified.
  - `CallingShell` for the outer chrome, same as every other calling page.
  - Own state: Fresh/All/Admin tabs, ticket list (name, phone, product, imported date), dispose
    modal (disposition tree + remarks + connected/attempt, same fields NDR/Escalation use) —
    genuinely new code, this process's own concern.
  - Admin CSV upload UI in the Admin tab, modeled on `RtoUploadModal.js`'s shell (overlay, file
    picker, result summary) but posting to `api/productcalling/upload.js`.

## Testing

No live-DB or dev-server runs (user tests live). Pure-logic pieces get an `assert`-based
self-check or a co-located `*.test.js`, per repo convention:

- CSV import: header validation, row-level skip-and-report on missing phone, dedup on `lead_ref`
  across a re-upload — same shape as `ndrCsvImport.test.js`.
- Claim/assign: `claimNextProductCallingLead` returns `null` when the pool is empty; two concurrent
  claims never double-assign the same row (dup-retry path); `topUpProductCallingAgent` no-ops for
  an Offline or already-full agent.
- Dispose: ownership enforced (wrong agent's dispose is a no-op) unless `allowAnyAgent`; self-refill
  fires exactly one re-assign attempt per successful dispose.

Manual verification steps for the user:

1. Admin uploads a CSV of leads on the Product Calling Admin tab; rows appear as unassigned.
2. An agent going Online fills to quota from those rows; a 2-minute heartbeat top-up picks up rows
   uploaded after they went Online.
3. Disposing a ticket removes it from the agent's Fresh queue and immediately backfills one more,
   if available.
4. Admin Panel's Disposition List, Business Hours, Default Quota, and Lead Order cards all work for
   `productkyc` exactly as they do for the other processes, with no code changes.
5. Sidebar shows "Product Calling" directly below "NPS-Calling", above "Exports".

## Out of scope

- The real lead source (sheet/table + join key) — CSV upload is the interim mechanism; revisit once
  the user shares it.
- The bespoke per-product KYC question form from `productkyc_config.py` — this spec's call form is
  a generic disposition, not the survey itself.
- Any brand/category filter on `calling_agent_process` — add only if requested.
- A seeded starter disposition tree — admin configures from scratch via the existing UI.
