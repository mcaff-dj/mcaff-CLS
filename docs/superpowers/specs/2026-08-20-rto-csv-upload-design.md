# RTO CSV Upload — Design Spec

**Date:** 2026-08-20
**Status:** Approved by user, pending written-plan handoff

## Goal

An admin-only "Upload CSV" button in the RTO CRM. A CSV of new RTO leads is parsed,
deduplicated against the live sheet by AWB Code, checked for two disqualifying conditions
(already refunded via GoKwik, already re-punched under a D2C channel in LMD), and the
survivors are appended to the sheet as fresh unassigned leads — with disqualified rows
appended pre-stamped as disposed, exactly as `scripts/assign_leads.py` already stamps them
for its own pool.

## Why this isn't a simple upload

Two things push this past "parse CSV, write rows":

1. **The refund-status check requires data only reachable from Python.** GoKwik's
   refund-status-check API needs a numeric `platformOrderId`, resolved only via
   `Item_level_data` in the `mcaff_prod` MySQL schema (confirmed by reading both GoKwik
   call sites — see "Why Item_level_data is required" below). The Node API Lambda has no
   connection to that database, by design (see `api/rto/next-lead.js`'s own scope-cut, which
   made the same call for the same reason).
2. **Checking hundreds of prepaid rows against GoKwik cannot happen inside one browser
   request.** This API sits behind API Gateway, which enforces a hard ~29s timeout on the
   whole request regardless of either Lambda's own configured timeout. GoKwik throughput
   measured this session (~1.5s per 8-concurrent-check wave) means anything beyond roughly
   100–150 checks cannot safely complete inside that window, and the user has asked for real
   pacing between batches ("give breathing to API") on top of that — which only ADDS to the
   time, it doesn't fit inside a shorter window.

Both point the same direction: the check-and-append work has to run as a background job in a
new, purpose-built Lambda function with its own long timeout, invoked fire-and-forget by the
upload endpoint, with the browser polling for progress. This is the one meaningfully new piece
of infrastructure this feature needs; everything else reuses existing patterns.

## Why `Item_level_data` is required (not assumed)

Verified by reading both GoKwik call sites in this codebase, not inferred:

| | Identifier | Source |
|---|---|---|
| Refund-**initiate** (`api/refund/gokwik-initiate.js`, already in Node) | `moid` — built directly from the sheet's own Order ID + a vendor prefix | No lookup needed |
| Refund-**status-check** (`scripts/assign_leads.py`'s `_check_gokwik_refund_status_live`, what this feature needs) | `platformOrderId` — a different, GoKwik-internal numeric ID | `Item_level_data` is the only place this mapping exists (`lookup_platform_order_ids`) |

These are two structurally different GoKwik endpoints (`v2/order/refund/initiate` vs.
`v1/payments/refunds`) with different identifier conventions. The initiate endpoint's
DWH-free approach does not generalize to the status-check endpoint this feature needs.

## Architecture

### New components

- **`api/_lib/rtoCsvImport.js`** — pure logic: live-sheet header matching (see below), row
  validation, AWB normalization/dedup. No network calls. Tested directly.
- **`api/rto/upload/start.js`** — `POST`, admin-only. Fast: parses CSV, validates headers
  against the live sheet, dedupes by AWB (within-file and against the whole sheet), splits
  non-prepaid rows (no check needed, appended immediately) from prepaid rows (queued for the
  background worker). Creates a job row in Postgres, fires the worker, returns `{jobId}`
  immediately.
- **`api/rto/upload/status.js`** — `GET ?jobId=...`, admin-only. Reads the job row, returns
  progress.
- **`scripts/process_rto_csv_upload_job.py`** — the background worker's actual logic. Imports
  `check_already_punched`, `resolve_refund_statuses`, `lookup_platform_order_ids`, `is_prepaid`
  **unmodified** from `scripts/assign_leads.py` / `scripts/lead_priority.py` — this is what
  "use exactly same logic" means literally, not a JS mirror of it.
- **`lambda/csv_upload_worker/handler.py`** — thin entrypoint (same pattern as
  `lambda/assign_leads/handler.py`: imports the real script unmodified).
- **New Lambda function: `mcaff-cls-csv-upload-worker`** — its own function, not an extension
  of `assign-leads`, specifically so its timeout can be set generously **at creation** via
  `lambda/deploy_infra.sh` (a one-time bootstrap run with fuller IAM access than the
  constrained GitHub Actions deploy role, which today lacks
  `lambda:UpdateFunctionConfiguration` — confirmed blocked earlier this session). Proposed:
  1536 MB memory, 900s (15 min) timeout, reserved concurrency 1 (one upload job processed at a
  time — concurrent large uploads should be rare, and serializing them avoids two jobs racing
  on the same AWB-dedup read). Concurrency note: a second job's `/start` call still creates its
  Postgres row immediately (status `queued`) and fires its own Event invoke; if the worker is
  already busy with an earlier job, Lambda's own infrastructure queues that invocation and
  retries it automatically (standard async-invoke retry policy) rather than dropping it, so the
  second job simply waits in `queued` until the first finishes — no explicit queueing code
  needed on our side.
- **`api/_lib/lambdaTrigger.js`** — small extraction of `triggerImmediateLambdaAssignment` out
  of `api/auth/[action].js`, so this feature's fire-and-forget invoke doesn't duplicate the AWS
  SDK call in a second file. `api/auth/[action].js` updated to import from here instead of its
  own copy. No behavior change to existing callers.
- **New Postgres table: `rto_csv_upload_jobs`** — see schema below.
- **`app/rto-crm/RtoUploadModal.js`** — new client component, closely mirrors
  `app/escalation/EscalationClient.js`'s existing `ImportModal` (FileReader → JSON POST →
  poll → result stats), adapted for the async job/poll flow instead of a single synchronous
  response.

