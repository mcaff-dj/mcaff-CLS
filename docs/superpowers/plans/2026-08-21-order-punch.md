# Order Punch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only "Order Punch" tab (next to Refund Export, under Exports) that
queues a batch of orders for repunch in Unicommerce, ported from the existing "Repunch
Pipeline" Google Apps Script.

**Architecture:** Node `/api/order-punch/*` endpoints validate input and manage a Postgres job
(`order_punch_jobs` + `order_punch_job_rows`), firing a dedicated Python Lambda
(`mcaff-cls-order-punch-worker`) fire-and-forget. All Unicommerce business logic (channel
routing, DELIVERED/cooldown guards, duplicate-suffix handling, retries) lives only in that
worker's Python script — the Node side never executes it. A large batch that outruns one 900s
invoke has the worker invoke itself again (same jobId) to continue.

**Tech Stack:** Node/Express (`api/`), Next.js App Router (`app/`), `pg` via this repo's own
`pgSql` tagged-template helper, Python 3.12 + `psycopg` + `requests` + `boto3` (Lambda), AWS
Secrets Manager, AWS Lambda + IAM.

**Spec:** `docs/superpowers/specs/2026-08-21-order-punch-design.md`

## Global Constraints

- No live testing against a real DB, dev server, or AWS account from this environment — every
  test in this plan is offline (pure functions only). Manual verification against the real
  environment is the user's own step, not part of any task here.
- Never commit or hardcode the Unicommerce credential (or any secret) anywhere in this repo.
- Match existing conventions exactly rather than introducing new ones: Node tests are plain
  `assert`, run directly via `node <file>.test.js` (no test framework); Python tests are plain
  `assert`, run directly via `python <file>` (no pytest).
- Every DB write from Node goes through `api/_lib/db.js`'s `pgSql` tagged template (or
  `withPgTransaction` for multi-statement atomicity) — no other file opens its own Postgres
  connection.
- Confirm with the user before any `git commit`/`git push`, even though this plan describes
  committing after each task — per this repo's own standing rule, hold each commit for an
  explicit go-ahead rather than firing it automatically.

---

## Task 1: Postgres schema — order_punch_jobs, order_punch_job_rows, order_punch_settings

**Files:**
- Modify: `api/_lib/db.js` (inside `bootstrapPgSchema()`, ~line 613, right after the existing
  `ndr_lead_assignments` table block)

**Interfaces:**
- Produces: three tables + one partial index, available to every later task via `pgSql`/`psycopg`.

- [ ] **Step 1: Add the three `CREATE TABLE` statements + index**

Insert immediately after the existing block that ends:
```js
  await pgSql`
    CREATE TABLE IF NOT EXISTS ndr_lead_assignments (
      id BIGSERIAL PRIMARY KEY,
      awb_number TEXT NOT NULL,
      email TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reassigned_away_at TIMESTAMPTZ,
      disposed_at TIMESTAMPTZ,
      disposition TEXT,
      agent_remarks TEXT
    )
  `;
```

add:
```js
  // Order Punch - background repunch pipeline, ported from the "Repunch Pipeline" Google Apps
  // Script. See docs/superpowers/specs/2026-08-21-order-punch-design.md. id is BIGSERIAL to
  // match rto_csv_upload_jobs' own id convention (not UUID).
  await pgSql`
    CREATE TABLE IF NOT EXISTS order_punch_jobs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_rows INTEGER NOT NULL,
      processed_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      stop_requested BOOLEAN NOT NULL DEFAULT false,
      error_message TEXT
    )
  `;
  // One row per order to repunch. status/so_code/target_channel/error_message are written by
  // the Python worker (its own psycopg connection) as each row is processed - Node only ever
  // INSERTs these at job creation (see createOrderPunchJob below).
  await pgSql`
    CREATE TABLE IF NOT EXISTS order_punch_job_rows (
      job_id BIGINT NOT NULL REFERENCES order_punch_jobs(id),
      row_index INTEGER NOT NULL,
      display_order_code TEXT NOT NULL,
      reason TEXT,
      facility_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      so_code TEXT,
      target_channel TEXT,
      error_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (job_id, row_index)
    )
  `;
  // Every worker invocation's first query is "pending rows for this job, in row_index order" -
  // this partial index keeps that cheap regardless of job size (no cap - see the design spec).
  await pgSql`
    CREATE INDEX IF NOT EXISTS order_punch_job_rows_pending_idx
    ON order_punch_job_rows (job_id, row_index) WHERE status = 'pending'
  `;
  // Admin-editable settings, seeded below with the Apps Script's own hardcoded constants so
  // behavior is identical on day one. The Python worker reads this table directly (its own
  // psycopg connection) at the start of each invocation.
  await pgSql`
    CREATE TABLE IF NOT EXISTS order_punch_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT NOT NULL
    )
  `;
  // Seed defaults once - ON CONFLICT DO NOTHING means an admin's later edit is never
  // overwritten by a subsequent cold start re-running this bootstrap.
  await pgSql`
    INSERT INTO order_punch_settings (key, value, updated_by) VALUES
      ('facility_codes', '["HYP_SRKOL","HYP_SRBGLR","mCaff_Mumbai2","mCaff_Gurgaon3","HYP_AHMD","HYP_SRLOK2","HYP_SRGWHT","Omnivio_Noida1","HYP_DLNAG"]'::jsonb, 'system'),
      ('mcaffeine_channels', '["SHOPIFY","FIEN_SHOPIFY","HYPD","COMPENSATION","MCaf_Shopify.in","MCAFF_TEST"]'::jsonb, 'system'),
      ('hyphen_channels', '["HYP_SHOPIFY","HYPD_HYPHEN","HYP_COMPENSATION","HYP_SHOPIFY_IN"]'::jsonb, 'system'),
      ('target_mcaffeine', '"MCAFFEINE_D2C"'::jsonb, 'system'),
      ('target_hyphen', '"HYPHEN_D2C"'::jsonb, 'system'),
      ('cooldown_days', '3'::jsonb, 'system'),
      ('max_suffix', '2'::jsonb, 'system')
    ON CONFLICT (key) DO NOTHING
  `;
```

