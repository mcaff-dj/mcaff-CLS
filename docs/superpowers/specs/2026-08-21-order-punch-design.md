# Order Punch — Design Spec

**Date:** 2026-08-21
**Status:** Approved by user, pending written-plan handoff

## Goal

Port the existing "Repunch Pipeline" Google Apps Script (Sheets-based, one Unicommerce
account, chunked via time-based triggers) into this app as a new admin-only "Order Punch" tab
next to Refund Export in the Calling Team's Exports view. Same business logic (search →
resolve target channel → build payload → create sale order in Unicommerce), same guardrails
(DELIVERED-order block, N-day repunch cooldown, duplicate-suffix `_1`/`_2` handling, crash-safe
resume, duplicate-create recovery on retry) — different execution substrate (Postgres job table
+ a dedicated long-timeout Lambda instead of Script Properties + Apps Script triggers).

## Why this isn't a simple new page

1. **Same "long job, short request window" problem this codebase already solved once.** API
   Gateway enforces a hard timeout well under what 1,000+ Unicommerce order creations need
   (the source script itself was built around Apps Script's 6-minute execution cap, chunking
   via a self-rescheduling trigger). `docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md`
   solved the equivalent problem for RTO CSV uploads: fire-and-forget background Lambda with its
   own long timeout, a Postgres job-status row, browser polling. Order Punch reuses that shape.
2. **No cap on job size (explicit decision — see below), so per-row status can't live in one
   JSONB blob.** The RTO job's `rows_pending` JSONB works because it's write-once at start,
   read-once at completion. Order Punch writes a status to every row as it's processed and (by
   choice) has no upper bound on row count, so per-row state needs its own table, not one growing
   JSON column rewritten every row.
3. **No Unicommerce integration exists anywhere in this codebase today.** This is a wholly new
   external integration (auth, search, get, create endpoints), not a variation on an existing one.

## Architecture

### New components

- **`api/_lib/orderPunch.js`** — pure logic, no network calls, unit-tested directly:
  - `resolveTargetChannel_` — channel routing (MCAFFEINE_CHANNELS / HYPHEN_CHANNELS → target).
  - `buildCreatePayload_` — builds the Unicommerce `saleOrder/create` payload from a fetched
    order DTO, new display code, resolved SO code, target channel, facility code, reason
    (→ `giftMessage`), triggering agent's email (→ `voucherCode`).
  - `pickSoCode_` — picks `displayOrderCode` or `_1`/`_2` suffix based on existing codes + same-
    channel check.
  - `extractStatus_` / `extractCreatedDate_` / `parseTimestamp_` — tolerant field extraction from
    Unicommerce search/get responses (field names vary; auto-scan fallback), used for the
    DELIVERED check and the cooldown check.
  - Ported 1:1 from the Apps Script's own `resolveTargetChannel_`, `buildCreatePayload_`,
    `pickSoCode_`, `extractStatus_`, `extractCreatedDate_`, `parseTimestamp_` — same behavior,
    same edge cases, translated from Apps Script's `UrlFetchApp` to Node `fetch`.

- **`api/_lib/orderPunchClient.js`** — Unicommerce HTTP calls (the network half, kept separate
  from the pure logic above so the logic stays unit-testable without mocking HTTP):
  `getUcToken_` (OAuth), `searchDisplayCode_`, `getOrder_`, `createOrder_`,
  `searchAndResolve_` (combined search + DELIVERED check + cooldown check + existing-codes map),
  `getOrderDto_`. Same retry/backoff behavior as the script: one retry with a 10s pause on
  403/429, `TOKEN_EXPIRED` signaling on 401.

