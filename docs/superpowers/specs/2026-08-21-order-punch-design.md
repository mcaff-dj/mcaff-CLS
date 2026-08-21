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

### Worker language: Python, not Node

Every existing background-worker Lambda in this repo (`assign_leads`, `assign_ndr_leads`,
`csv_upload_worker`) is Python, deployed via `lambda/build.sh` + `lambda/deploy_infra.sh`,
talking to Postgres via `psycopg` (`scripts/lib.py`'s `get_pg_connection`) directly — not through
`api/_lib/db.js`. There is no Node-Lambda build path in this repo at all. Order Punch's worker
follows that exact convention rather than introducing a new one: the entire repunch business
logic (channel routing, payload building, SO-code picking, status/date extraction, the
Unicommerce HTTP calls themselves) lives in Python, in `scripts/process_order_punch_job.py`. No
JS port of this logic exists or is needed — the Node `/start` endpoint only validates rows and
queues them, it never executes repunch logic itself, so (unlike RTO's `is_prepaid`, which
genuinely is needed on both sides) there is no cross-language duplication to keep in sync.

### New components

- **`scripts/process_order_punch_job.py`** — the worker's real logic, run standalone or imported
  by the Lambda handler below (same `if __name__ == "__main__": process_job(int(sys.argv[1]))`
  convention as `process_rto_csv_upload_job.py`):
  - `resolve_target_channel(current_channel)` — channel routing (`MCAFFEINE_CHANNELS` /
    `HYPHEN_CHANNELS` → target), pure function.
  - `pick_so_code(display_order_code, same_channel, existing_codes)` — picks the bare code or a
    `_1`/`_2` suffix, pure function.
  - `build_create_payload(order, new_display_code, so_code, target_channel, facility_code,
    reason, agent_email)` — builds the Unicommerce `saleOrder/create` payload; `reason` →
    `giftMessage`, `agent_email` → `voucherCode` (see Field mapping below), pure function.
  - `extract_status(obj)` / `extract_created_date(obj)` / `parse_timestamp(val)` — tolerant field
    extraction from Unicommerce search/get responses (field names vary; auto-scan fallback), pure
    functions, used for the DELIVERED check and the cooldown check.
  - `get_uc_token()`, `search_display_code(token, doc)`, `get_order(token, so_code, facility)`,
    `create_order(token, facility, payload)`, `search_and_resolve(token, doc)`,
    `get_order_dto(token, so_code)` — the network half, via `requests` (already a `build.sh`
    dependency for every existing worker). Same retry/backoff behavior as the script: one retry
    with a 10s pause on 403/429, a `TokenExpiredError` raised on 401 and caught one level up to
    force a token refresh + retry.
  - `process_job(job_id)` — the entrypoint: fetches pending rows for `job_id` from
    `order_punch_job_rows`, processes them in `row_index` order with the same pacing/backoff/
    duplicate-recovery/crash-safe-resume behavior as the Apps Script (see Error handling below),
    writing each row's outcome back immediately (one `UPDATE` per row, matching
    `process_rto_csv_upload_job.py`'s `_update_job` pattern but per-row here instead of per-job).
  - All ported 1:1 from the Apps Script's own `resolveTargetChannel_`, `buildCreatePayload_`,
    `pickSoCode_`, `extractStatus_`, `extractCreatedDate_`, `parseTimestamp_`,
    `searchAndResolve_`, `getOrder_`, `createOrder_`, `getUcToken_` — same behavior, same edge
    cases, translated from Apps Script's `UrlFetchApp` to Python's `requests`.

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
  `order_punch_settings` (facility codes, channel-routing lists, cooldown days, max suffix). The
  Python worker reads the same table directly via its own `psycopg` connection at the start of
  each invocation (not through this endpoint) — same "one table, two independent readers/writers
  in two languages" shape as `rto_csv_upload_jobs` already has.

- **New Lambda function `mcaff-cls-order-punch-worker`** — own function (via
  `lambda/deploy_infra.sh`, same reasoning as `mcaff-cls-csv-upload-worker`: needs a timeout the
  constrained GitHub Actions deploy role can't set after creation). `python3.12`, 900s timeout,
  256MB memory (HTTP-call-bound like `assign_ndr_leads`, not the big-JSON-parsing load that gave
  `csv_upload_worker` 1536MB), **reserved concurrency 1** — serializes all order-punch work (this
  job's own continuations *and* any other queued job) to avoid two workers racing the same
  display-code's `_1`/`_2` suffix assignment or doubling up on Unicommerce rate-limit backoff,
  same `maximum-retry-attempts 0` event-invoke config as `csv_upload_worker` (belt-and-suspenders
  against a duplicate-create retry; the real correctness backstop is the duplicate-create
  recovery logic itself).

  **Self-continuation (new pattern for this repo):** every existing worker Lambda here finishes
  in one invoke; Order Punch's explicit no-row-cap decision means a large enough batch (2,000+
  orders at ~1-2s/order) cannot. `process_job` tracks its own elapsed wall-clock time from
  invocation start and stops picking up new rows once it crosses an 800s budget (leaving ~100s of
  its 900s timeout for the in-flight row to finish, a final progress write, and the
  continuation call itself). If rows are still `pending` at that point, it invokes itself again
  —`boto3.client('lambda').invoke(FunctionName='mcaff-cls-order-punch-worker',
  InvocationType='Event', Payload=json.dumps({"jobId": job_id}))` — before returning, same
  "always resume, even on crash" intent as the script's `continueRepunch_`/
  `scheduleContinuation_`, just a direct self-invoke instead of a time-based Apps Script trigger.
  Needs one new IAM inline policy on the shared `mcaff-cls-cron-lambda-role`: `lambda:
  InvokeFunction` scoped to this function's own ARN only (no other cron Lambda gets a new
  permission). `boto3` needs no `build.sh` dependency — it ships in every AWS Python Lambda
  runtime already.

  Per-invoke: fetch a Unicommerce OAuth token once, refresh it every ~2 minutes during the loop
  (`TOKEN_REFRESH_MS`, ported as-is), process rows with `status = 'pending'` in `row_index`
  order, `SLEEP_BETWEEN` (500ms) between orders, `BACKOFF_ON_403` (10s) + `MAX_CONSECUTIVE_403`
  (5 → 30s cooldown) ported unchanged as fixed tuning constants (not admin-editable — these
  govern Unicommerce rate-limit behavior, not business rules).

- **`lambda/order_punch_worker/handler.py`** — thin entrypoint, imports
  `scripts/process_order_punch_job.py` unmodified (same pattern as
  `lambda/csv_upload_worker/handler.py` importing `process_rto_csv_upload_job.py`).

- **New Postgres tables** — see schema below.

- **New secret `mcaff-cls/unicommerce`** in AWS Secrets Manager (`{username, password}`),
  read via `boto3`'s `secretsmanager` client, cached in a module-level variable for the
  container's lifetime (same intent as `api/_lib/db.js`'s lazy-singleton `SecretsManagerClient`
  for the DB secret, just Python). This is a deliberate departure from every existing cron-Lambda
  secret (`GOKWIK_*`, `MYSQL_*`), which `lambda/deploy_infra.sh` injects as plain Lambda
  environment variables by design (see that script's own comment: "no Secrets Manager calls at
  runtime") — a live Unicommerce login that creates real orders warrants the tighter Secrets
  Manager path even though it's inconsistent with the simpler convention every other cron secret
  uses. Needs its own IAM inline policy on `mcaff-cls-cron-lambda-role`:
  `secretsmanager:GetSecretValue` scoped to this secret's ARN only. The credential value itself
  is set by a human directly in AWS (console or CLI) — never written into this codebase or its
  deploy scripts.

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
  id BIGSERIAL PRIMARY KEY,            -- matches rto_csv_upload_jobs' own id convention
  status TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'done' | 'failed' | 'stopped'
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
  job_id BIGINT NOT NULL REFERENCES order_punch_jobs(id),
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
CREATE INDEX IF NOT EXISTS order_punch_job_rows_pending_idx
  ON order_punch_job_rows (job_id, row_index) WHERE status = 'pending';
-- Every worker invocation's first query is "pending rows for this job, in row_index order" -
-- this partial index keeps that cheap regardless of how large the job (no cap) or how many
-- rows have already finished.

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

- `scripts/test_process_order_punch_job.py` — pure-function checks, same plain
  `assert` + `if __name__ == "__main__"` style as `test_process_rto_csv_upload_job.py` (no
  pytest dependency, no mocking library): `resolve_target_channel` for every known channel plus
  the `HYP`-prefix fallback, `pick_so_code` suffix picking and max-suffix exhaustion,
  `build_create_payload` field mapping (`reason` → `giftMessage`, `agent_email` →
  `voucherCode`, facility propagation), `extract_status`/`extract_created_date` field-name
  fallback + auto-scan, `parse_timestamp` for epoch-ms/epoch-s/ISO-string inputs. No network, no
  Postgres.
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