### Reused, unchanged

- `api/_lib/csv.js`'s `parseCSV` — used as-is.
- `scripts/assign_leads.py`'s `check_already_punched`, `resolve_refund_statuses`,
  `lookup_platform_order_ids`, `_gokwik_credentials` — imported and called, not duplicated.
- `scripts/lead_priority.py`'s `is_prepaid`.
- The existing GoKwik/MySQL credentials already available to the Python Lambda environment
  (`MYSQL_*`, `GOKWIK_*_APPID`/`_APPSECRET`) — no new secrets provisioned.

## Header matching (CSV can differ from the fixed 15-header list)

The live sheet's own header row (`Data!A1:AD1`) is the source of truth for what the 15 target
columns are called **right now** — never a hardcoded list in this code. Verified today: they
are currently `RTO Initiated Date, Latest NDR Date, RTO Reason, Order ID, Unique, AWB Code,
Customer Email, Customer Name, Customer Mobile, Address, Address City, Address State, Address
Pincode, Payment Method, Order Total`, mapping to columns B–P in that order — but the matcher
must not assume that positional alignment continues to hold; it matches by name.

Matching is **two-pass**, both passes normalizing text as `lowercase, strip non-alphanumeric`
(the same convention already used by `RtoCrmClient.js`'s own header-matching helper, `mapTkt`'s
`g()`):

1. **Exact pass:** for every target column, look for a normalized-equal CSV header among ones
   not yet claimed.
2. **Fuzzy pass:** for any target still unmatched, look for a substring match (either
   direction) among unclaimed CSV headers.

The exact pass runs for *all* target columns before the fuzzy pass touches any of them. This
resolves a real collision risk analyzed during design: `Address`, `Address City`,
`Address State`, `Address Pincode` all share the substring `address` once normalized. Because
all four are distinct strings even after normalization, the exact pass claims all four
correctly on its own — the ambiguous fuzzy fallback never gets a chance to misassign City data
into the Address column. Fuzzy matching only ever activates for a genuine wording difference
(e.g. CSV says "AWB Number" where the sheet says "AWB Code").

- CSV headers matching no target column: **ignored** (handles "extra columns").
- **AWB Code** and **Order ID** are the two required target columns. If either has no match
  (even after the fuzzy pass), the whole upload is rejected upfront with a message naming which
  is missing and listing the CSV's actual headers, so the admin can see why.
- The other 13 target columns are best-effort: if unmatched, that column is written blank for
  every row rather than failing the upload.

## Deduplication