- **`api/order-punch/start.js`** — `POST`, admin-only (`session.isAdmin` + existing
  calling/exports tab-permission check, same gate as `refund-export.js`'s `checkAccess` plus the
  admin requirement — matching the RTO CSV upload's access convention). Accepts
  `{ rows: [{doc, reason, facility_code}] }` — the same shape whether it came from a parsed CSV
  or the manual multi-row form; validates (non-empty `doc` required per row; `reason`/
  `facility_code` optional), creates one `order_punch_jobs` row + one `order_punch_job_rows` row
  per input row, fires the worker Lambda (event/async invoke, same pattern as
  `api/_lib/lambdaTrigger.js`'s `triggerImmediateLambdaAssignment`), returns `{jobId}`
  immediately. No row cap (explicit decision — pacing/backoff inside the worker is what protects
  Unicommerce, not an upload-time limit).

- **`api/order-punch/status.js`** — `GET ?jobId=`, admin-only. Reads the job row's counters,
  returns `{status, total_rows, processed_count, success_count, error_count, skipped_count}`.

- **`api/order-punch/stop.js`** — `POST {jobId}`, admin-only. Sets `stop_requested = true` on the
  job row (checked by the worker between rows and between chunks — mirrors the script's
  `REPUNCH_STOP` flag).

- **`api/order-punch/results.js`** — `GET ?jobId=`, admin-only. Streams a CSV
  (`display_order_code, reason, facility_code, status, so_code, target_channel, error_message`)
  built from `order_punch_job_rows`, ordered by `row_index` — same `toCSV` helper
  `refund-export.js` already uses.

- **`api/order-punch/settings.js`** — `GET`/`PUT`, admin-only. Reads/writes
  `order_punch_settings` (facility codes, channel-routing lists, cooldown days, max suffix).

- **New Lambda function `mcaff-cls-order-punch-worker`** — own function (via
  `lambda/deploy_infra.sh`, same reasoning as `mcaff-cls-csv-upload-worker`: needs a timeout the
  constrained GitHub Actions deploy role can't set after creation). Proposed 900s timeout, 512MB
  memory (HTTP-call-bound, not compute-bound), **reserved concurrency 1** — serializes all order-
  punch work (this job's own chunks *and* any other queued job) to avoid two workers racing the
  same display-code's `_1`/`_2` suffix assignment or doubling up on Unicommerce rate-limit
  backoff. A job that can't finish in one invoke's ~800s working window (leaving ~100s buffer for
  final DB writes and the self re-invoke call) writes its progress and fires an async
  self-invoke to continue from where it left off — the same "always resume, even on crash"
  design as the script's `continueRepunch_`/`scheduleContinuation_`, just via Lambda's own async
  invoke instead of a time-based Apps Script trigger. Per-chunk: fetch a Unicommerce OAuth token
  once, refresh it every ~2 minutes during the loop (`TOKEN_REFRESH_MS`, ported as-is), process
  rows with `status = 'pending'` in `row_index` order, `SLEEP_BETWEEN` (500ms) between orders,
  `BACKOFF_ON_403` (10s) + `MAX_CONSECUTIVE_403` (5 → 30s cooldown) ported unchanged as fixed
  tuning constants (not admin-editable — these govern Unicommerce rate-limit behavior, not
  business rules).

- **`lambda/order_punch_worker/handler.js`** — thin entrypoint, imports
  `api/_lib/orderPunch.js` + `api/_lib/orderPunchClient.js` unmodified (same pattern as
  `lambda/csv_upload_worker/handler.py` importing the Python script unmodified).

- **New Postgres tables** — see schema below.

- **New secret `mcaff-cls/unicommerce`** in AWS Secrets Manager (`{username, password}`),
  read via the same lazy-singleton `SecretsManagerClient` pattern `api/_lib/db.js` uses for the
  DB secret. The worker Lambda's IAM role gets `secretsmanager:GetSecretValue` scoped to this
  secret's ARN. The credential value itself is set by a human directly in AWS (console or CLI)
  — never written into this codebase or its deploy scripts.

- **`app/exports/ExportsClient.js`** — new hub page: a tab bar (Refund Export | Order Punch).
  Refund Export tab renders the existing `RefundExportClient`. Order Punch tab renders the new
  `OrderPunchClient` (admin-only — non-admins see the existing Refund Export tab only, or an
  "admin only" message if they land on the Order Punch tab directly). `HomeClient.js`'s
  `CALLING_TEAM_SUBITEMS.exports.url` changes from `/refund-export` to `/exports`. The old
  `/refund-export` route stays working (kept as a thin page still rendering
  `RefundExportClient` directly, or a redirect to `/exports` — implementation detail for the
  plan) so nothing that already links straight to it breaks.

- **`app/exports/OrderPunchClient.js`** — CSV dropzone (mirrors `RtoUploadModal`'s
  FileReader → parse → build-rows flow) **and** a manual multi-row form (add a row: order code +
  optional reason + optional facility code) — both build the same `{doc, reason,
  facility_code}[]` array and POST it to `/start`. After starting: polls `/status` every few
  seconds, shows a progress bar + live success/error/skipped counts. On completion: "Download
  Results CSV" button hits `/results?jobId=`. A "Stop" button (visible while running) hits
  `/stop`. A separate small "Settings" panel (admin-only, same tab) edits
  `order_punch_settings` as a plain form.

### Reused, unchanged

- `api/_lib/csv.js`'s `parseCSV`/`toCSV`.
- `api/_lib/lambdaTrigger.js`'s fire-and-forget Lambda invoke pattern.
- `refund-export.js`'s `checkAccess` shape (card+tab permission check), extended with an
  `isAdmin` requirement.
- The Apps Script's own business logic, verified field-for-field against the pasted script:
  DELIVERED-status block, `REPUNCH_COOLDOWN_DAYS` (3-day) cooldown check via every sale order
  found for a display code, duplicate-suffix `_1`/`_2` picking, and the "duplicate-create
  recovery" logic (if a retry finds the previously-attempted SO code already exists in
  Unicommerce, mark success instead of re-creating).

## Field mapping (confirmed with user — differs from the script's own header comment)

The script's header comment claims column B ("Comments/Reasoning") → `giftMessage` and column E
("Email ID") → `voucherCode`; the actual `buildCreatePayload_` code does exactly that (the
comment is accurate to the code, just easy to misread as swapped at a glance). Confirmed to
port as-is:

- **Reason/comment** (free text, one per row) → `giftMessage` on every sale order item.
- **Triggering agent's email** (auto-captured server-side from `session.email`, not typed by the
  agent — replaces the script's `onEdit`-driven auto-fill from `Session.getActiveUser().getEmail()`)
  → `voucherCode` on every sale order item. This preserves the existing audit-trail behavior
  (who triggered each repunch, visible on the created order) rather than sending a real voucher
  code.

## Job schema (Postgres)

```sql
CREATE TABLE order_punch_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL,                -- 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  created_by TEXT NOT NULL,            -- triggering admin's email
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_rows INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  stop_requested BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT                   -- set only if status = 'failed' (unrecoverable, not a
                                        -- per-row failure)
);

CREATE TABLE order_punch_job_rows (
  job_id UUID NOT NULL REFERENCES order_punch_jobs(id),
  row_index INTEGER NOT NULL,
  display_order_code TEXT NOT NULL,
  reason TEXT,
  facility_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'success' | 'error' | 'skipped'
  so_code TEXT,                        -- the SO code created (on success) or attempted
  target_channel TEXT,
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, row_index)
);

CREATE TABLE order_punch_settings (
  key TEXT PRIMARY KEY,                -- 'facility_codes' | 'mcaffeine_channels' |
                                        -- 'hyphen_channels' | 'target_mcaffeine' |
                                        -- 'target_hyphen' | 'cooldown_days' | 'max_suffix'
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);
```

Bootstrapped with the script's current constants as defaults (`ALL_FACILITY_CODES`,
`MCAFFEINE_CHANNELS`, `HYPHEN_CHANNELS`, `TARGET_MCAFFEINE`, `TARGET_HYPHEN`,
`REPUNCH_COOLDOWN_DAYS = 3`, `MAX_SUFFIX = 2`) so behavior is identical on day one; admins can
change them afterward without a deploy.

## Access control

Admin-only (`session.isAdmin`) **and** the existing `calling`/`exports` card+tab permission
check every other Exports endpoint uses. Creating live orders in Unicommerce is more
consequential than a read-only CSV export, consistent with this codebase's existing convention
for similarly impactful actions (RTO CSV upload, bulk reassign).

## Error handling

- Row validation (blank `display_order_code`) rejected per-row at `/start` — collected as
  errors in the response, not silently dropped; rows that DO pass validation are still queued
  even if others in the same submission failed validation (matches the existing convention in
  `api/escalation/[action].js`'s import action and the RTO upload's row-level error handling).
- A single order's failure (Unicommerce error, still-rate-limited after retry, no order found)
  never fails the job — recorded on that row as `status = 'error'` with `error_message`,
  processing continues to the next row. Retryable errors (`TOKEN_EXPIRED`, `RATE_LIMITED`, 401,
  403, "No order found") get one retry with a fresh token, exactly as the script does.
- Worker crash mid-chunk: caught at the outer handler; if the job isn't `stop_requested`, it
  still fires a self-invoke to continue (matches the script's crash-resume design) rather than
  leaving the job stuck in `running` forever. The job is marked `failed` only for an
  unrecoverable *outer* error (can't reach the secret, can't reach Postgres) — never for
  individual row failures.
- Duplicate-create recovery: if a retry's search finds the previously-attempted SO code already
  present in Unicommerce (create succeeded despite an error response), that row is marked
  `success` rather than attempting a second create — ported directly from the script's
  `attemptedSoCode` / duplicate-guard logic.

## Testing

- `api/_lib/orderPunch.test.js` — pure logic, no network: `resolveTargetChannel_` for every
  known channel plus the `HYP`-prefix fallback, `pickSoCode_` suffix picking and max-suffix
  exhaustion, `buildCreatePayload_` field mapping (reason → `giftMessage`, email → `voucherCode`,
  facility propagation), `extractStatus_`/`extractCreatedDate_` field-name fallback + auto-scan,
  `parseTimestamp_` for epoch-ms/epoch-s/ISO-string inputs.
- `api/order-punch/start.test.js` — access control (non-admin 403, missing perm 403), row
  validation (blank doc rejected, valid rows still queued), no live DB/Lambda/Unicommerce calls
  — consistent with this codebase's no-live-testing convention.
- The worker Lambda's live Unicommerce calls, the Postgres job read/write, and the self-invoke
  continuation are **not** exercised end-to-end from this environment — same acknowledged
  limitation already stated for the RTO CSV upload job.

## Explicitly out of scope

- Editing a job's rows after submission, or re-running only the failed rows of a completed job
  (a fresh submission with just those rows achieves the same result).
- Any change to how Unicommerce itself processes created orders — this only creates them.
- A generic settings/config framework — `order_punch_settings` is this feature's own small table,
  not a reusable system for other features.