- [ ] **Step 2: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat: add Order Punch Postgres schema (jobs, job rows, settings)"
```

---

## Task 2: DB helper functions for Order Punch

**Files:**
- Modify: `api/_lib/db.js` (new functions, placed near `createRtoCsvUploadJob` etc., ~line 1221;
  export list ~line 3001)

**Interfaces:**
- Consumes: `pgSql`, `withPgTransaction`, `ensurePgSchema` (all already defined earlier in this
  file).
- Produces (used by Tasks 4–8):
  - `createOrderPunchJob({ createdBy, rows })` → `Promise<number>` (jobId). `rows` is
    `[{doc, reason, facility_code}]`.
  - `getOrderPunchJob(id)` → `Promise<object|null>` (full job row).
  - `setOrderPunchJobStopRequested(id)` → `Promise<void>`.
  - `getOrderPunchJobRowsForExport(id)` → `Promise<Array<{display_order_code, reason,
    facility_code, status, so_code, target_channel, error_message}>>`.
  - `getOrderPunchSettings()` → `Promise<object>` (merged with hardcoded defaults).
  - `upsertOrderPunchSetting(key, value, updatedBy)` → `Promise<void>`.

No dedicated test file for this task — matches this codebase's own convention (`db.js`'s other
job-table functions like `createRtoCsvUploadJob`/`updateRtoCsvUploadJob` have no test file
either; only pure, no-I/O logic like `buildRefundExportWhere` gets unit-tested here, and there
is no such pure logic in these functions). Exercised indirectly once Task 4's endpoint test runs.

- [ ] **Step 1: Add the functions**

Insert after the existing `updateRtoCsvUploadJob` function (ends ~line 1263):

```js
// { id } for a freshly-created Order Punch job - job row + every submitted row inserted in ONE
// transaction, so a crash between the two inserts can never leave a job with zero rows (which
// the worker would otherwise treat as instantly "done" - see readPendingRows-equivalent logic
// in the Python worker). rows is [{doc, reason, facility_code}], already validated by the
// caller (see api/_lib/orderPunchRows.js) - row_index is assigned here as submission order.
async function createOrderPunchJob({ createdBy, rows }) {
  await ensurePgSchema();
  return withPgTransaction(async (client) => {
    const { rows: jobRows } = await client.query(
      'INSERT INTO order_punch_jobs (created_by, total_rows) VALUES ($1, $2) RETURNING id',
      [createdBy, rows.length],
    );
    const jobId = jobRows[0].id;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await client.query(
        `INSERT INTO order_punch_job_rows (job_id, row_index, display_order_code, reason, facility_code)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobId, i, r.doc, r.reason || null, r.facility_code || null],
      );
    }
    return jobId;
  });
}

// The full job row, including the Python worker's own progress counters, or null if `id`
// doesn't exist.
async function getOrderPunchJob(id) {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT * FROM order_punch_jobs WHERE id = ${id}`;
  return rows[0] || null;
}

// Sets the flag the Python worker checks between rows/chunks - see api/order-punch/stop.js.
async function setOrderPunchJobStopRequested(id) {
  await ensurePgSchema();
  await pgSql`UPDATE order_punch_jobs SET stop_requested = true, updated_at = now() WHERE id = ${id}`;
}

// Every row for a job, in submission order - api/order-punch/results.js's CSV source.
async function getOrderPunchJobRowsForExport(id) {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT display_order_code, reason, facility_code, status, so_code, target_channel, error_message
    FROM order_punch_job_rows WHERE job_id = ${id} ORDER BY row_index
  `;
  return rows;
}

// Same constants the Apps Script hardcoded, used as a fallback merge in case a key is somehow
// missing from the table (the schema bootstrap above seeds these as real rows on first boot,
// so this is belt-and-suspenders, not the only source of truth).
const ORDER_PUNCH_SETTINGS_DEFAULTS = {
  facility_codes: ['HYP_SRKOL', 'HYP_SRBGLR', 'mCaff_Mumbai2', 'mCaff_Gurgaon3', 'HYP_AHMD',
    'HYP_SRLOK2', 'HYP_SRGWHT', 'Omnivio_Noida1', 'HYP_DLNAG'],
  mcaffeine_channels: ['SHOPIFY', 'FIEN_SHOPIFY', 'HYPD', 'COMPENSATION', 'MCaf_Shopify.in', 'MCAFF_TEST'],
  hyphen_channels: ['HYP_SHOPIFY', 'HYPD_HYPHEN', 'HYP_COMPENSATION', 'HYP_SHOPIFY_IN'],
  target_mcaffeine: 'MCAFFEINE_D2C',
  target_hyphen: 'HYPHEN_D2C',
  cooldown_days: 3,
  max_suffix: 2,
};

// { [key]: value } - api/order-punch/settings.js's GET, and the admin settings panel's source.
async function getOrderPunchSettings() {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT key, value FROM order_punch_settings`;
  const settings = { ...ORDER_PUNCH_SETTINGS_DEFAULTS };
  rows.forEach((r) => { settings[r.key] = r.value; });
  return settings;
}

async function upsertOrderPunchSetting(key, value, updatedBy) {
  await ensurePgSchema();
  const json = JSON.stringify(value);
  await pgSql`
    INSERT INTO order_punch_settings (key, value, updated_by) VALUES (${key}, ${json}::jsonb, ${updatedBy})
    ON CONFLICT (key) DO UPDATE SET value = ${json}::jsonb, updated_at = now(), updated_by = ${updatedBy}
  `;
}
```

- [ ] **Step 2: Export the new functions**

In the `module.exports` block (~line 3001), change:
```js
  createRtoCsvUploadJob, getRtoCsvUploadJob, updateRtoCsvUploadJob,
```
to:
```js
  createRtoCsvUploadJob, getRtoCsvUploadJob, updateRtoCsvUploadJob,
  createOrderPunchJob, getOrderPunchJob, setOrderPunchJobStopRequested,
  getOrderPunchJobRowsForExport, getOrderPunchSettings, upsertOrderPunchSetting,
```

- [ ] **Step 3: Sanity-check the file still parses**

Run: `node -e "require('./api/_lib/db.js')"`
Expected: no output, exit code 0 (this only checks the module loads/parses — it does not open a
DB connection until a function is actually called).

- [ ] **Step 4: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat: add Order Punch job/settings DB helpers"
```

---

## Task 3: Pure row-validation helper (`api/_lib/orderPunchRows.js`)

**Files:**
- Create: `api/_lib/orderPunchRows.js`
- Test: `api/_lib/orderPunchRows.test.js`

**Interfaces:**
- Produces: `validateRows(rows)` → `{ validRows: [{doc, reason, facility_code}], errors:
  [{line, reason}] }`. Used by Task 4 (`api/order-punch/start.js`).

- [ ] **Step 1: Write the failing test**

```js
// api/_lib/orderPunchRows.test.js
// Run with `node api/_lib/orderPunchRows.test.js`.
const assert = require('assert');
const { validateRows } = require('./orderPunchRows');

// 1. A blank/missing doc is rejected; valid rows around it still come through.
{
  const { validRows, errors } = validateRows([
    { doc: 'HYP1001', reason: 'wrong address', facility_code: 'HYP_SRKOL' },
    { doc: '  ', reason: 'x' },
    { doc: 'HYP1002' },
  ]);
  assert.deepStrictEqual(validRows, [
    { doc: 'HYP1001', reason: 'wrong address', facility_code: 'HYP_SRKOL' },
    { doc: 'HYP1002', reason: '', facility_code: '' },
  ]);
  assert.deepStrictEqual(errors, [{ line: 2, reason: 'Missing order code' }]);
}

// 2. Whitespace is trimmed on every field.
{
  const { validRows } = validateRows([{ doc: '  HYP2001  ', reason: '  late delivery  ', facility_code: ' HYP_AHMD ' }]);
  assert.deepStrictEqual(validRows, [{ doc: 'HYP2001', reason: 'late delivery', facility_code: 'HYP_AHMD' }]);
}

// 3. reason/facility_code are optional - default to ''.
{
  const { validRows } = validateRows([{ doc: 'HYP3001' }]);
  assert.deepStrictEqual(validRows, [{ doc: 'HYP3001', reason: '', facility_code: '' }]);
}

// 4. Empty input -> empty output, no crash.
{
  const { validRows, errors } = validateRows([]);
  assert.deepStrictEqual(validRows, []);
  assert.deepStrictEqual(errors, []);
}

console.log('orderPunchRows.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/orderPunchRows.test.js`
Expected: `Error: Cannot find module './orderPunchRows'`

- [ ] **Step 3: Write the implementation**

```js
// api/_lib/orderPunchRows.js
// Pure validation for Order Punch's /start payload - shared by the CSV-upload path and the
// manual multi-row form on the client, since both ultimately POST the same
// {doc, reason, facility_code}[] shape. No network, no DB - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md.
function validateRows(rows) {
  const validRows = [];
  const errors = [];
  (rows || []).forEach((r, i) => {
    const doc = String((r && r.doc) || '').trim();
    if (!doc) {
      errors.push({ line: i + 1, reason: 'Missing order code' });
      return;
    }
    validRows.push({
      doc,
      reason: String((r && r.reason) || '').trim(),
      facility_code: String((r && r.facility_code) || '').trim(),
    });
  });
  return { validRows, errors };
}

module.exports = { validateRows };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/orderPunchRows.test.js`
Expected: `orderPunchRows.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/orderPunchRows.js api/_lib/orderPunchRows.test.js
git commit -m "feat: add Order Punch row validation helper"
```

---

## Task 4: `POST /api/order-punch/start`

**Files:**
- Create: `api/order-punch/start.js`
- Modify: `api/_lambda/app.js` (mount)

**Interfaces:**
- Consumes: `getSession` (`api/_lib/session.js`), `validateRows` (Task 3),
  `createOrderPunchJob` (Task 2), `triggerLambda` (`api/_lib/lambdaTrigger.js`, already exists).
- Produces: `POST /api/order-punch/start` — `{rows}` in, `{jobId, queued, errors}` out (200), or
  `{error}` (400/401/403/500).

No test file for the endpoint itself — matches `refund-export.js`'s own convention (its
`checkAccess` isn't unit-tested either); the only pure logic here (`validateRows`) is already
covered by Task 3.

- [ ] **Step 1: Write `api/order-punch/start.js`**

```js
// POST /api/order-punch/start - admin-only. Queues a batch of orders for repunch via the
// background Lambda worker (mcaff-cls-order-punch-worker) - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md. Accepts the same {doc, reason,
// facility_code}[] shape whether the browser built it from a parsed CSV or the manual
// multi-row form; this endpoint only validates and queues, it never talks to Unicommerce
// itself (that's the worker's job, entirely in Python - see
// scripts/process_order_punch_job.py).
const { getSession } = require('../_lib/session');
const { validateRows } = require('../_lib/orderPunchRows');
const { createOrderPunchJob } = require('../_lib/db');
const { triggerLambda } = require('../_lib/lambdaTrigger');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const ORDER_PUNCH_WORKER_LAMBDA = 'mcaff-cls-order-punch-worker';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can run Order Punch.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows (a non-empty array) is required' });
  }

  const { validRows, errors } = validateRows(rows);
  if (!validRows.length) {
    return res.status(400).json({ error: 'No valid rows to queue', errors });
  }

  try {
    const jobId = await createOrderPunchJob({ createdBy: session.email, rows: validRows });
    await triggerLambda(ORDER_PUNCH_WORKER_LAMBDA, { jobId });
    return res.status(200).json({ jobId, queued: validRows.length, errors });
  } catch (e) {
    console.error('api/order-punch/start error:', e);
    return res.status(500).json({ error: e.message || 'Could not queue this batch' });
  }
};
```

- [ ] **Step 2: Mount the route**

In `api/_lambda/app.js`, right after:
```js
mount('get', '/api/refund-export', '../refund-export.js');
```
add:
```js
mount('post', '/api/order-punch/start', '../order-punch/start.js');
```

- [ ] **Step 3: Sanity-check it loads**

Run: `node -e "require('./api/order-punch/start.js')"`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add api/order-punch/start.js api/_lambda/app.js
git commit -m "feat: add POST /api/order-punch/start"
```

---

## Task 5: `GET /api/order-punch/status`

**Files:**
- Create: `api/order-punch/status.js`
- Modify: `api/_lambda/app.js` (mount)

**Interfaces:**
- Consumes: `getOrderPunchJob` (Task 2).
- Produces: `GET /api/order-punch/status?jobId=` → `{status, totalRows, processedCount,
  successCount, errorCount, skippedCount, errorMessage}` (200), or `{error}` (400/401/403/404/500).

- [ ] **Step 1: Write `api/order-punch/status.js`**

```js
// GET /api/order-punch/status?jobId=123 - admin-only. Polled by the browser while the
// background worker (mcaff-cls-order-punch-worker) processes a batch - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md.
const { getSession } = require('../_lib/session');
const { getOrderPunchJob } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can view Order Punch status.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  const jobId = Number(req.query.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const job = await getOrderPunchJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.status(200).json({
      status: job.status,
      totalRows: job.total_rows,
      processedCount: job.processed_count,
      successCount: job.success_count,
      errorCount: job.error_count,
      skippedCount: job.skipped_count,
      errorMessage: job.error_message,
    });
  } catch (e) {
    console.error('api/order-punch/status error:', e);
    return res.status(500).json({ error: e.message || 'Could not fetch job status' });
  }
};
```

- [ ] **Step 2: Mount the route**

In `api/_lambda/app.js`, right after the `order-punch/start` mount added in Task 4, add:
```js
mount('get', '/api/order-punch/status', '../order-punch/status.js');
```

- [ ] **Step 3: Sanity-check it loads**

Run: `node -e "require('./api/order-punch/status.js')"`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add api/order-punch/status.js api/_lambda/app.js
git commit -m "feat: add GET /api/order-punch/status"
```

---

## Task 6: `POST /api/order-punch/stop`

**Files:**
- Create: `api/order-punch/stop.js`
- Modify: `api/_lambda/app.js` (mount)

**Interfaces:**
- Consumes: `getOrderPunchJob`, `setOrderPunchJobStopRequested` (Task 2).
- Produces: `POST /api/order-punch/stop` — `{jobId}` in, `{ok: true}` out (200), or `{error}`
  (400/401/403/404/500).

- [ ] **Step 1: Write `api/order-punch/stop.js`**

```js
// POST /api/order-punch/stop {jobId} - admin-only. Sets stop_requested on the job row; the
// Python worker checks this flag between rows and between chunks (see
// scripts/process_order_punch_job.py) and stops picking up new rows once it sees it.
const { getSession } = require('../_lib/session');
const { getOrderPunchJob, setOrderPunchJobStopRequested } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can stop Order Punch.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  const { jobId } = req.body || {};
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const job = await getOrderPunchJob(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await setOrderPunchJobStopRequested(id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('api/order-punch/stop error:', e);
    return res.status(500).json({ error: e.message || 'Could not stop this job' });
  }
};
```

- [ ] **Step 2: Mount the route**

In `api/_lambda/app.js`, right after the `order-punch/status` mount added in Task 5, add:
```js
mount('post', '/api/order-punch/stop', '../order-punch/stop.js');
```

- [ ] **Step 3: Sanity-check it loads**

Run: `node -e "require('./api/order-punch/stop.js')"`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add api/order-punch/stop.js api/_lambda/app.js
git commit -m "feat: add POST /api/order-punch/stop"
```

---

## Task 7: `GET /api/order-punch/results`

**Files:**
- Create: `api/order-punch/results.js`
- Modify: `api/_lambda/app.js` (mount)

**Interfaces:**
- Consumes: `getOrderPunchJob`, `getOrderPunchJobRowsForExport` (Task 2), `toCSV`
  (`api/_lib/csv.js`, already exists).
- Produces: `GET /api/order-punch/results?jobId=` → CSV attachment (200), or `{error}`
  (400/401/403/404/500).

- [ ] **Step 1: Write `api/order-punch/results.js`**

```js
// GET /api/order-punch/results?jobId=123 - admin-only. CSV of every row's final outcome for a
// job (display_order_code, reason, facility_code, status, so_code, target_channel,
// error_message) - see docs/superpowers/specs/2026-08-21-order-punch-design.md.
const { getSession } = require('../_lib/session');
const { toCSV } = require('../_lib/csv');
const { getOrderPunchJob, getOrderPunchJobRowsForExport } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const COLUMNS = ['display_order_code', 'reason', 'facility_code', 'status', 'so_code', 'target_channel', 'error_message'];

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can download Order Punch results.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  const jobId = Number(req.query.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const job = await getOrderPunchJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const rows = await getOrderPunchJobRowsForExport(jobId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="order-punch-results_${jobId}.csv"`);
    return res.status(200).send(toCSV(rows, COLUMNS));
  } catch (e) {
    console.error('api/order-punch/results error:', e);
    return res.status(500).json({ error: e.message || 'Could not build results CSV' });
  }
};
```

- [ ] **Step 2: Mount the route**

In `api/_lambda/app.js`, right after the `order-punch/stop` mount added in Task 6, add:
```js
mount('get', '/api/order-punch/results', '../order-punch/results.js');
```

- [ ] **Step 3: Sanity-check it loads**

Run: `node -e "require('./api/order-punch/results.js')"`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add api/order-punch/results.js api/_lambda/app.js
git commit -m "feat: add GET /api/order-punch/results"
```

---

## Task 8: `GET`/`PUT /api/order-punch/settings`

**Files:**
- Create: `api/order-punch/settings.js`
- Modify: `api/_lambda/app.js` (mount)

**Interfaces:**
- Consumes: `getOrderPunchSettings`, `upsertOrderPunchSetting` (Task 2).
- Produces: `GET /api/order-punch/settings` → `{settings}`; `PUT` with `{key, value}` →
  `{settings}` (200), or `{error}` (400/401/403/405/500).

- [ ] **Step 1: Write `api/order-punch/settings.js`**

```js
// GET/PUT /api/order-punch/settings - admin-only. Reads/writes order_punch_settings (facility
// codes, channel-routing lists, cooldown days, max suffix) - the Python worker reads the same
// table directly via its own connection, see
// docs/superpowers/specs/2026-08-21-order-punch-design.md.
const { getSession } = require('../_lib/session');
const { getOrderPunchSettings, upsertOrderPunchSetting } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';

// Value type per key - a PUT with the wrong shape is rejected rather than silently stored and
// breaking the Python worker's own reads (which trust these types without re-validating).
const SETTINGS_TYPES = {
  facility_codes: 'array',
  mcaffeine_channels: 'array',
  hyphen_channels: 'array',
  target_mcaffeine: 'string',
  target_hyphen: 'string',
  cooldown_days: 'number',
  max_suffix: 'number',
};

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can view or change Order Punch settings.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

function typeMatches(key, value) {
  const expected = SETTINGS_TYPES[key];
  if (expected === 'array') return Array.isArray(value) && value.every((v) => typeof v === 'string');
  if (expected === 'string') return typeof value === 'string' && value.trim().length > 0;
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value) && value > 0;
  return false;
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  if (req.method === 'GET') {
    try {
      const settings = await getOrderPunchSettings();
      return res.status(200).json({ settings });
    } catch (e) {
      console.error('api/order-punch/settings GET error:', e);
      return res.status(500).json({ error: e.message || 'Could not load settings' });
    }
  }

  if (req.method === 'PUT') {
    const { key, value } = req.body || {};
    if (!SETTINGS_TYPES[key]) {
      return res.status(400).json({ error: `Unknown setting key '${key}'` });
    }
    if (!typeMatches(key, value)) {
      return res.status(400).json({ error: `'${key}' must be a ${SETTINGS_TYPES[key]}` });
    }
    try {
      await upsertOrderPunchSetting(key, value, session.email);
      const settings = await getOrderPunchSettings();
      return res.status(200).json({ settings });
    } catch (e) {
      console.error('api/order-punch/settings PUT error:', e);
      return res.status(500).json({ error: e.message || 'Could not save this setting' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
```

- [ ] **Step 2: Mount the route**

In `api/_lambda/app.js`, right after the `order-punch/results` mount added in Task 7, add:
```js
mount('all', '/api/order-punch/settings', '../order-punch/settings.js');
```

- [ ] **Step 3: Sanity-check it loads**

Run: `node -e "require('./api/order-punch/settings.js')"`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add api/order-punch/settings.js api/_lambda/app.js
git commit -m "feat: add GET/PUT /api/order-punch/settings"
```

---

## Task 9: Python worker — pure logic + tests

**Files:**
- Create: `scripts/process_order_punch_job.py` (pure-function half only in this task; network +
  `process_job` come in Task 10)
- Test: `scripts/test_process_order_punch_job.py`

**Interfaces:**
- Produces: `resolve_target_channel(current_channel, mcaffeine_channels, hyphen_channels,
  target_mcaffeine, target_hyphen)` → `str`; `pick_so_code(display_order_code, same_channel,
  existing_codes, max_suffix)` → `str|None`; `build_create_payload(order, new_display_code,
  so_code, target_channel, facility_code, reason, agent_email)` → `dict`;
  `extract_status(obj)` → `str|None`; `extract_created_date(obj)` → value or `None`;
  `parse_timestamp(val)` → epoch-ms `float|None`. All ported 1:1 from the Apps Script's
  `resolveTargetChannel_`/`pickSoCode_`/`buildCreatePayload_`/`extractStatus_`/
  `extractCreatedDate_`/`parseTimestamp_`.

- [ ] **Step 1: Write the failing test**

```python
# scripts/test_process_order_punch_job.py
"""Self-check for process_order_punch_job.py's pure functions - no network, no Postgres. Same
plain-assert, run-directly style as test_process_rto_csv_upload_job.py.
Run: python scripts/test_process_order_punch_job.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_order_punch_job as worker

MCAFFEINE_CHANNELS = ["SHOPIFY", "FIEN_SHOPIFY", "HYPD", "COMPENSATION", "MCaf_Shopify.in", "MCAFF_TEST"]
HYPHEN_CHANNELS = ["HYP_SHOPIFY", "HYPD_HYPHEN", "HYP_COMPENSATION", "HYP_SHOPIFY_IN"]
TARGET_MCAFFEINE = "MCAFFEINE_D2C"
TARGET_HYPHEN = "HYPHEN_D2C"


def test_resolve_target_channel_known_channels():
    for ch in MCAFFEINE_CHANNELS:
        assert worker.resolve_target_channel(ch, MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_MCAFFEINE
    for ch in HYPHEN_CHANNELS:
        assert worker.resolve_target_channel(ch, MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_HYPHEN


def test_resolve_target_channel_hyp_prefix_fallback():
    # Unknown channel starting with "HYP" defaults to Hyphen, everything else to mCaffeine -
    # matches the script's ch.indexOf("HYP") === 0 fallback exactly.
    assert worker.resolve_target_channel("HYP_SOMETHING_NEW", MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_HYPHEN
    assert worker.resolve_target_channel("SOME_OTHER_CHANNEL", MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_MCAFFEINE
    assert worker.resolve_target_channel("", MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_MCAFFEINE


def test_pick_so_code_bare_code_when_different_channel_and_free():
    assert worker.pick_so_code("HYP1001", False, {}, 2) == "HYP1001"


def test_pick_so_code_suffix_when_same_channel():
    assert worker.pick_so_code("HYP1001", True, {}, 2) == "HYP1001_1"


def test_pick_so_code_skips_taken_suffixes():
    assert worker.pick_so_code("HYP1001", True, {"HYP1001_1": True}, 2) == "HYP1001_2"


def test_pick_so_code_returns_none_when_exhausted():
    assert worker.pick_so_code("HYP1001", True, {"HYP1001_1": True, "HYP1001_2": True}, 2) is None


def test_build_create_payload_field_mapping():
    order = {
        "addresses": [{"id": 1, "name": "A", "city": "Pune", "country": "IN", "pincode": 411001, "phone": "999", "email": "a@x.com"}],
        "billingAddress": {"id": 1},
        "saleOrderItems": [{"itemSku": "SKU1", "sellingPrice": 100, "totalPrice": 100}],
        "channel": "SHOPIFY",
        "cod": False,
        "currencyCode": "INR",
        "customerCode": "CUST1",
    }
    payload = worker.build_create_payload(order, "HYP1001", "HYP1001", "MCAFFEINE_D2C", "HYP_SRKOL", "wrong address", "agent@mcaffeine.com")
    item = payload["saleOrder"]["saleOrderItems"][0]
    assert item["giftMessage"] == "wrong address", "reason must map to giftMessage"
    assert item["voucherCode"] == "agent@mcaffeine.com", "triggering agent's email must map to voucherCode"
    assert item["facilityCode"] == "HYP_SRKOL"
    assert payload["saleOrder"]["code"] == "HYP1001"
    assert payload["saleOrder"]["displayOrderCode"] == "HYP1001"
    assert payload["saleOrder"]["channel"] == "MCAFFEINE_D2C"


def test_extract_status_known_field_names():
    assert worker.extract_status({"status": "delivered"}) == "DELIVERED"
    assert worker.extract_status({"orderStatus": "Shipped"}) == "SHIPPED"


def test_extract_status_auto_scan_fallback():
    # No known field name, but a key containing "status" (and not "updat") exists.
    assert worker.extract_status({"weirdStatusField": "cancelled"}) == "CANCELLED"


def test_extract_status_excludes_updat_keys():
    # "lastUpdatedStatus" contains "status" but ALSO "updat" - excluded, same as the script's
    # own kl.indexOf("updat") < 0 guard. No other key matches, so this must be None, not a match.
    assert worker.extract_status({"lastUpdatedStatus": "x"}) is None


def test_extract_status_none_when_absent():
    assert worker.extract_status({"foo": "bar"}) is None


def test_parse_timestamp_epoch_ms():
    assert worker.parse_timestamp(1700000000000) == 1700000000000


def test_parse_timestamp_epoch_seconds():
    assert worker.parse_timestamp(1700000000) == 1700000000000


def test_parse_timestamp_iso_string():
    ms = worker.parse_timestamp("2023-11-14T22:13:20+00:00")
    assert ms == 1700000000000


def test_parse_timestamp_invalid_returns_none():
    assert worker.parse_timestamp("not a date") is None
    assert worker.parse_timestamp(None) is None


if __name__ == "__main__":
    tests = [
        test_resolve_target_channel_known_channels,
        test_resolve_target_channel_hyp_prefix_fallback,
        test_pick_so_code_bare_code_when_different_channel_and_free,
        test_pick_so_code_suffix_when_same_channel,
        test_pick_so_code_skips_taken_suffixes,
        test_pick_so_code_returns_none_when_exhausted,
        test_build_create_payload_field_mapping,
        test_extract_status_known_field_names,
        test_extract_status_auto_scan_fallback,
        test_extract_status_excludes_updat_keys,
        test_extract_status_none_when_absent,
        test_parse_timestamp_epoch_ms,
        test_parse_timestamp_epoch_seconds,
        test_parse_timestamp_iso_string,
        test_parse_timestamp_invalid_returns_none,
    ]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_process_order_punch_job.py`
Expected: `ModuleNotFoundError: No module named 'process_order_punch_job'`

- [ ] **Step 3: Write the pure-function half of `scripts/process_order_punch_job.py`**

```python
#!/usr/bin/env python3
"""Background worker for the Order Punch feature (api/order-punch/start.js). Ports the
"Repunch Pipeline" Google Apps Script's business logic 1:1 - channel routing, DELIVERED/
cooldown guards, duplicate-suffix handling, duplicate-create recovery on retry - onto this
app's Postgres job table + Unicommerce's REST API. See
docs/superpowers/specs/2026-08-21-order-punch-design.md.

This file's pure functions (this section) have no network/DB dependency and are covered by
test_process_order_punch_job.py. The network + process_job half (Task 10) is appended below
them.
"""
import datetime


class TokenExpiredError(Exception):
    pass


class RateLimitedError(Exception):
    pass


def resolve_target_channel(current_channel, mcaffeine_channels, hyphen_channels, target_mcaffeine, target_hyphen):
    """Mirrors resolveTargetChannel_ exactly, including its ch.indexOf("HYP") === 0 fallback for
    an unrecognized channel."""
    ch = (current_channel or "").strip().upper()
    if ch in {c.upper() for c in mcaffeine_channels} or ch == target_mcaffeine.upper():
        return target_mcaffeine
    if ch in {c.upper() for c in hyphen_channels} or ch == target_hyphen.upper():
        return target_hyphen
    return target_hyphen if ch.startswith("HYP") else target_mcaffeine


def pick_so_code(display_order_code, same_channel, existing_codes, max_suffix):
    """Mirrors pickSoCode_ exactly: bare code if a different channel and free, else the first
    free _1.._max_suffix suffix, else None (max suffix exhausted)."""
    if not same_channel and display_order_code not in existing_codes:
        return display_order_code
    for n in range(1, max_suffix + 1):
        candidate = f"{display_order_code}_{n}"
        if candidate not in existing_codes:
            return candidate
    return None


def build_create_payload(order, new_display_code, so_code, target_channel, facility_code, reason, agent_email):
    """Mirrors buildCreatePayload_ exactly. `reason` -> item giftMessage, `agent_email" ->
    item voucherCode - see the design spec's Field mapping section for why (confirmed with the
    user; the Apps Script's own parameter NAMES are misleadingly swapped relative to what they
    actually produce, but the behavior itself is what's ported here)."""
    addresses = []
    for addr in order.get("addresses") or []:
        addresses.append({
            "id": str(addr.get("id") or ""),
            "name": addr.get("name") or "",
            "addressLine1": addr.get("addressLine1") or "",
            "addressLine2": addr.get("addressLine2") or "",
            "city": addr.get("city") or "",
            "state": addr.get("state") or "",
            "country": addr.get("country") or "IN",
            "pincode": str(addr.get("pincode") or ""),
            "phone": str(addr.get("phone") or ""),
            "email": addr.get("email") or "",
        })

    billing_id = str((order.get("billingAddress") or {}).get("id") or "")
    items = order.get("saleOrderItems") or []
    shipping_id = billing_id
    if items and items[0].get("shippingAddressId"):
        shipping_id = str(items[0]["shippingAddressId"])
    elif len(addresses) > 1:
        for a in addresses:
            if a["id"] != billing_id:
                shipping_id = a["id"]
                break

    sale_order_items = []
    for i, item in enumerate(items):
        soi = {
            "code": f"{so_code}-{i}",
            "itemSku": item.get("itemSku") or item.get("sellerSkuCode") or "",
            "shippingMethodCode": item.get("shippingMethodCode") or "STD",
            "packetNumber": item.get("packetNumber") or 1,
            "totalPrice": item.get("totalPrice") or 0,
            "sellingPrice": item.get("sellingPrice") or 0,
            "discount": item.get("discount") or 0,
            "shippingCharges": item.get("shippingCharges") or 0,
            "cashOnDeliveryCharges": item.get("cashOnDeliveryCharges") or 0,
            "prepaidAmount": item.get("prepaidAmount") or 0,
            "storeCredit": item.get("storeCredit") or 0,
            "giftWrapCharges": item.get("giftWrapCharges") or 0,
        }
        if facility_code:
            soi["facilityCode"] = facility_code
        for k in ("giftWrap", "channelProductId"):
            if item.get(k) not in (None, ""):
                soi[k] = item[k]
        if reason:
            soi["giftMessage"] = reason
        elif item.get("giftMessage"):
            soi["giftMessage"] = item["giftMessage"]
        if agent_email:
            soi["voucherCode"] = agent_email
        elif item.get("voucherCode"):
            soi["voucherCode"] = item["voucherCode"]
        sale_order_items.append(soi)

    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    sale_order = {
        "code": so_code,
        "displayOrderCode": new_display_code,
        "displayOrderDateTime": now_iso,
        "channel": target_channel,
        "cashOnDelivery": bool(order.get("cod")),
        "currencyCode": order.get("currencyCode") or "INR",
        "notificationEmail": order.get("notificationEmail") or "",
        "notificationMobile": order.get("notificationMobile") or "",
        "customerCode": order.get("customerCode") or "",
        "customerName": order.get("customerCode") or "",
        "addresses": addresses,
        "billingAddress": {"referenceId": billing_id},
        "shippingAddress": {"referenceId": shipping_id},
        "saleOrderItems": sale_order_items,
        "priority": order.get("priority") or 0,
    }
    if order.get("additionalInfo"):
        sale_order["additionalInfo"] = order["additionalInfo"]
    for k in ("customerGSTIN", "fulfillmentTat", "paymentInstrument", "verificationRequired"):
        if order.get(k) not in (None, ""):
            sale_order[k] = order[k]
    if order.get("thirdPartyShipping"):
        sale_order["thirdPartyShipping"] = True
    if order.get("customFieldValues"):
        sale_order["customFieldValues"] = [
            {"name": cf["name"], "value": cf["value"]}
            for cf in order["customFieldValues"] if cf.get("name") and cf.get("value")
        ]

    return {"saleOrder": sale_order}


def extract_status(obj):
    """Mirrors extractStatus_: known field names first, then any key containing "status" but
    not "updat" (so e.g. lastUpdatedStatus is excluded)."""
    for key in ("status", "statusCode", "orderStatus", "currentStatus", "fulfillmentStatus", "status_code"):
        val = obj.get(key)
        if isinstance(val, str) and val:
            return val.strip().upper()
    for key, val in obj.items():
        kl = key.lower()
        if "status" in kl and "updat" not in kl and isinstance(val, str) and val:
            return val.strip().upper()
    return None


def extract_created_date(obj):
    """Mirrors extractCreatedDate_: known field names first, then any key containing "creat" or
    "date" but not "updat"."""
    for key in ("created", "createdDate", "created_time", "createdTime", "uniware_created_time",
                "uniwareCreatedTime", "createDateTime", "createdDateTime", "createdAt",
                "orderDate", "displayOrderDateTime", "orderDateTime"):
        val = obj.get(key)
        if val not in (None, ""):
            return val
    for key, val in obj.items():
        kl = key.lower()
        if ("creat" in kl or ("date" in kl and "updat" not in kl)) and val not in (None, "") and not isinstance(val, (dict, bool)):
            return val
    return None


def parse_timestamp(val):
    """Mirrors parseTimestamp_: epoch ms, epoch seconds, or an ISO/date string -> epoch ms
    (float), or None if unparseable."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        if val > 1e15:
            return None
        return float(val) if val > 1e12 else float(val) * 1000
    try:
        s = str(val).strip()
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.timestamp() * 1000
    except Exception:
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_process_order_punch_job.py`
Expected: `15 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/process_order_punch_job.py scripts/test_process_order_punch_job.py
git commit -m "feat: add Order Punch worker's pure logic (channel routing, payload building, field extraction)"
```

---

## Task 10: Python worker — network calls + `process_job` + self-continuation

**Files:**
- Modify: `scripts/process_order_punch_job.py` (append network + DB + `process_job` below the
  pure functions from Task 9)

**Interfaces:**
- Consumes: `lib.get_pg_connection` (`scripts/lib.py`, already exists), the pure functions from
  Task 9.
- Produces: `process_job(job_id)` — the Lambda handler's entrypoint (Task 11 imports this).

No test for this half — it's all network/DB/AWS calls, and per this repo's own convention
(`process_rto_csv_upload_job.py` has no test for its own `process_job` either — only its pure
`partition_and_stamp` is tested) this is exercised only by manual verification against the
real environment, which is the user's own step.

- [ ] **Step 1: Append the network + DB + `process_job` code**

Add to the end of `scripts/process_order_punch_job.py`:

```python
import json
import os
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402

UC_BASE_URL = "https://pep.unicommerce.com"
UC_SECRET_ID = "mcaff-cls/unicommerce"
# Not env-var-configurable - deploy_infra.sh never sets one, and there is only ever one
# deployed worker function for this to name.
WORKER_FUNCTION_NAME = "mcaff-cls-order-punch-worker"

# Ported unchanged from the Apps Script's own tuning constants - these govern Unicommerce
# rate-limit behavior, not business rules, so they are NOT admin-editable (unlike
# order_punch_settings).
SLEEP_BETWEEN_SEC = 0.5
BACKOFF_ON_403_SEC = 10
MAX_CONSECUTIVE_403 = 5
TOKEN_REFRESH_SEC = 120
# Leaves ~100s of the Lambda's 900s timeout for the in-flight row to finish, a final progress
# write, and the continuation self-invoke itself.
CHUNK_BUDGET_SEC = 800

DEFAULT_SETTINGS = {
    "facility_codes": ["HYP_SRKOL", "HYP_SRBGLR", "mCaff_Mumbai2", "mCaff_Gurgaon3", "HYP_AHMD",
                        "HYP_SRLOK2", "HYP_SRGWHT", "Omnivio_Noida1", "HYP_DLNAG"],
    "mcaffeine_channels": ["SHOPIFY", "FIEN_SHOPIFY", "HYPD", "COMPENSATION", "MCaf_Shopify.in", "MCAFF_TEST"],
    "hyphen_channels": ["HYP_SHOPIFY", "HYPD_HYPHEN", "HYP_COMPENSATION", "HYP_SHOPIFY_IN"],
    "target_mcaffeine": "MCAFFEINE_D2C",
    "target_hyphen": "HYPHEN_D2C",
    "cooldown_days": 3,
    "max_suffix": 2,
}

_uc_credentials_cache = None


def get_uc_credentials():
    """Cached for this container's lifetime - one Secrets Manager read per cold start, not per
    row/chunk."""
    global _uc_credentials_cache
    if _uc_credentials_cache is not None:
        return _uc_credentials_cache
    import boto3
    client = boto3.client("secretsmanager")
    secret = client.get_secret_value(SecretId=UC_SECRET_ID)
    _uc_credentials_cache = json.loads(secret["SecretString"])
    return _uc_credentials_cache


def get_uc_token():
    creds = get_uc_credentials()
    resp = requests.get(
        f"{UC_BASE_URL}/oauth/token",
        params={"grant_type": "password", "client_id": "my-trusted-client",
                "username": creds["username"], "password": creds["password"]},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    if resp.status_code != 200:
        raise Exception(f"Auth failed ({resp.status_code}): {resp.text[:200]}")
    return resp.json()["access_token"]


def uc_headers(token, facility=None):
    h = {"Content-Type": "application/json", "Authorization": f"bearer {token}"}
    if facility:
        h["Facility"] = facility
    return h


def search_display_code(token, display_order_code):
    """Mirrors searchDisplayCode_: one retry with a 10s backoff on 403/429, TokenExpiredError on
    401, empty list for any other non-200 (genuine "not found")."""
    url = f"{UC_BASE_URL}/services/rest/v1/oms/saleOrder/search"
    payload = {"displayOrderCode": display_order_code}
    for attempt in range(2):
        resp = requests.post(url, headers=uc_headers(token), json=payload, timeout=30)
        code = resp.status_code
        if code == 200:
            data = resp.json()
            return (data.get("elements") or []) if data.get("successful") else []
        if code == 401:
            raise TokenExpiredError("search returned 401 - token expired")
        if code in (403, 429) and attempt == 0:
            time.sleep(BACKOFF_ON_403_SEC)
            continue
        if code in (403, 429):
            raise RateLimitedError(f"search returned {code} - Unicommerce is rate limiting")
        return []
    return []


def get_order_dto(token, so_code):
    """Mirrors getOrderDto_ - best-effort, returns None on any failure rather than raising."""
    try:
        url = f"{UC_BASE_URL}/services/rest/v1/oms/saleorder/get"
        resp = requests.post(url, headers=uc_headers(token), json={"code": so_code}, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
        return data.get("saleOrderDTO") if data.get("successful") else None
    except Exception:
        return None


def get_order(token, so_code, facility_code, all_facility_codes):
    """Mirrors getOrder_: try the given facility, then no facility, then every other known
    facility - stopping at the first 200, or the first non-403 failure."""
    url = f"{UC_BASE_URL}/services/rest/v1/oms/saleorder/get"
    attempts = []
    if facility_code:
        attempts.append(facility_code)
    attempts.append(None)
    for fc in all_facility_codes:
        if fc != facility_code:
            attempts.append(fc)

    resp = None
    for fc in attempts:
        resp = requests.post(url, headers=uc_headers(token, fc), json={"code": so_code}, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("successful"):
                return data.get("saleOrderDTO"), fc
        if resp.status_code != 403:
            break
    raise Exception(f"saleOrder/get failed: {resp.status_code if resp else '?'} {resp.text[:200] if resp else ''}")


def create_order(token, facility_code, order_payload):
    url = f"{UC_BASE_URL}/services/rest/v1/oms/saleOrder/create"
    resp = requests.post(url, headers=uc_headers(token, facility_code), json=order_payload, timeout=30)
    if resp.status_code != 200:
        raise Exception(f"create returned {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if not data.get("successful"):
        msgs = "; ".join(str(e.get("description") or e.get("message") or e) for e in (data.get("errors") or []))
        raise Exception(f"Create failed: {msgs}")
    return data


def search_and_resolve(token, display_order_code, settings):
    """Mirrors searchAndResolve_: searches the bare code plus every _1.._max_suffix variant,
    collects every existing SO code, the DELIVERED-status SO code (if any), and the most recent
    repunch within the cooldown window (if any) - falling back to direct saleOrder/get lookups
    on up to 3 candidates if the search results themselves carried no status/date fields."""
    existing_codes = {}
    delivered_code = None
    orig_so_code = None
    recent_repunch = None
    cooldown_ms = settings["cooldown_days"] * 24 * 60 * 60 * 1000
    now_ms = time.time() * 1000
    all_so_codes = []
    codes_needing_date_check = []
    status_found_in_search = False

    search_list = [display_order_code] + [f"{display_order_code}_{n}" for n in range(1, settings["max_suffix"] + 1)]

    for search_doc in search_list:
        elements = search_display_code(token, search_doc)
        for el in elements:
            code = el.get("code")
            if code:
                existing_codes[code] = True
            if el.get("displayOrderCode") == search_doc:
                if search_doc == display_order_code and not orig_so_code:
                    orig_so_code = code
                if code:
                    all_so_codes.append(code)

                el_status = extract_status(el)
                if el_status:
                    status_found_in_search = True
                    if not delivered_code and "DELIVER" in el_status:
                        delivered_code = code

                if not recent_repunch and code:
                    created_val = extract_created_date(el)
                    if created_val:
                        created_ms = parse_timestamp(created_val)
                        if created_ms and (now_ms - created_ms) < cooldown_ms:
                            recent_repunch = {"code": code, "days_ago": round((now_ms - created_ms) / (24 * 60 * 60 * 1000), 1)}
                    else:
                        codes_needing_date_check.append(code)

    needs_get_fallback = (not delivered_code and not status_found_in_search) or (not recent_repunch and codes_needing_date_check)
    if needs_get_fallback and all_so_codes:
        check_limit = min(len(all_so_codes), 3)
        for so_code in reversed(all_so_codes[-check_limit:]):
            dto = get_order_dto(token, so_code)
            if not dto:
                continue
            if not delivered_code:
                get_status = extract_status(dto)
                if get_status and "DELIVER" in get_status:
                    delivered_code = so_code
            if not recent_repunch:
                get_created = extract_created_date(dto)
                if get_created:
                    get_ms = parse_timestamp(get_created)
                    if get_ms and (now_ms - get_ms) < cooldown_ms:
                        recent_repunch = {"code": so_code, "days_ago": round((now_ms - get_ms) / (24 * 60 * 60 * 1000), 1)}
            if delivered_code and recent_repunch:
                break

    if not orig_so_code:
        raise Exception(f"No order found for '{display_order_code}'")

    return {
        "orig_so_code": orig_so_code,
        "existing_codes": existing_codes,
        "delivered": delivered_code,
        "recent_repunch": recent_repunch,
    }


# ---- Postgres helpers - this worker's own psycopg connection, separate from Node's pgSql ----

def fetch_job(conn, job_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, status, created_by, total_rows, processed_count, success_count, "
            "error_count, skipped_count, stop_requested FROM order_punch_jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    keys = ["id", "status", "created_by", "total_rows", "processed_count", "success_count",
            "error_count", "skipped_count", "stop_requested"]
    return dict(zip(keys, row))


def fetch_next_pending_row(conn, job_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT row_index, display_order_code, reason, facility_code FROM order_punch_job_rows "
            "WHERE job_id = %s AND status = 'pending' ORDER BY row_index LIMIT 1",
            (job_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {"row_index": row[0], "display_order_code": row[1], "reason": row[2], "facility_code": row[3]}


def count_pending_rows(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM order_punch_job_rows WHERE job_id = %s AND status = 'pending'", (job_id,))
        return cur.fetchone()[0]


def update_row_status(conn, job_id, row_index, status, so_code=None, target_channel=None, error_message=None):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE order_punch_job_rows SET status = %s, so_code = %s, target_channel = %s, "
            "error_message = %s, updated_at = now() WHERE job_id = %s AND row_index = %s",
            (status, so_code, target_channel, error_message, job_id, row_index),
        )
    conn.commit()


def update_job_counters(conn, job_id, **fields):
    if not fields:
        return
    set_clauses = []
    values = []
    for key, value in fields.items():
        set_clauses.append(f"{key} = %s")
        values.append(value)
    values.append(job_id)
    with conn.cursor() as cur:
        cur.execute(f"UPDATE order_punch_jobs SET {', '.join(set_clauses)}, updated_at = now() WHERE id = %s", values)
    conn.commit()


def fetch_settings(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT key, value FROM order_punch_settings")
        rows = cur.fetchall()
    settings = dict(DEFAULT_SETTINGS)
    for key, value in rows:
        settings[key] = json.loads(value) if isinstance(value, str) else value
    return settings


def invoke_self(job_id):
    import boto3
    boto3.client("lambda").invoke(
        FunctionName=WORKER_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps({"jobId": job_id}).encode("utf-8"),
    )


def process_one_row(conn, job_id, row, token, settings, agent_email):
    """One row's full attempt-plus-one-retry, mirroring the script's per-row try/except
    exactly: on a retryable failure (token expired, rate limited, "no order found"), refresh
    the token and retry once, checking first whether the earlier attempt actually succeeded
    despite the error (duplicate-create recovery) before trying to create again. Returns
    (outcome, possibly-refreshed token)."""
    row_index = row["row_index"]
    doc = row["display_order_code"]
    facility = row["facility_code"] or None
    reason = row["reason"] or None
    attempted_so_code = None

    try:
        sr = search_and_resolve(token, doc, settings)

        if sr["delivered"]:
            update_row_status(conn, job_id, row_index, "skipped",
                               error_message=f"ALREADY DELIVERED | {sr['delivered']} has status DELIVERED")
            return "skipped", token

        if sr["recent_repunch"]:
            update_row_status(conn, job_id, row_index, "skipped", error_message=(
                f"already repunched {sr['recent_repunch']['days_ago']} day(s) ago - "
                f"{sr['recent_repunch']['code']} (cooldown: {settings['cooldown_days']} days)"
            ))
            return "skipped", token

        order, _ = get_order(token, sr["orig_so_code"], facility, settings["facility_codes"])
        target_channel = resolve_target_channel(
            order.get("channel") or "", settings["mcaffeine_channels"], settings["hyphen_channels"],
            settings["target_mcaffeine"], settings["target_hyphen"],
        )
        same_channel = (order.get("channel") or "") == target_channel
        so_code = pick_so_code(doc, same_channel, sr["existing_codes"], settings["max_suffix"])
        if not so_code:
            update_row_status(conn, job_id, row_index, "skipped",
                               error_message=f"SKIPPED | max suffix _{settings['max_suffix']} reached")
            return "skipped", token

        attempted_so_code = so_code
        payload = build_create_payload(order, doc, so_code, target_channel, facility, reason, agent_email)
        create_order(token, facility, payload)
        update_row_status(conn, job_id, row_index, "success", so_code=so_code, target_channel=target_channel)
        return "success", token

    except Exception as e:
        retryable = isinstance(e, (TokenExpiredError, RateLimitedError)) or "No order found" in str(e)
        if not retryable:
            update_row_status(conn, job_id, row_index, "error", so_code=attempted_so_code, error_message=str(e))
            return "error", token

        try:
            token = get_uc_token()
            time.sleep(1)
            sr2 = search_and_resolve(token, doc, settings)

            if sr2["delivered"]:
                update_row_status(conn, job_id, row_index, "skipped",
                                   error_message=f"ALREADY DELIVERED | {sr2['delivered']} has status DELIVERED")
                return "skipped", token
            if sr2["recent_repunch"]:
                update_row_status(conn, job_id, row_index, "skipped", error_message=(
                    f"already repunched {sr2['recent_repunch']['days_ago']} day(s) ago - "
                    f"{sr2['recent_repunch']['code']} (cooldown: {settings['cooldown_days']} days)"
                ))
                return "skipped", token
            if attempted_so_code and attempted_so_code in sr2["existing_codes"]:
                # The first attempt's create actually succeeded despite the error - don't
                # create a second time.
                update_row_status(conn, job_id, row_index, "success", so_code=attempted_so_code)
                return "success", token

            order2, _ = get_order(token, sr2["orig_so_code"], facility, settings["facility_codes"])
            target_channel2 = resolve_target_channel(
                order2.get("channel") or "", settings["mcaffeine_channels"], settings["hyphen_channels"],
                settings["target_mcaffeine"], settings["target_hyphen"],
            )
            same_channel2 = (order2.get("channel") or "") == target_channel2
            so_code2 = pick_so_code(doc, same_channel2, sr2["existing_codes"], settings["max_suffix"])
            if not so_code2:
                update_row_status(conn, job_id, row_index, "skipped",
                                   error_message=f"SKIPPED | max suffix _{settings['max_suffix']} reached (order may already exist)")
                return "skipped", token

            payload2 = build_create_payload(order2, doc, so_code2, target_channel2, facility, reason, agent_email)
            create_order(token, facility, payload2)
            update_row_status(conn, job_id, row_index, "success", so_code=so_code2, target_channel=target_channel2)
            return "success", token

        except Exception as retry_err:
            so_tag = f"(SO: {attempted_so_code}) " if attempted_so_code else ""
            update_row_status(conn, job_id, row_index, "error", so_code=attempted_so_code,
                               error_message=f"{so_tag}(retry failed) {retry_err}")
            return "error", token


def process_job(job_id):
    """Entrypoint - one Lambda invoke's worth of work. Self-invokes to continue if rows remain
    pending after CHUNK_BUDGET_SEC, mirroring the Apps Script's own always-resume design (see
    the design spec's Error handling section)."""
    conn_str = os.environ.get("POSTGRES_URL")
    try:
        conn = lib.get_pg_connection(conn_str)
    except Exception as e:
        print(f"process_job({job_id}): could not connect to Postgres, giving up: {e}")
        return

    try:
        job = fetch_job(conn, job_id)
        if job is None:
            print(f"process_job({job_id}): job not found")
            return
        if job["stop_requested"]:
            update_job_counters(conn, job_id, status="stopped")
            return
        if job["status"] == "done":
            print(f"process_job({job_id}): already done, skipping duplicate invoke")
            return

        update_job_counters(conn, job_id, status="running")
        settings = fetch_settings(conn)
        agent_email = job["created_by"]

        token = get_uc_token()
        token_fetched_at = time.monotonic()
        started_at = time.monotonic()
        consecutive_403 = 0
        success = job["success_count"]
        errors = job["error_count"]
        skipped = job["skipped_count"]
        processed = job["processed_count"]

        while time.monotonic() - started_at < CHUNK_BUDGET_SEC:
            fresh = fetch_job(conn, job_id)
            if fresh and fresh["stop_requested"]:
                update_job_counters(conn, job_id, status="stopped")
                return

            row = fetch_next_pending_row(conn, job_id)
            if row is None:
                break

            if time.monotonic() - token_fetched_at > TOKEN_REFRESH_SEC:
                try:
                    token = get_uc_token()
                    token_fetched_at = time.monotonic()
                except Exception as refresh_err:
                    print(f"  token refresh failed, keeping old token: {refresh_err}")

            if consecutive_403 >= MAX_CONSECUTIVE_403:
                time.sleep(30)
                consecutive_403 = 0
                try:
                    token = get_uc_token()
                    token_fetched_at = time.monotonic()
                except Exception:
                    pass

            try:
                outcome, token = process_one_row(conn, job_id, row, token, settings, agent_email)
            except (TokenExpiredError, RateLimitedError):
                # process_one_row already handles these internally via its own retry - reaching
                # here would only happen if that retry itself raised one of these again, which
                # process_one_row's own except-all already converts to a row-level "error"
                # instead of propagating. Kept as a defensive fallback, not the expected path.
                outcome = "error"
            if outcome == "success":
                success += 1
                consecutive_403 = 0
            elif outcome == "skipped":
                skipped += 1
                consecutive_403 = 0
            else:
                errors += 1
            processed += 1
            update_job_counters(conn, job_id, processed_count=processed, success_count=success,
                                 error_count=errors, skipped_count=skipped)
            time.sleep(SLEEP_BETWEEN_SEC)

        remaining = count_pending_rows(conn, job_id)
        if remaining > 0:
            print(f"process_job({job_id}): {remaining} row(s) still pending, scheduling continuation")
            invoke_self(job_id)
        else:
            update_job_counters(conn, job_id, status="done")
            print(f"process_job({job_id}): done - {success} success, {errors} error, {skipped} skipped")

    except Exception as e:
        print(f"process_job({job_id}): chunk crashed: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            fresh = fetch_job(conn, job_id)
        except Exception:
            fresh = None
        if fresh and fresh.get("stop_requested"):
            try:
                update_job_counters(conn, job_id, status="stopped")
            except Exception:
                pass
        else:
            try:
                invoke_self(job_id)
            except Exception as invoke_err:
                print(f"process_job({job_id}): could not schedule continuation after crash: {invoke_err}")
                try:
                    update_job_counters(conn, job_id, status="failed", error_message=str(e))
                except Exception:
                    pass
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python process_order_punch_job.py <job_id>")
    process_job(int(sys.argv[1]))
```

- [ ] **Step 2: Re-run the Task 9 test to confirm the append didn't break the pure functions**

Run: `python scripts/test_process_order_punch_job.py`
Expected: `15 passed`

- [ ] **Step 3: Commit**

```bash
git add scripts/process_order_punch_job.py
git commit -m "feat: add Order Punch worker's Unicommerce calls, Postgres access, and self-continuation"
```

---

## Task 11: Lambda handler + build.sh

**Files:**
- Create: `lambda/order_punch_worker/handler.py`
- Modify: `lambda/build.sh`

**Interfaces:**
- Consumes: `process_order_punch_job.process_job(job_id)` (Task 10).
- Produces: `lambda/dist/order_punch_worker.zip` (built by `build.sh order_punch_worker`),
  containing `handler.py` + `scripts/process_order_punch_job.py` + `scripts/lib.py`.

- [ ] **Step 1: Write `lambda/order_punch_worker/handler.py`**

```python
"""Lambda entrypoint for the Order Punch background worker. Invoked fire-and-forget by
api/order-punch/start.js with event shape {"jobId": <int>}, and by the worker itself
(process_order_punch_job.invoke_self) to continue a job that outran one invoke's time budget -
see docs/superpowers/specs/2026-08-21-order-punch-design.md.

Directory layout expected at the Lambda task root (see ../build.sh):
    handler.py
    scripts/process_order_punch_job.py, lib.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import process_order_punch_job  # noqa: E402


def handler(event, context):
    job_id = event.get("jobId")
    if job_id is None:
        print("order-punch-worker: no jobId in event, nothing to do")
        return {"ok": False, "error": "missing jobId"}
    print(f"order-punch-worker: starting job {job_id}")
    process_order_punch_job.process_job(int(job_id))
    print(f"order-punch-worker: finished this invoke for job {job_id}")
    return {"ok": True}
```

- [ ] **Step 2: Add a build function to `lambda/build.sh`**

Insert after the existing `build_csv_upload_worker()` function body:

```bash
build_order_punch_worker() {
  echo "=== Building order_punch_worker.zip ==="
  work="$(mktemp -d)"
  mkdir -p "$work/scripts"

  cp "$LAMBDA_DIR/order_punch_worker/handler.py" "$work/handler.py"
  cp "$REPO_ROOT/scripts/process_order_punch_job.py" \
     "$REPO_ROOT/scripts/lib.py" \
     "$work/scripts/"

  # Only requests (Unicommerce HTTP) + psycopg (Postgres) - no MySQL, no Sheets, no GoKwik, so
  # no pymysql/cryptography needed here (unlike assign_leads.zip/csv_upload_worker.zip). boto3
  # ships in every AWS Python Lambda runtime already, so it is NOT installed here.
  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" psycopg[binary] requests

  ( cd "$work" && zip -r -q "$OUT_DIR/order_punch_worker.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/order_punch_worker.zip"
}
```

Then change the `case` block at the bottom of the file from:
```bash
case "${1:-all}" in
  assign_leads) build_assign_leads ;;
  assign_ndr_leads) build_assign_ndr_leads ;;
  csv_upload_worker) build_csv_upload_worker ;;
  all) build_assign_leads; build_assign_ndr_leads; build_csv_upload_worker ;;
  *) echo "Usage: $0 [assign_leads|assign_ndr_leads|csv_upload_worker]" >&2; exit 1 ;;
esac
```
to:
```bash
case "${1:-all}" in
  assign_leads) build_assign_leads ;;
  assign_ndr_leads) build_assign_ndr_leads ;;
  csv_upload_worker) build_csv_upload_worker ;;
  order_punch_worker) build_order_punch_worker ;;
  all) build_assign_leads; build_assign_ndr_leads; build_csv_upload_worker; build_order_punch_worker ;;
  *) echo "Usage: $0 [assign_leads|assign_ndr_leads|csv_upload_worker|order_punch_worker]" >&2; exit 1 ;;
esac
```

- [ ] **Step 3: Sanity-check the handler imports correctly**

Run: `cd lambda/order_punch_worker && python -c "import sys; sys.path.insert(0, '../../scripts'); import handler" `

Expected: no output, exit code 0 (this only checks the import chain resolves — actually
building the zip requires the Linux/WSL environment `build.sh` itself documents needing, which
this environment doesn't have; that's the acknowledged manual step, same as every other worker
here).

- [ ] **Step 4: Commit**

```bash
git add lambda/order_punch_worker/handler.py lambda/build.sh
git commit -m "feat: add Order Punch worker's Lambda handler and build.sh target"
```

---

## Task 12: `deploy_infra.sh` — Lambda function, dedicated IAM role, Secrets Manager precondition

**Files:**
- Modify: `lambda/deploy_infra.sh`

**Interfaces:**
- Produces: `mcaff-cls-order-punch-worker` Lambda (created or updated), its own
  `mcaff-cls-order-punch-worker-role` IAM role, reserved concurrency 1, zero retry attempts.

This is infrastructure-as-a-script, not app code — there is nothing to unit-test here; it is
run manually by a human with AWS CLI access (same as every other section of this file), which
is outside what this environment can do. This task only edits the script text correctly.

- [ ] **Step 1: Insert a new section after the existing csv-upload-worker section (5b) and
  before the RETIRED sync-lead-assignments section (6)**

```bash
# ---- 5c. order-punch-worker Lambda - Order Punch feature's background worker (own function,
#          same "own timeout at creation" reasoning as csv-upload-worker above). Own IAM role
#          (not the shared $ROLE_NAME above) since it needs two permissions - reading the
#          Unicommerce secret, invoking itself to continue a job that outran one invoke's time
#          budget - that assign-leads/assign-ndr-leads/csv-upload-worker have no business also
#          holding just because they'd share a role. No EventBridge schedule: invoked on-demand
#          by api/order-punch/start.js, and by itself for continuation. ----
ORDER_PUNCH_ROLE_NAME="mcaff-cls-order-punch-worker-role"
if ! aws iam get-role --role-name "$ORDER_PUNCH_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ORDER_PUNCH_ROLE_NAME" \
    --assume-role-policy-document file:///tmp/trust-policy.json
  aws iam attach-role-policy --role-name "$ORDER_PUNCH_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "Created $ORDER_PUNCH_ROLE_NAME - waiting 10s for IAM propagation..."
  sleep 10
else
  echo "$ORDER_PUNCH_ROLE_NAME already exists, reusing."
fi
ORDER_PUNCH_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ORDER_PUNCH_ROLE_NAME}"

# The Unicommerce credential is never created by this script (see the design spec's own note on
# why) - it must already exist before this section can grant read access to it.
if ! aws secretsmanager describe-secret --secret-id mcaff-cls/unicommerce --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "ERROR: secret 'mcaff-cls/unicommerce' does not exist yet. Create it first, e.g.:" >&2
  echo "  aws secretsmanager create-secret --name mcaff-cls/unicommerce --region $AWS_REGION \\" >&2
  echo "    --secret-string '{\"username\":\"...\",\"password\":\"...\"}'" >&2
  exit 1
fi
UC_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id mcaff-cls/unicommerce --region "$AWS_REGION" --query ARN --output text)"

FN_ORDER_PUNCH_WORKER=mcaff-cls-order-punch-worker
ORDER_PUNCH_WORKER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_ORDER_PUNCH_WORKER}"
cat > /tmp/order-punch-worker-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "${UC_SECRET_ARN}"},
    {"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "${ORDER_PUNCH_WORKER_ARN}"}
  ]
}
EOF
aws iam put-role-policy --role-name "$ORDER_PUNCH_ROLE_NAME" \
  --policy-name order-punch-worker-access --policy-document file:///tmp/order-punch-worker-policy.json

if ! aws lambda get-function --function-name "$FN_ORDER_PUNCH_WORKER" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_ORDER_PUNCH_WORKER" \
    --runtime python3.12 --handler handler.handler --role "$ORDER_PUNCH_ROLE_ARN" \
    --timeout 900 --memory-size 256 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/order_punch_worker.zip" >/dev/null
else
  aws lambda update-function-code --function-name "$FN_ORDER_PUNCH_WORKER" \
    --zip-file "fileb://$DIST/order_punch_worker.zip" --region "$AWS_REGION" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN_ORDER_PUNCH_WORKER" --region "$AWS_REGION"
# Only POSTGRES_URL as a plain env var - the Unicommerce credential deliberately does NOT
# follow the other workers' plain-env-var pattern (see the design spec's "why deviate" note):
# it's read from Secrets Manager at runtime via the IAM policy granted above.
aws lambda update-function-configuration --function-name "$FN_ORDER_PUNCH_WORKER" --region "$AWS_REGION" \
  --environment "Variables={POSTGRES_URL=${POSTGRES_URL}}" \
  >/dev/null
# Reserved concurrency 1: serializes this job's own continuations and any other queued job, so
# two workers never race the same display-code's _1/_2 suffix assignment.
aws lambda put-function-concurrency --function-name "$FN_ORDER_PUNCH_WORKER" \
  --reserved-concurrent-executions 1 --region "$AWS_REGION"
# Same duplicate-create-avoidance reasoning as csv-upload-worker's own event-invoke config -
# the real correctness backstop is process_one_row's own duplicate-create recovery logic, this
# just avoids the wasted retry.
aws lambda put-function-event-invoke-config --function-name "$FN_ORDER_PUNCH_WORKER" \
  --maximum-retry-attempts 0 --region "$AWS_REGION"
```

- [ ] **Step 2: Update the trailing summary echo**

Change:
```bash
echo "Done. Two Lambdas are deployed and their EventBridge schedules are live:"
echo "assign-leads and assign-ndr-leads, both every 5 minutes. (sync-lead-assignments is"
echo "retired - its own Lambda/schedule sections above are commented out, not re-created here.)"
```
to:
```bash
echo "Done. Two Lambdas are deployed and their EventBridge schedules are live:"
echo "assign-leads and assign-ndr-leads, both every 5 minutes. (sync-lead-assignments is"
echo "retired - its own Lambda/schedule sections above are commented out, not re-created here.)"
echo "order-punch-worker is also deployed (on-demand invoke only, no schedule)."
```

- [ ] **Step 3: Commit**

```bash
git add lambda/deploy_infra.sh
git commit -m "feat: deploy Order Punch worker Lambda with its own IAM role"
```

---

## Task 13: Exports hub — tab bar hosting Refund Export + Order Punch

**Files:**
- Create: `app/exports/page.js`
- Create: `app/exports/ExportsClient.js`
- Modify: `app/HomeClient.js` (exports entry's `url`)

**Interfaces:**
- Consumes: existing `RefundExportClient` (`app/refund-export/RefundExportClient.js`,
  unmodified), `GET /api/auth/me` (existing endpoint), `OrderPunchClient` (Task 14).
- Produces: `/exports` route with a tab bar. `/refund-export` is left completely untouched and
  keeps working on its own.

No test file — matches this repo's convention of no test coverage for page-level React
components (`RefundExportClient.js`, `RtoUploadModal.js` etc. have none either); this is
exercised only by manual verification in a browser, which is the user's own step.

- [ ] **Step 1: Write `app/exports/ExportsClient.js`**

```js
'use client';

// Calling Team's "Exports" tab hub - a small tab bar over the two things this desk has here:
// the existing read-only Refund Export (unchanged, just re-hosted under this tab bar instead
// of being the whole page) and the new Order Punch action (admin-only - creates real orders in
// Unicommerce, see docs/superpowers/specs/2026-08-21-order-punch-design.md). HomeClient.js's
// own exports entry now points here instead of straight at /refund-export; that route still
// exists and still works on its own for anything that links to it directly.
import { useEffect, useState } from 'react';
import RefundExportClient from '../refund-export/RefundExportClient';
import OrderPunchClient from './OrderPunchClient';

const TABS = [
  { key: 'refund', label: 'Refund Export' },
  { key: 'order-punch', label: 'Order Punch' },
];

export default function ExportsClient() {
  const [tab, setTab] = useState('refund');
  const [isAdmin, setIsAdmin] = useState(null); // null = not yet known

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      setIsAdmin(!!(d && d.authenticated && d.isAdmin));
    }).catch(() => setIsAdmin(false));
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #ddd', padding: '0 24px' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '10px 16px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: tab === t.key ? 700 : 400,
              borderBottom: tab === t.key ? '2px solid #333' : '2px solid transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'refund' && <RefundExportClient />}
      {tab === 'order-punch' && (
        isAdmin === null ? (
          <div style={{ padding: 24 }}>Loading…</div>
        ) : isAdmin ? (
          <OrderPunchClient />
        ) : (
          <div style={{ padding: 24, color: '#666' }}>Order Punch is admin-only.</div>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `app/exports/page.js`**

```js
import ExportsClient from './ExportsClient';

export const metadata = {
  title: 'Calling Team — Exports',
};

export default function Page() {
  return <ExportsClient />;
}
```

- [ ] **Step 3: Point `HomeClient.js`'s exports entry at the new hub**

In `app/HomeClient.js`, change:
```js
  exports: { label: 'Exports', text: 'Refund Export', url: '/refund-export' }
```
to:
```js
  exports: { label: 'Exports', text: 'Exports', url: '/exports' }
```

- [ ] **Step 4: Commit**

```bash
git add app/exports/page.js app/exports/ExportsClient.js app/HomeClient.js
git commit -m "feat: add Exports tab bar hosting Refund Export and Order Punch"
```

(`OrderPunchClient` doesn't exist yet at the end of this task — that's fine, Task 14 adds it
next; nothing in this repo runs `next build` as part of these tasks, so an unresolved import
between commits within the same plan isn't a problem here. If you want each commit to build
cleanly in isolation, do Task 14 before committing Task 13.)

---

## Task 14: `OrderPunchClient` — CSV/manual input, start/poll/stop, results download, settings

**Files:**
- Create: `app/exports/OrderPunchClient.js`

**Interfaces:**
- Consumes: `POST /api/order-punch/start`, `GET /api/order-punch/status`,
  `POST /api/order-punch/stop`, `GET /api/order-punch/results`,
  `GET`/`PUT /api/order-punch/settings` (Tasks 4–8).
- Produces: default export `OrderPunchClient`, used by `ExportsClient` (Task 13).

No test file — same reasoning as Task 13.

- [ ] **Step 1: Write `app/exports/OrderPunchClient.js`**

```js
'use client';

// Order Punch tab - admin-only. Queues a batch of orders for repunch via the background
// Lambda worker (mcaff-cls-order-punch-worker); see
// docs/superpowers/specs/2026-08-21-order-punch-design.md. Both the CSV upload and the manual
// rows table build the same {doc, reason, facility_code}[] shape and POST it to the same
// /api/order-punch/start endpoint.
import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped']);
const SETTINGS_FIELDS = [
  { key: 'facility_codes', label: 'Facility codes', type: 'array' },
  { key: 'mcaffeine_channels', label: 'mCaffeine channels', type: 'array' },
  { key: 'hyphen_channels', label: 'Hyphen channels', type: 'array' },
  { key: 'target_mcaffeine', label: 'Target channel (mCaffeine)', type: 'string' },
  { key: 'target_hyphen', label: 'Target channel (Hyphen)', type: 'string' },
  { key: 'cooldown_days', label: 'Repunch cooldown (days)', type: 'number' },
  { key: 'max_suffix', label: 'Max duplicate suffix', type: 'number' },
];

function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const docIdx = header.indexOf('display_order_code');
  const reasonIdx = header.indexOf('reason');
  const facilityIdx = header.indexOf('facility_code');
  if (docIdx === -1) return [];
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return {
      doc: (cells[docIdx] || '').trim(),
      reason: reasonIdx >= 0 ? (cells[reasonIdx] || '').trim() : '',
      facility_code: facilityIdx >= 0 ? (cells[facilityIdx] || '').trim() : '',
    };
  }).filter((r) => r.doc);
}

export default function OrderPunchClient() {
  const [manualRows, setManualRows] = useState([{ doc: '', reason: '', facility_code: '' }]);
  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function loadSettings() {
    setSettingsError('');
    fetch('/api/order-punch/settings').then((r) => r.json()).then((d) => {
      if (d.settings) setSettings(d.settings);
      else setSettingsError(d.error || 'Could not load settings');
    }).catch((e) => setSettingsError(e.message));
  }

  function openSettings() {
    setShowSettings(true);
    if (!settings) loadSettings();
  }

  async function saveSetting(key, value) {
    setSettingsError('');
    try {
      const res = await fetch('/api/order-punch/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      setSettings(data.settings);
    } catch (e) {
      setSettingsError(e.message);
    }
  }

  function readCsvFile(f) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result || '')); setCsvFileName(f.name); };
    reader.readAsText(f);
  }

  function addManualRow() {
    setManualRows((rows) => [...rows, { doc: '', reason: '', facility_code: '' }]);
  }

  function updateManualRow(i, field, value) {
    setManualRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }

  function removeManualRow(i) {
    setManualRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  function pollJob(id) {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/order-punch/status?jobId=${id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not fetch status');
        setJobStatus(data);
        if (TERMINAL_STATUSES.has(data.status)) clearInterval(pollRef.current);
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleStart() {
    setError('');
    const csvRows = parseCsvRows(csvText);
    const rows = [...csvRows, ...manualRows.filter((r) => r.doc.trim())];
    if (!rows.length) { setError('Add at least one order code (CSV or manual row)'); return; }

    setSubmitting(true);
    setJobId(null);
    setJobStatus(null);
    try {
      const res = await fetch('/api/order-punch/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start');
      setJobId(data.jobId);
      setJobStatus({ status: 'queued', totalRows: data.queued, processedCount: 0, successCount: 0, errorCount: 0, skippedCount: 0 });
      pollJob(data.jobId);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop() {
    if (!jobId) return;
    try {
      await fetch('/api/order-punch/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
    } catch (e) {
      setError(e.message);
    }
  }

  function handleDownloadResults() {
    if (!jobId) return;
    window.location.href = `/api/order-punch/results?jobId=${jobId}`;
  }

  const running = jobStatus && !TERMINAL_STATUSES.has(jobStatus.status);

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 20 }}>Order Punch</h1>
        <button onClick={openSettings} style={{ padding: '6px 12px', fontSize: 13 }}>Settings</button>
      </div>

      {showSettings && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Order Punch settings</h3>
          {settingsError && <p style={{ color: '#c0392b', fontSize: 13 }}>{settingsError}</p>}
          {!settings ? <p style={{ fontSize: 13 }}>Loading…</p> : SETTINGS_FIELDS.map((f) => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{f.label}</label>
              <input
                type="text"
                defaultValue={f.type === 'array' ? (settings[f.key] || []).join(', ') : settings[f.key]}
                style={{ width: '100%', padding: 6, fontSize: 13 }}
                onBlur={(e) => {
                  const raw = e.target.value;
                  const value = f.type === 'array'
                    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                    : f.type === 'number' ? Number(raw) : raw.trim();
                  saveSetting(f.key, value);
                }}
              />
            </div>
          ))}
          <button onClick={() => setShowSettings(false)} style={{ padding: '6px 12px', fontSize: 13, marginTop: 8 }}>Close</button>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Upload CSV (columns: display_order_code, reason, facility_code)
        </label>
        <input
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          onChange={(e) => readCsvFile(e.target.files?.[0])}
        />
        {csvFileName && <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>{csvFileName}</span>}
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Or add rows manually
        </label>
        {manualRows.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input placeholder="Order code" value={r.doc} onChange={(e) => updateManualRow(i, 'doc', e.target.value)} style={{ flex: 2, padding: 6, fontSize: 13 }} />
            <input placeholder="Reason (optional)" value={r.reason} onChange={(e) => updateManualRow(i, 'reason', e.target.value)} style={{ flex: 2, padding: 6, fontSize: 13 }} />
            <input placeholder="Facility code (optional)" value={r.facility_code} onChange={(e) => updateManualRow(i, 'facility_code', e.target.value)} style={{ flex: 2, padding: 6, fontSize: 13 }} />
            {manualRows.length > 1 && <button onClick={() => removeManualRow(i)} style={{ padding: '0 8px' }}>×</button>}
          </div>
        ))}
        <button onClick={addManualRow} style={{ padding: '4px 10px', fontSize: 12 }}>+ Add row</button>
      </div>

      <button
        onClick={handleStart}
        disabled={submitting || running}
        style={{ padding: '8px 16px', fontSize: 14, fontWeight: 600 }}
      >
        {submitting ? 'Starting…' : 'Start Order Punch'}
      </button>

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}

      {jobStatus && (
        <div style={{ marginTop: 20, padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, marginBottom: 8 }}>
            <span>Status: <strong>{jobStatus.status}</strong></span>
            <span>{jobStatus.processedCount ?? 0}/{jobStatus.totalRows} processed</span>
            <span>✅ {jobStatus.successCount ?? 0}</span>
            <span>❌ {jobStatus.errorCount ?? 0}</span>
            <span>⊘ {jobStatus.skippedCount ?? 0}</span>
          </div>
          {jobStatus.status === 'failed' && jobStatus.errorMessage && (
            <p style={{ color: '#c0392b', fontSize: 13 }}>{jobStatus.errorMessage}</p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {running && <button onClick={handleStop} style={{ padding: '6px 12px', fontSize: 13 }}>Stop</button>}
            {TERMINAL_STATUSES.has(jobStatus.status) && (
              <button onClick={handleDownloadResults} style={{ padding: '6px 12px', fontSize: 13 }}>Download Results CSV</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Sanity-check the file is syntactically valid JS**

Run: `node --check app/exports/OrderPunchClient.js`

Expected: `node --check` on JSX will actually fail here (JSX isn't valid plain JS) — this is
expected and fine; skip this check for `.js` files containing JSX (this repo's other client
components, e.g. `RtoUploadModal.js`, are never run through `node --check` either — they're
verified by Next.js's own build when the app is actually run, which is the user's own manual
step).

- [ ] **Step 3: Commit**

```bash
git add app/exports/OrderPunchClient.js
git commit -m "feat: add OrderPunchClient (CSV/manual input, polling, results, settings)"
```

---

## Manual verification (user's own step, not part of any task above)

Once deployed:
1. `lambda/build.sh order_punch_worker` from WSL/Linux, then run `lambda/deploy_infra.sh`
   (after creating the `mcaff-cls/unicommerce` secret by hand).
2. Visit `/exports` as an admin, confirm both tabs render and Refund Export behaves exactly as
   before.
3. Submit a small manual batch (1–2 real order codes) on Order Punch, watch it reach `done`,
   download the results CSV, and confirm the created order(s) in Unicommerce show the expected
   `giftMessage`/`voucherCode`/channel/facility.
4. Confirm a non-admin session sees "Order Punch is admin-only" and gets 401/403 from every
   `/api/order-punch/*` endpoint directly.