- Dedup key: **AWB Code**, normalized as `trim().toUpperCase()`.
- Checked in two places: within the uploaded file itself (first occurrence wins, later ones
  rejected as "duplicate within file"), and against the sheet's **entire** existing AWB column
  (not just unassigned rows — a duplicate of an already-disposed or already-assigned lead is
  still a duplicate). One read of the sheet's AWB column builds this set; cheap, matches the
  cost profile of similar reads elsewhere in this session (~1s for a single column at current
  sheet size).
- A row with a **blank AWB Code** is rejected outright (per explicit decision) — it cannot be
  deduped or matched to a delivery partner later, and is reported as an error rather than
  silently appended or silently dropped.

## Check ordering (mirrors `assign_leads.py`'s own pool-processing order exactly)

For the set of rows that survive dedup:

1. **LMD punch-check first, for every row regardless of payment method** (COD included — a
   replacement order already punched makes the original RTO moot no matter how it was paid
   for, same reasoning as the existing check). One or a few batched `IN (...)` queries against
   `LMD.Display_Order_Code`, exactly as `check_already_punched` already does for the sweep's
   own pool. Fast — no GoKwik call, no chunking or pacing needed.
2. **Rows found already-punched are excluded from the refund-check** — the same optimization
   `assign_leads.py`'s own `main()` already applies ("no point paying a GoKwik round-trip for a
   lead that's already being excluded for a different reason"), reused here rather than
   reinvented.
3. **GoKwik refund-check, prepaid rows only** (via `is_prepaid` on the mapped Payment Method
   column), for whatever remains after step 2. This is the slow, rate-limited step: processed
   in chunks of ~100–150 with a deliberate pause between chunks (both bounds informed by
   measured GoKwik throughput and the ~29s constraint that motivated the background-job
   design in the first place — though inside the worker there is no 29s wall, chunking still
   matters for pacing against GoKwik's own rate limits and for writing progress the browser can
   poll).
4. **Final batched write.** One `values.append` call (`insertDataOption=INSERT_ROWS`) writes
   every surviving row. Column A and Q-onward blank for a genuinely fresh row. A row confirmed
   already-refunded or already-punched is instead written with S/T/U pre-filled exactly as
   `assign_leads.py` already stamps its own pool:
   - Refunded: `S=Already Refunded, T=Already Refunded, U=Auto-detected via GoKwik refund
     status check - not assigned.`
   - Punched: `S=Already Punched, T=Already Punched, U=Auto-detected via LMD (D2C channel) -
     order already punched, not assigned.`

   This is one write regardless of how many rows are in the batch — the direct lesson from
   today's Sheets-API-429 incident (see `git log` for `next-lead.js`'s own batching fix).

Note step 3's "before assigning, refund check has to be done again" requirement needs **no new
code at all**: `assign_leads.py`'s existing sweep already re-checks every prepaid
unassigned/undisposed lead unconditionally on every run — this feature's newly-appended rows
are indistinguishable from any other unassigned row to that existing logic.

## Job schema (Postgres, `rto_csv_upload_jobs`)

```sql
CREATE TABLE rto_csv_upload_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'queued' is set by /start, before the worker Lambda has actually begun processing this
  -- job - see the concurrency note below for why that gap can be non-trivial.
  status TEXT NOT NULL,               -- 'queued' | 'checking_punch' | 'checking_refund' | 'appending' | 'done' | 'failed'
  created_by TEXT NOT NULL,           -- uploading admin's email
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_rows INTEGER NOT NULL,        -- rows that survived dedup, i.e. candidates for this job
  prepaid_count INTEGER NOT NULL,
  checked_count INTEGER NOT NULL DEFAULT 0,   -- prepaid rows GoKwik-checked so far
  already_refunded_count INTEGER NOT NULL DEFAULT 0,
  already_punched_count INTEGER NOT NULL DEFAULT 0,
  appended_count INTEGER NOT NULL DEFAULT 0,
  duplicate_in_sheet_count INTEGER NOT NULL DEFAULT 0,
  duplicate_in_file_count INTEGER NOT NULL DEFAULT 0,
  missing_awb_count INTEGER NOT NULL DEFAULT 0,
  rows_pending JSONB,                 -- the validated, deduped rows awaiting worker processing;
                                       -- cleared (set NULL) once the job reaches 'done' or 'failed'
  errors JSONB,                       -- capped sample, {line, reason}[], max 50
  error_message TEXT                  -- set only if status = 'failed'
);
```

Rows are held as JSONB directly on the job row rather than a separate child table — one-shot,
bounded-size (capped by the row limit below), no need for a queryable child table.

## Caps

- **Row cap:** reject upfront above 5,000 **parsed** data rows (checked immediately after
  `parseCSV`, before header validation or dedup — the cheapest possible point, so an absurdly
  oversized file is rejected before any sheet read happens at all). Defensive default against
  an accidental oversized paste/export; revisit if a real use case needs more.
- **Refund-check chunk size:** ~100–150 prepaid rows per chunk (bounded by measured GoKwik
  throughput, with margin).
- **Errors in the API response:** capped at 50 entries; the summary counts are always exact
  even when the list is truncated.

## Access control

Admin-only: `session.isAdmin` **and** the existing `calling`/`rto` card+tab check every other
RTO endpoint in this codebase uses. Uploading into a shared, live operational sheet is
consequential enough to restrict beyond ordinary agent access, consistent with this
codebase's existing convention for similarly impactful actions (admin bulk reassign, "mark all
agents Offline").

## Client UX

- "Upload CSV" button (admin-only), opens a modal closely mirroring the Escalation desk's
  existing `ImportModal`: drop-zone / file picker, sample-format hint.
- On submit: `POST /api/rto/upload/start`, receive `jobId`, begin polling
  `GET /api/rto/upload/status?jobId=...` every few seconds.
- While in progress: show live counts (`checked/total prepaid rows`, running
  already-refunded/already-punched tallies).
- On completion: final summary (`appended`, `already refunded`, `already punched`, `duplicate
  in sheet`, `duplicate in file`, `missing AWB`, capped error list) and a `sync(true)` to pull
  the new rows into the visible ticket list.

## Error handling

- Malformed/unparseable CSV, missing required headers, or row-cap exceeded: rejected at
  `start`, nothing written, nothing queued.
- A row-level problem (blank AWB, duplicate) never fails the whole upload — collected and
  reported, matching the existing convention in `api/escalation/[action].js`'s own import
  action.
- If the background worker fails partway (e.g. a MySQL or Sheets error mid-job): job status set
  to `failed` with `error_message`, rows already appended before the failure stay appended (no
  attempt to "undo" a partial run) — this favors "some correct progress" over an all-or-nothing
  rollback, and matches the same non-transactional reality every other Sheets-writing path in
  this codebase already lives with.
- The final `values.append` is one atomic call, so within that single step there's no partial
  Sheets state to reason about.

## Prerequisites / dependencies

- The LMD punch-check reuse (`check_already_punched`, `ALREADY_PUNCHED`, `LMD_TABLE`) currently
  exists only in the user's own **uncommitted** working copy of `scripts/assign_leads.py` at
  the time this spec was written. That work needs to be committed (independently of this
  feature) before `scripts/process_rto_csv_upload_job.py` can import it.

## Testing

- `api/_lib/rtoCsvImport.test.js` (pure, no network/DB — same pattern as this session's
  `next-lead.test.js`/`leadQuota.test.js`):
  - Exact header match.
  - Fuzzy fallback (e.g. "AWB Number" matching sheet's "AWB Code").
  - The Address-family collision scenario, proving it resolves via the exact pass.
  - An unrelated extra CSV column being ignored.
  - Required-column-missing rejection (AWB Code and/or Order ID absent).
  - AWB normalization and within-file dedup.
  - Blank-AWB rejection.
- The live Sheets read/append, the Postgres job read/write, and the background worker's
  MySQL/GoKwik calls are **not** unit-tested from this environment — consistent with the
  acknowledged limitation already stated for every other endpoint built this session
  (`claim.js`, `next-lead.js`): no live server available here to exercise them end-to-end.

## Explicitly out of scope

- Editing or re-uploading to correct a previously-uploaded row — this feature only appends.
- Any change to how `assign_leads.py`'s own periodic sweep processes its pool — this feature
  produces rows for that pool, it does not touch the pool-processing logic itself.
- Connected=No reassignment, agent specializations, or prepaid-target ratio steering for
  uploaded rows — irrelevant at upload time (rows are fresh, never-touched leads).
