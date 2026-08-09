# Escalation on BigQuery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Escalation desk off Google Sheets and Postgres onto BigQuery — the sheet syncs into BigQuery on change, and every application read and write happens in BigQuery.

**Architecture:** An Apps Script `onChange` trigger posts to a secret-gated sync endpoint, which reads the sheet tab, submits a BigQuery **load job** (not a streaming insert, so DML is never blocked by the streaming buffer) into a staging table, then MERGEs sheet-owned columns into `escalation.orders` without ever touching app-owned columns. The application reads with `jobs.query` and writes with row-level `UPDATE`, with every bulk path collapsed to a single `MERGE`.

**Tech Stack:** Node 18+ (`fetch` is global), `google-auth-library` JWT, BigQuery REST API v2, Next.js 14 client, Google Apps Script. No new npm dependencies.

**Design spec:** [`docs/superpowers/specs/2026-08-09-escalation-bigquery-migration-design.md`](../specs/2026-08-09-escalation-bigquery-migration-design.md)

## Global Constraints

- **No new npm dependencies.** BigQuery is accessed over REST with `fetch`, authenticated by a `google-auth-library` JWT. `@google-cloud/bigquery` must not be added — the Lambda bundle is near the 6MB payload ceiling.
- **Load jobs only, never streaming inserts.** `tabledata.insertAll` and the Storage Write API are forbidden: rows they write sit in a streaming buffer where `UPDATE`/`MERGE` fails for up to 90 minutes.
- **Every bulk path is one statement.** No code path may issue N BigQuery statements for N rows. Bulk update, bulk assign, and CSV import each compile to exactly one `MERGE`.
- **Column ownership is absolute.** The sync MERGE writes only sheet-owned columns. Application writes touch only app-owned columns. Neither ever names a column from the other group.
- **Merge key is `(sheet_tab, parent_order, awb_key)`.** Never `row_number` — sheet row numbers shift when anyone sorts or inserts a row.
- **No live testing, no deploy.** Tests are `assert`-based Node scripts with a stubbed `globalThis.fetch`. Never run against real BigQuery, the real sheet, or the real database. Never deploy. The user tests and deploys.
- **Service account:** reuse `GOOGLE_SHEETS_CLIENT_EMAIL` / `GOOGLE_SHEETS_PRIVATE_KEY`, adding the `https://www.googleapis.com/auth/bigquery` scope alongside the existing spreadsheets scope.
- **New env vars:** `BQ_PROJECT_ID`, `BQ_DATASET` (default `escalation`), `ESCALATION_SYNC_SECRET`.
- **Test command:** `npm run test:escalation` (added in Task 1). All tests live in one file, `scripts/test_escalation_bq.js`, appended to by each task.
- **Code style:** match the surrounding files — CommonJS `require`/`module.exports` in `api/`, two-space indent, comments that explain *why* (see `api/_lib/escalationSheet.js` for the house voice).

## File Structure

| File | Responsibility |
|---|---|
| `api/_lib/bigquery.js` | **New.** Transport only. JWT auth, `query()`, `loadNdjson()`, job polling, query-parameter encoding. Knows nothing about escalation. |
| `api/_lib/escalationBq.js` | **New.** The escalation data layer. Table DDL, row mapping, SQL builders, and every read/write function the handler calls. |
| `api/_lib/escalationSheet.js` | **Modify.** Reduced to `readTabRows`, `readAllRows`, `COLUMNS`. Write paths deleted. |
| `api/escalation/[action].js` | **Modify.** Import from `escalationBq`; add `sync` and `assign-bulk` actions. |
| `api/_lib/db.js` | **Modify.** Remove six escalation functions from exports. Table DDL stays. |
| `app/escalation/EscalationClient.js` | **Modify.** Assign payload, single-call auto-assign, optimistic writes, toast copy. |
| `scripts/escalation_sync.gs` | **New.** Apps Script source, checked in for review. |
| `scripts/migrate_escalation_to_bq.js` | **New.** One-off backfill and reconciliation. |
| `scripts/test_escalation_bq.js` | **New.** The single self-check file for everything above. |

---

### Task 1: BigQuery REST transport

**Files:**
- Create: `api/_lib/bigquery.js`
- Create: `scripts/test_escalation_bq.js`
- Modify: `package.json` (add `test:escalation` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `query(sql: string, params?: object[], opts?: {useQueryCache?: boolean}) => Promise<{rows: object[], affectedRows: number}>`
  - `loadNdjson(tableId: string, ndjson: string, schemaFields: {name,type,mode?}[]) => Promise<number>` (returns rows loaded)
  - `strParam(name: string, value: string|null) => object`
  - `structArrayParam(name: string, fields: string[], rows: object[]) => object`
  - `datasetId() => string`, `projectId() => string`

- [ ] **Step 1: Write the failing test**

Create `scripts/test_escalation_bq.js`:

```javascript
// Self-check for the Escalation BigQuery layer. No framework, no live BigQuery: every test
// stubs globalThis.fetch, so this is safe to run anywhere and never touches real data.
//
//   node scripts/test_escalation_bq.js
//
// Each task in the migration plan appends its own section. Keep sections in task order.
'use strict';
const assert = require('assert');

process.env.BQ_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'escalation';
process.env.GOOGLE_SHEETS_CLIENT_EMAIL = 'svc@test.iam.gserviceaccount.com';
process.env.GOOGLE_SHEETS_PRIVATE_KEY = 'unused-because-auth-is-stubbed';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

// Records every fetch call and replies with the queued responses, so a test can assert on the
// exact request body the transport built.
function stubFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.body,
    };
  };
  return calls;
}

const bq = require('../api/_lib/bigquery');
bq._setAuthHeaderForTests(async () => ({ Authorization: 'Bearer test-token' }));

/* ---------- Task 1: transport ---------- */

test('strParam encodes a named STRING parameter', () => {
  assert.deepStrictEqual(bq.strParam('tab', 'HYPHEN'), {
    name: 'tab',
    parameterType: { type: 'STRING' },
    parameterValue: { value: 'HYPHEN' },
  });
});

test('strParam passes null through instead of stringifying it', () => {
  assert.strictEqual(bq.strParam('notes', null).parameterValue.value, null);
});

test('structArrayParam encodes an array of all-STRING structs', () => {
  const p = bq.structArrayParam('items', ['parent_order', 'status'], [
    { parent_order: 'HYP1', status: 'Delivered' },
    { parent_order: 'HYP2', status: 'Delivered' },
  ]);
  assert.strictEqual(p.parameterType.type, 'ARRAY');
  assert.strictEqual(p.parameterType.arrayType.type, 'STRUCT');
  assert.deepStrictEqual(p.parameterType.arrayType.structTypes, [
    { name: 'parent_order', type: { type: 'STRING' } },
    { name: 'status', type: { type: 'STRING' } },
  ]);
  assert.strictEqual(p.parameterValue.arrayValues.length, 2);
  assert.strictEqual(p.parameterValue.arrayValues[0].structValues.parent_order.value, 'HYP1');
});

testAsync('query posts NAMED parameters and maps the row shape', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'parent_order' }, { name: 'status' }] },
    rows: [{ f: [{ v: 'HYP1' }, { v: 'Delivered' }] }],
  } }]);
  const out = await bq.query('SELECT 1', [bq.strParam('tab', 'HYPHEN')]);
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.useLegacySql, false);
  assert.strictEqual(sent.parameterMode, 'NAMED');
  assert.strictEqual(sent.queryParameters[0].name, 'tab');
  assert.deepStrictEqual(out.rows, [{ parent_order: 'HYP1', status: 'Delivered' }]);
});

testAsync('query reports DML affected rows', async () => {
  stubFetch([{ body: { jobComplete: true, numDmlAffectedRows: '7' } }]);
  const out = await bq.query('UPDATE x SET y = 1');
  assert.strictEqual(out.affectedRows, 7);
  assert.deepStrictEqual(out.rows, []);
});

testAsync('query surfaces the BigQuery error message, not a bare status code', async () => {
  stubFetch([{ ok: false, status: 400, body: { error: { message: 'Syntax error near MERGE' } } }]);
  await assert.rejects(bq.query('MERGE bad'), /Syntax error near MERGE/);
});

testAsync('loadNdjson uses a load job with WRITE_TRUNCATE and never streams', async () => {
  const calls = stubFetch([
    { body: { jobReference: { jobId: 'job-1', location: 'US' } } },
    { body: { status: { state: 'DONE' }, statistics: { load: { outputRows: '3' } } } },
  ]);
  const loaded = await bq.loadNdjson('orders_staging', '{"a":1}\n', [{ name: 'a', type: 'STRING' }]);
  assert.strictEqual(loaded, 3);
  assert.match(calls[0].url, /upload\/bigquery\/v2/, 'must use the upload endpoint');
  assert.match(calls[0].url, /uploadType=multipart/);
  assert.ok(!/insertAll/.test(calls[0].url), 'streaming insert is forbidden');
  assert.match(calls[0].init.body, /"writeDisposition":"WRITE_TRUNCATE"/);
  assert.match(calls[0].init.body, /"sourceFormat":"NEWLINE_DELIMITED_JSON"/);
});

testAsync('loadNdjson throws when the load job finishes with an errorResult', async () => {
  stubFetch([
    { body: { jobReference: { jobId: 'job-2', location: 'US' } } },
    { body: { status: { state: 'DONE', errorResult: { message: 'schema mismatch' } } } },
  ]);
  await assert.rejects(bq.loadNdjson('orders_staging', '{}\n', []), /schema mismatch/);
});

/* ---------- summary ---------- */
process.on('exit', () => {
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES ABOVE' : ''}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_escalation_bq.js`
Expected: FAIL — `Cannot find module '../api/_lib/bigquery'`

- [ ] **Step 3: Write minimal implementation**

Create `api/_lib/bigquery.js`:

```javascript
// BigQuery transport for this repo. Deliberately NOT @google-cloud/bigquery: that client pulls
// in a large dependency tree, and this Lambda bundle already runs close to the 6MB payload
// ceiling. The pattern here is the same one api/_lib/escalationSheet.js, api/rto/sheet.js and
// api/ndr/sheet.js already use for Sheets - a google-auth-library JWT plus plain fetch.
//
// LOAD JOBS, NOT STREAMING INSERTS. Nothing in this module writes via tabledata.insertAll. Rows
// written by the streaming API sit in a streaming buffer where UPDATE/DELETE/MERGE fail with
// "would affect rows in the streaming buffer" for up to 90 minutes - which would break every
// write path the Escalation desk has. Load jobs write straight to managed storage, and are free.
const { JWT } = require('google-auth-library');

const API = 'https://bigquery.googleapis.com/bigquery/v2';
const UPLOAD_API = 'https://bigquery.googleapis.com/upload/bigquery/v2';

function projectId() {
  const id = process.env.BQ_PROJECT_ID;
  if (!id) throw new Error('Missing BQ_PROJECT_ID env var');
  return id;
}
function datasetId() {
  return process.env.BQ_DATASET || 'escalation';
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  // Same service account as the Sheets access, with the bigquery scope added. It needs the
  // BigQuery Data Editor and BigQuery Job User roles on BQ_PROJECT_ID.
  _client = new JWT({
    email,
    key,
    scopes: [
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
  return _client;
}

let _authHeader = async () => {
  const { token } = await getClient().getAccessToken();
  return { Authorization: `Bearer ${token}` };
};
// Test seam: the self-check stubs fetch, but minting a real JWT would still need a real key.
function _setAuthHeaderForTests(fn) { _authHeader = fn; }

// Only STRING scalars and arrays of all-STRING structs are supported, because that is all this
// desk needs - every sheet column is text and every bulk payload is a list of text fields.
// Widening this is a deliberate change, not an oversight.
function strParam(name, value) {
  return {
    name,
    parameterType: { type: 'STRING' },
    parameterValue: { value: value == null ? null : String(value) },
  };
}

function structArrayParam(name, fields, rows) {
  return {
    name,
    parameterType: {
      type: 'ARRAY',
      arrayType: { type: 'STRUCT', structTypes: fields.map((f) => ({ name: f, type: { type: 'STRING' } })) },
    },
    parameterValue: {
      arrayValues: rows.map((r) => ({
        structValues: Object.fromEntries(
          fields.map((f) => [f, { value: r[f] == null ? null : String(r[f]) }])
        ),
      })),
    },
  };
}

// BigQuery returns rows as positional {f: [{v}, ...]} against a separate schema; callers want
// plain objects keyed by column name.
function rowsOf(data) {
  const fields = (data.schema && data.schema.fields) || [];
  return (data.rows || []).map((row) => {
    const obj = {};
    fields.forEach((field, i) => { obj[field.name] = row.f[i] ? row.f[i].v : null; });
    return obj;
  });
}

async function query(sql, params = [], { useQueryCache = true } = {}) {
  const res = await fetch(`${API}/projects/${projectId()}/queries`, {
    method: 'POST',
    headers: { ...(await _authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      useQueryCache,
      parameterMode: 'NAMED',
      queryParameters: params,
      timeoutMs: 60000,
      defaultDataset: { projectId: projectId(), datasetId: datasetId() },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `BigQuery query failed (${res.status})`);
  if (data.errors && data.errors.length) throw new Error(data.errors[0].message);
  return { rows: rowsOf(data), affectedRows: Number(data.numDmlAffectedRows || 0) };
}

async function waitForJob(jobId, location) {
  const qs = location ? `?location=${encodeURIComponent(location)}` : '';
  // 60 attempts at 1s. A tab-sized load finishes in a few seconds; anything past a minute is a
  // real problem the caller should see rather than a hang.
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${API}/projects/${projectId()}/jobs/${encodeURIComponent(jobId)}${qs}`, {
      headers: await _authHeader(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `BigQuery job poll failed (${res.status})`);
    if (data.status && data.status.state === 'DONE') {
      if (data.status.errorResult) throw new Error(data.status.errorResult.message || 'BigQuery load job failed');
      return Number((data.statistics && data.statistics.load && data.statistics.load.outputRows) || 0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`BigQuery job ${jobId} did not finish within 60s`);
}

// ponytail: multipart upload, fine to ~10MB. Both escalation tabs together are 2-4MB of NDJSON
// today. If the sheet grows past that, switch to a resumable upload or stage the file via GCS.
async function loadNdjson(tableId, ndjson, schemaFields) {
  const metadata = {
    configuration: {
      load: {
        destinationTable: { projectId: projectId(), datasetId: datasetId(), tableId },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        schema: { fields: schemaFields },
      },
    },
  };
  const boundary = 'bq-load-boundary';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    '',
    `--${boundary}`,
    'Content-Type: application/octet-stream',
    '',
    ndjson,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const res = await fetch(`${UPLOAD_API}/projects/${projectId()}/jobs?uploadType=multipart`, {
    method: 'POST',
    headers: { ...(await _authHeader()), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `BigQuery load failed (${res.status})`);
  return waitForJob(data.jobReference.jobId, data.jobReference.location);
}

module.exports = {
  query, loadNdjson, strParam, structArrayParam, projectId, datasetId, _setAuthHeaderForTests,
};
```

- [ ] **Step 4: Add the test script to package.json**

In `package.json`, add to `"scripts"`:

```json
"test:escalation": "node scripts/test_escalation_bq.js"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 8 passed

- [ ] **Step 6: Commit**

```bash
git add api/_lib/bigquery.js scripts/test_escalation_bq.js package.json
git commit -m "feat(bq): BigQuery REST transport with load-job ingest"
```

---

### Task 2: Schema and the sync MERGE builder

**Files:**
- Create: `api/_lib/escalationBq.js`
- Modify: `scripts/test_escalation_bq.js` (append a section)

**Interfaces:**
- Consumes: `bigquery.js` (`query`, `loadNdjson`, `strParam`); `escalationSheet.COLUMNS`.
- Produces:
  - `SHEET_OWNED_COLUMNS: string[]`, `APP_OWNED_COLUMNS: string[]`, `IDENTITY_COLUMNS: string[]`
  - `ORDERS_SCHEMA: {name,type,mode?}[]`, `EVENTS_SCHEMA: {name,type,mode?}[]`
  - `rowToBqRow(sheetRow: object) => object`
  - `buildSyncMerge() => string` (SQL with `@tab` placeholder)
  - `CREATE_ORDERS_SQL: string`, `CREATE_EVENTS_SQL: string`, `CREATE_STAGING_SQL: string`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js`, immediately before the `/* ---------- summary ---------- */` block:

```javascript
/* ---------- Task 2: schema and sync MERGE ---------- */

const ebq = require('../api/_lib/escalationBq');

test('column ownership groups do not overlap', () => {
  const app = new Set(ebq.APP_OWNED_COLUMNS);
  ebq.SHEET_OWNED_COLUMNS.forEach((c) => assert.ok(!app.has(c), `${c} is in both groups`));
  ebq.IDENTITY_COLUMNS.forEach((c) => assert.ok(!app.has(c), `${c} is identity and app-owned`));
});

test('rowToBqRow maps a sheet row onto the BigQuery column names', () => {
  const out = ebq.rowToBqRow({
    rowNumber: 42, sheetTab: 'HYPHEN',
    addedDate: '01-Aug-2026', queryClass: 'Delivery', queryCategory: 'Delayed Order',
    parentOrder: 'HYP32557370', awbNumber: ' AWB123 ',
    deliveryPartnerName: 'Delhivery', orderDate: '20-Jul-2026', orderMonth: 'Jul',
    queryDate: '01-Aug-2026', queryMonth: 'Aug', whName: 'BLR',
    totalTimesConsumerReached: '2', deliveredDate: '', statusAsPerAwb: 'RTO',
    solvDate: '', tat: 'Forced to be marked as RTO', updateFromLogistics: 'RTO',
    city: 'EAST DISTRICT', state: 'Sikkim',
    newOrderId: '', awb: '', status: '', notes: '',
    _v1: 'ignored', _v2: 'ignored', ticketNumber: 'TKT-9',
  });
  assert.strictEqual(out.sheet_tab, 'HYPHEN');
  assert.strictEqual(out.parent_order, 'HYP32557370');
  assert.strictEqual(out.awb_number, ' AWB123 ');
  assert.strictEqual(out.awb_key, 'awb123', 'awb_key must be trimmed and lowercased');
  assert.strictEqual(out.row_number, 42);
  assert.strictEqual(out.status_as_per_awb, 'RTO');
  assert.strictEqual(out.ticket_number, 'TKT-9');
  assert.ok(!('_v1' in out) && !('_v2' in out), 'columns X and Y are not carried into BigQuery');
  assert.ok(!('status' in out), 'staging rows carry no app-owned columns');
  assert.ok(!('new_order_id' in out), 'staging rows carry no app-owned columns');
});

test('rowToBqRow defaults a blank AWB to an empty key rather than null', () => {
  const out = ebq.rowToBqRow({ sheetTab: 'mCaffeine', parentOrder: 'MC1', awbNumber: '', rowNumber: 5 });
  assert.strictEqual(out.awb_key, '');
});

test('the sync MERGE never writes an app-owned column', () => {
  const sql = ebq.buildSyncMerge();
  ebq.APP_OWNED_COLUMNS.forEach((c) => {
    assert.ok(
      !new RegExp(`\\b${c}\\b`).test(sql),
      `sync MERGE must not mention app-owned column "${c}" — a sync would wipe agent work`
    );
  });
});

test('the sync MERGE writes every sheet-owned column', () => {
  const sql = ebq.buildSyncMerge();
  ebq.SHEET_OWNED_COLUMNS.forEach((c) => {
    assert.ok(new RegExp(`\\b${c}\\b`).test(sql), `sync MERGE is missing sheet-owned column "${c}"`);
  });
});

test('the sync MERGE keys on awb_key, not row_number', () => {
  const sql = ebq.buildSyncMerge();
  assert.match(sql, /ON\s+T\.sheet_tab\s*=\s*S\.sheet_tab/);
  assert.match(sql, /AND\s+T\.parent_order\s*=\s*S\.parent_order/);
  assert.match(sql, /AND\s+T\.awb_key\s*=\s*S\.awb_key/);
  assert.ok(!/ON[\s\S]*?T\.row_number\s*=\s*S\.row_number/.test(sql), 'row_number must not be part of the key');
});

test('the sync MERGE deduplicates the staging source', () => {
  const sql = ebq.buildSyncMerge();
  assert.match(sql, /QUALIFY\s+ROW_NUMBER\(\)\s+OVER\s*\(/);
  assert.match(sql, /PARTITION BY sheet_tab, parent_order, awb_key ORDER BY row_number/);
});

test('the NOT MATCHED BY SOURCE arm is scoped to the tab being synced', () => {
  const sql = ebq.buildSyncMerge();
  const arm = sql.slice(sql.indexOf('WHEN NOT MATCHED BY SOURCE'));
  assert.match(arm, /T\.sheet_tab\s*=\s*@tab/, 'without this guard, syncing one tab soft-deletes the other');
  assert.match(arm, /deleted_from_sheet_at\s*=\s*CURRENT_TIMESTAMP\(\)/);
  assert.ok(!/\bDELETE\b/.test(arm), 'rows are soft-deleted, never hard-deleted');
});

test('a returning row clears its soft-delete stamp', () => {
  assert.match(ebq.buildSyncMerge(), /deleted_from_sheet_at\s*=\s*NULL/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — `Cannot find module '../api/_lib/escalationBq'`

- [ ] **Step 3: Write minimal implementation**

Create `api/_lib/escalationBq.js`:

```javascript
// The Escalation desk's data layer, on BigQuery. Replaces both the sheet write paths in
// api/_lib/escalationSheet.js and the escalation_* functions in api/_lib/db.js.
//
// THE ONE INVARIANT: sheet-owned columns and app-owned columns never mix. The sync MERGE writes
// sheet-owned columns and does not name an app-owned one; application writes touch app-owned
// columns and do not name a sheet-owned one. That separation is what lets a sync run while
// agents are resolving orders, and scripts/test_escalation_bq.js asserts it on every build.
//
// KEYED ON (sheet_tab, parent_order, awb_key), NOT row_number. The old sheet write path targeted
// `{tab}!T{rowNumber}:W{rowNumber}`, which is only correct while nobody sorts, inserts, or
// deletes a sheet row - one sort reattached every pending resolution to the wrong order.
const bq = require('./bigquery');

const ORDERS = 'orders';
const STAGING = 'orders_staging';
const EVENTS = 'assignment_events';

const IDENTITY_COLUMNS = ['sheet_tab', 'parent_order', 'awb_number', 'awb_key'];

// Sheet columns A-S plus Z, minus the two identity columns. Columns X and Y (carried as _v1/_v2
// in escalationSheet.COLUMNS) are unused by the app and are not brought across.
const SHEET_OWNED_COLUMNS = [
  'added_date', 'query_class', 'query_category', 'delivery_partner_name', 'order_date',
  'order_month', 'query_date', 'query_month', 'wh_name', 'total_times_consumer_reached',
  'delivered_date', 'status_as_per_awb', 'solv_date', 'tat', 'update_from_logistics',
  'city', 'state', 'ticket_number', 'row_number',
];

// What the sheet used to hold in columns T-W, plus the assignment state that used to live in
// Postgres. Only application writes touch these.
const APP_OWNED_COLUMNS = [
  'new_order_id', 'new_awb', 'status', 'notes',
  'resolved_at', 'resolved_by', 'assigned_to', 'assigned_at',
];

// escalationSheet.COLUMNS key -> BigQuery column. Anything absent here is intentionally dropped.
const SHEET_KEY_TO_COLUMN = {
  addedDate: 'added_date',
  queryClass: 'query_class',
  queryCategory: 'query_category',
  deliveryPartnerName: 'delivery_partner_name',
  orderDate: 'order_date',
  orderMonth: 'order_month',
  queryDate: 'query_date',
  queryMonth: 'query_month',
  whName: 'wh_name',
  totalTimesConsumerReached: 'total_times_consumer_reached',
  deliveredDate: 'delivered_date',
  statusAsPerAwb: 'status_as_per_awb',
  solvDate: 'solv_date',
  tat: 'tat',
  updateFromLogistics: 'update_from_logistics',
  city: 'city',
  state: 'state',
  ticketNumber: 'ticket_number',
};

const ORDERS_SCHEMA = [
  { name: 'sheet_tab', type: 'STRING', mode: 'REQUIRED' },
  { name: 'parent_order', type: 'STRING', mode: 'REQUIRED' },
  { name: 'awb_number', type: 'STRING' },
  { name: 'awb_key', type: 'STRING', mode: 'REQUIRED' },
  ...SHEET_OWNED_COLUMNS.map((name) => ({ name, type: name === 'row_number' ? 'INT64' : 'STRING' })),
  { name: 'new_order_id', type: 'STRING' },
  { name: 'new_awb', type: 'STRING' },
  { name: 'status', type: 'STRING' },
  { name: 'notes', type: 'STRING' },
  { name: 'resolved_at', type: 'TIMESTAMP' },
  { name: 'resolved_by', type: 'STRING' },
  { name: 'assigned_to', type: 'STRING' },
  { name: 'assigned_at', type: 'TIMESTAMP' },
  { name: 'synced_at', type: 'TIMESTAMP' },
  { name: 'deleted_from_sheet_at', type: 'TIMESTAMP' },
];

// Staging holds only what the sheet supplies - it is never the target of an application write.
const STAGING_SCHEMA = ORDERS_SCHEMA.filter(
  (f) => !APP_OWNED_COLUMNS.includes(f.name) && f.name !== 'synced_at' && f.name !== 'deleted_from_sheet_at'
);

const EVENTS_SCHEMA = [
  { name: 'parent_order', type: 'STRING', mode: 'REQUIRED' },
  { name: 'sheet_tab', type: 'STRING' },
  { name: 'awb_key', type: 'STRING' },
  { name: 'email', type: 'STRING' },
  { name: 'event', type: 'STRING', mode: 'REQUIRED' },
  { name: 'resolution', type: 'STRING' },
  { name: 'agent_remarks', type: 'STRING' },
  { name: 'ts', type: 'TIMESTAMP', mode: 'REQUIRED' },
];

function ddl(table, schema, extra = '') {
  const cols = schema
    .map((f) => `  ${f.name} ${f.type}${f.mode === 'REQUIRED' ? ' NOT NULL' : ''}`)
    .join(',\n');
  return `CREATE TABLE IF NOT EXISTS \`${table}\` (\n${cols}\n)${extra};`;
}

// Not partitioned: a few thousand rows, where partition metadata costs more than it saves.
// Clustered on the merge key prefix so the sync MERGE and per-order writes prune.
const CREATE_ORDERS_SQL = ddl(ORDERS, ORDERS_SCHEMA, '\nCLUSTER BY sheet_tab, parent_order');
const CREATE_STAGING_SQL = ddl(STAGING, STAGING_SCHEMA);
const CREATE_EVENTS_SQL = ddl(EVENTS, EVENTS_SCHEMA, '\nCLUSTER BY parent_order');

function rowToBqRow(o) {
  const awb = String(o.awbNumber == null ? '' : o.awbNumber);
  const out = {
    sheet_tab: o.sheetTab,
    parent_order: String(o.parentOrder == null ? '' : o.parentOrder),
    awb_number: awb,
    awb_key: awb.trim().toLowerCase(),
    row_number: o.rowNumber,
  };
  Object.entries(SHEET_KEY_TO_COLUMN).forEach(([sheetKey, column]) => {
    out[column] = o[sheetKey] == null ? '' : String(o[sheetKey]);
  });
  return out;
}

// Sheet-owned columns only. scripts/test_escalation_bq.js fails the build if an app-owned column
// ever appears in here.
function buildSyncMerge() {
  const setSheetCols = SHEET_OWNED_COLUMNS.map((c) => `    ${c} = S.${c}`).join(',\n');
  const insertCols = [...IDENTITY_COLUMNS, ...SHEET_OWNED_COLUMNS];
  return `MERGE \`${ORDERS}\` T
USING (
  SELECT * FROM \`${STAGING}\`
  WHERE sheet_tab = @tab
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY sheet_tab, parent_order, awb_key ORDER BY row_number
  ) = 1
) S
ON  T.sheet_tab    = S.sheet_tab
AND T.parent_order = S.parent_order
AND T.awb_key      = S.awb_key
WHEN MATCHED THEN UPDATE SET
${setSheetCols},
    awb_number = S.awb_number,
    synced_at = CURRENT_TIMESTAMP(),
    deleted_from_sheet_at = NULL
WHEN NOT MATCHED BY TARGET THEN
  INSERT (${insertCols.join(', ')}, synced_at)
  VALUES (${insertCols.map((c) => `S.${c}`).join(', ')}, CURRENT_TIMESTAMP())
WHEN NOT MATCHED BY SOURCE
  AND T.sheet_tab = @tab
  AND T.deleted_from_sheet_at IS NULL
THEN UPDATE SET deleted_from_sheet_at = CURRENT_TIMESTAMP()`;
}

module.exports = {
  ORDERS, STAGING, EVENTS,
  IDENTITY_COLUMNS, SHEET_OWNED_COLUMNS, APP_OWNED_COLUMNS,
  ORDERS_SCHEMA, STAGING_SCHEMA, EVENTS_SCHEMA,
  CREATE_ORDERS_SQL, CREATE_STAGING_SQL, CREATE_EVENTS_SQL,
  rowToBqRow, buildSyncMerge,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 17 passed

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js scripts/test_escalation_bq.js
git commit -m "feat(bq): escalation table schema and sync MERGE builder"
```

---

### Task 3: Sync path — load and merge one tab

**Files:**
- Modify: `api/_lib/escalationBq.js` (add `ensureTables`, `syncTab`)
- Modify: `scripts/test_escalation_bq.js` (append a section)

**Interfaces:**
- Consumes: `escalationSheet.readTabRows`, `bigquery.loadNdjson`, `bigquery.query`, `buildSyncMerge`.
- Produces:
  - `SHEET_TABS: string[]`
  - `ensureTables() => Promise<void>`
  - `syncTab(tab: string) => Promise<{tab, read: number, loaded: number, duplicates: number}>`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 3: sync ---------- */

testAsync('syncTab rejects a tab outside the allowlist', async () => {
  await assert.rejects(ebq.syncTab('Sheet1'), /Unknown escalation tab/);
  await assert.rejects(ebq.syncTab('../HYPHEN'), /Unknown escalation tab/);
});

testAsync('syncTab loads NDJSON then merges, and reports duplicates dropped', async () => {
  // Two rows share (tab, parent, awb_key); BigQuery would reject the MERGE without the dedupe,
  // so syncTab must count and report the collision.
  const sheetRows = [
    { rowNumber: 2, sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1', statusAsPerAwb: 'RTO' },
    { rowNumber: 3, sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: ' awb1 ', statusAsPerAwb: 'RTO' },
    { rowNumber: 4, sheetTab: 'HYPHEN', parentOrder: 'HYP2', awbNumber: 'AWB2', statusAsPerAwb: 'RTO' },
  ];
  ebq._setReadTabRowsForTests(async () => sheetRows);

  const calls = stubFetch([
    { body: { jobReference: { jobId: 'load-1', location: 'US' } } },      // load job submit
    { body: { status: { state: 'DONE' }, statistics: { load: { outputRows: '3' } } } }, // poll
    { body: { jobComplete: true, numDmlAffectedRows: '2' } },             // MERGE
  ]);

  const out = await ebq.syncTab('HYPHEN');
  assert.strictEqual(out.tab, 'HYPHEN');
  assert.strictEqual(out.read, 3);
  assert.strictEqual(out.loaded, 3);
  assert.strictEqual(out.duplicates, 1, 'the two AWB1 rows collapse to one key');

  const ndjson = calls[0].init.body;
  assert.match(ndjson, /"awb_key":"awb1"/, 'awb_key is normalised before upload');
  assert.strictEqual((ndjson.match(/"parent_order":"HYP1"/g) || []).length, 2, 'both rows are uploaded; dedupe happens in SQL');

  const merge = JSON.parse(calls[2].init.body);
  assert.match(merge.query, /^MERGE/);
  assert.deepStrictEqual(merge.queryParameters, [
    { name: 'tab', parameterType: { type: 'STRING' }, parameterValue: { value: 'HYPHEN' } },
  ]);

  ebq._setReadTabRowsForTests(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — `ebq.syncTab is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `api/_lib/escalationBq.js`, above `module.exports`:

```javascript
const escalationSheet = require('./escalationSheet');

// Same tabs, same env override, as escalationSheet - they must not drift apart while the sheet
// is still the ingest surface.
const SHEET_TABS = (process.env.ESCALATION_SHEET_TABS || 'HYPHEN,mCaffeine')
  .split(',').map((t) => t.trim()).filter(Boolean);

let _readTabRows = null;
function _setReadTabRowsForTests(fn) { _readTabRows = fn; }
function readTabRows(tab) {
  return (_readTabRows || escalationSheet.readTabRows)(tab);
}

let _tablesReady = false;
async function ensureTables() {
  if (_tablesReady) return;
  await bq.query([CREATE_ORDERS_SQL, CREATE_STAGING_SQL, CREATE_EVENTS_SQL].join('\n'), [], { useQueryCache: false });
  _tablesReady = true;
}

// Counts rows the MERGE's QUALIFY will discard, so a sheet developing genuine key collisions is
// visible in the sync response instead of silently losing rows.
function countDuplicateKeys(bqRows) {
  const seen = new Set();
  let dupes = 0;
  bqRows.forEach((r) => {
    const key = `${r.sheet_tab} ${r.parent_order} ${r.awb_key}`;
    if (seen.has(key)) dupes++; else seen.add(key);
  });
  return dupes;
}

async function syncTab(tab) {
  if (!SHEET_TABS.includes(tab)) throw new Error(`Unknown escalation tab: ${tab}`);
  await ensureTables();

  const sheetRows = await readTabRows(tab);
  const bqRows = sheetRows.map(rowToBqRow);
  const duplicates = countDuplicateKeys(bqRows);

  // WRITE_TRUNCATE on staging, so a retried sync is always safe: staging never accumulates.
  const ndjson = bqRows.map((r) => JSON.stringify(r)).join('\n') + (bqRows.length ? '\n' : '');
  const loaded = await bq.loadNdjson(STAGING, ndjson, STAGING_SCHEMA);

  await bq.query(buildSyncMerge(), [bq.strParam('tab', tab)], { useQueryCache: false });

  return { tab, read: sheetRows.length, loaded, duplicates };
}
```

Add `SHEET_TABS`, `ensureTables`, `syncTab`, `_setReadTabRowsForTests` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 19 passed

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js scripts/test_escalation_bq.js
git commit -m "feat(bq): sync a sheet tab into BigQuery via load job and MERGE"
```

---

### Task 4: Read path

**Files:**
- Modify: `api/_lib/escalationBq.js`
- Modify: `scripts/test_escalation_bq.js`

**Interfaces:**
- Produces (all drop-in replacements returning the same shapes the handler already sends):
  - `getEligibleOrders() => Promise<object[]>`
  - `getFreshLeads() => Promise<object[]>`
  - `getLiveEscalationAssignments() => Promise<{parentOrder, email}[]>`
  - `getEscalationAssignments() => Promise<{parentOrder, email, assignedAt, reassignedAwayAt, resolvedAt, resolution, agentRemarks}[]>`
  - `buildQueueQuery(view: 'queue'|'freshLeads') => string`

Order objects must keep the camelCase keys the client renders: `rowNumber`, `sheetTab`, `parentOrder`, `awbNumber`, `queryCategory`, `statusAsPerAwb`, `updateFromLogistics`, `deliveryPartnerName`, `city`, `state`, `ticketNumber`, `tat`, `addedDate`, `queryClass`, `orderDate`, `orderMonth`, `queryDate`, `queryMonth`, `whName`, `totalTimesConsumerReached`, `deliveredDate`, `solvDate`, `newOrderId`, `awb`, `status`, `notes`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 4: reads ---------- */

test('the queue predicate matches the old JS filter, including the forced-RTO TAT case', () => {
  const sql = ebq.buildQueueQuery('queue');
  assert.match(sql, /LOWER\(status_as_per_awb\)\s+LIKE\s+'%rto%'/);
  assert.match(sql, /LOWER\(update_from_logistics\)\s+LIKE\s+'%rto%'/);
  assert.match(sql, /COALESCE\(status,\s*''\)\s*=\s*''/);
  assert.match(sql, /deleted_from_sheet_at IS NULL/);
  // The queue is deliberately NOT filtered on tat: every pending RTO row carries
  // "Forced to be marked as RTO" there, so gating on the open-TAT values empties the queue.
  assert.ok(!/\btat\b/.test(sql.slice(sql.indexOf('WHERE'))), 'queue must not filter on tat');
});

test('the fresh-leads predicate filters on tat alone', () => {
  const sql = ebq.buildQueueQuery('freshLeads');
  assert.match(sql, /LOWER\(TRIM\(COALESCE\(tat,\s*''\)\)\)\s+IN\s+\('',\s*'unresolved',\s*'#n\/a'\)/);
  assert.match(sql, /deleted_from_sheet_at IS NULL/);
  const where = sql.slice(sql.indexOf('WHERE'));
  assert.ok(!/status_as_per_awb/.test(where), 'fresh leads ignore the RTO columns');
  assert.ok(!/COALESCE\(status,/.test(where), 'fresh leads ignore resolution status');
});

testAsync('getEligibleOrders returns camelCase order objects the client already renders', async () => {
  stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [
      { name: 'row_number' }, { name: 'sheet_tab' }, { name: 'parent_order' },
      { name: 'awb_number' }, { name: 'status_as_per_awb' }, { name: 'query_category' },
      { name: 'city' }, { name: 'state' }, { name: 'ticket_number' },
    ] },
    rows: [{ f: [
      { v: '2' }, { v: 'HYPHEN' }, { v: 'HYP32557370' }, { v: 'AWB1' },
      { v: 'RTO' }, { v: 'Delayed Order' }, { v: 'EAST DISTRICT' }, { v: 'Sikkim' }, { v: 'TKT-9' },
    ] }],
  } }]);
  const [order] = await ebq.getEligibleOrders();
  assert.strictEqual(order.rowNumber, 2, 'row_number comes back as a number');
  assert.strictEqual(order.sheetTab, 'HYPHEN');
  assert.strictEqual(order.parentOrder, 'HYP32557370');
  assert.strictEqual(order.awbNumber, 'AWB1');
  assert.strictEqual(order.statusAsPerAwb, 'RTO');
  assert.strictEqual(order.queryCategory, 'Delayed Order');
  assert.strictEqual(order.ticketNumber, 'TKT-9');
});

testAsync('getLiveEscalationAssignments reads orders, not the event log', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'parent_order' }, { name: 'assigned_to' }] },
    rows: [{ f: [{ v: 'HYP1' }, { v: 'a@x.com' }] }],
  } }]);
  const live = await ebq.getLiveEscalationAssignments();
  assert.deepStrictEqual(live, [{ parentOrder: 'HYP1', email: 'a@x.com' }]);
  const sql = JSON.parse(calls[0].init.body).query;
  assert.ok(!/assignment_events/.test(sql), 'the live map must not scan the event log');
  assert.match(sql, /assigned_to IS NOT NULL/);
  assert.match(sql, /resolved_at IS NULL/);
});

testAsync('getEscalationAssignments pivots events into assignment cycles', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [
      { name: 'parent_order' }, { name: 'email' }, { name: 'assigned_at' },
      { name: 'reassigned_away_at' }, { name: 'resolved_at' }, { name: 'resolution' },
      { name: 'agent_remarks' },
    ] },
    rows: [{ f: [
      { v: 'HYP1' }, { v: 'a@x.com' }, { v: '2026-08-09T05:00:00Z' },
      { v: null }, { v: '2026-08-09T06:00:00Z' }, { v: 'Delivered' }, { v: 'ok' },
    ] }],
  } }]);
  const [row] = await ebq.getEscalationAssignments();
  assert.deepStrictEqual(row, {
    parentOrder: 'HYP1', email: 'a@x.com', assignedAt: '2026-08-09T05:00:00Z',
    reassignedAwayAt: null, resolvedAt: '2026-08-09T06:00:00Z',
    resolution: 'Delivered', agentRemarks: 'ok',
  });
  assert.match(JSON.parse(calls[0].init.body).query, /LIMIT 5000/, 'same soft ceiling as the Postgres version');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — `ebq.buildQueueQuery is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `api/_lib/escalationBq.js` above `module.exports`:

```javascript
// BigQuery column -> the camelCase key the client renders. The inverse of SHEET_KEY_TO_COLUMN,
// plus the app-owned columns, so a queue row round-trips to exactly the shape
// escalationSheet.rowToObject used to return.
const COLUMN_TO_ORDER_KEY = {
  row_number: 'rowNumber', sheet_tab: 'sheetTab', parent_order: 'parentOrder',
  awb_number: 'awbNumber', added_date: 'addedDate', query_class: 'queryClass',
  query_category: 'queryCategory', delivery_partner_name: 'deliveryPartnerName',
  order_date: 'orderDate', order_month: 'orderMonth', query_date: 'queryDate',
  query_month: 'queryMonth', wh_name: 'whName',
  total_times_consumer_reached: 'totalTimesConsumerReached',
  delivered_date: 'deliveredDate', status_as_per_awb: 'statusAsPerAwb',
  solv_date: 'solvDate', tat: 'tat', update_from_logistics: 'updateFromLogistics',
  city: 'city', state: 'state', ticket_number: 'ticketNumber',
  new_order_id: 'newOrderId', new_awb: 'awb', status: 'status', notes: 'notes',
};

const ORDER_SELECT_COLUMNS = Object.keys(COLUMN_TO_ORDER_KEY);

function bqRowToOrder(r) {
  const out = {};
  Object.entries(COLUMN_TO_ORDER_KEY).forEach(([column, key]) => {
    out[key] = r[column] == null ? '' : r[column];
  });
  out.rowNumber = r.row_number == null ? null : Number(r.row_number);
  return out;
}

// The queue: RTO per BOTH the courier (status_as_per_awb) and logistics (update_from_logistics),
// and not yet actioned. Deliberately NOT filtered on tat - every currently-pending RTO row
// carries "Forced to be marked as RTO" there, so gating on the open-TAT values empties the queue.
// That rule belongs to fresh leads, which has no RTO requirement at all.
const QUEUE_WHERE = `LOWER(status_as_per_awb) LIKE '%rto%'
    AND LOWER(update_from_logistics) LIKE '%rto%'
    AND COALESCE(status, '') = ''
    AND deleted_from_sheet_at IS NULL`;

// Fresh leads: tat hasn't landed in a computed bucket yet. Irrespective of status or the RTO
// columns - an already-actioned row still counts if its tat is still open.
const FRESH_LEADS_WHERE = `LOWER(TRIM(COALESCE(tat, ''))) IN ('', 'unresolved', '#n/a')
    AND deleted_from_sheet_at IS NULL`;

function buildQueueQuery(view) {
  return `SELECT ${ORDER_SELECT_COLUMNS.join(', ')}
  FROM \`${ORDERS}\`
  WHERE ${view === 'freshLeads' ? FRESH_LEADS_WHERE : QUEUE_WHERE}`;
}

async function getEligibleOrders() {
  await ensureTables();
  const { rows } = await bq.query(buildQueueQuery('queue'));
  return rows.map(bqRowToOrder);
}

async function getFreshLeads() {
  await ensureTables();
  const { rows } = await bq.query(buildQueueQuery('freshLeads'));
  return rows.map(bqRowToOrder);
}

// Cheap: reads the orders table's own assignment columns rather than scanning the event log.
async function getLiveEscalationAssignments() {
  await ensureTables();
  const { rows } = await bq.query(`SELECT parent_order, assigned_to
  FROM \`${ORDERS}\`
  WHERE assigned_to IS NOT NULL AND resolved_at IS NULL`);
  return rows.map((r) => ({ parentOrder: r.parent_order, email: r.assigned_to }));
}

// Rebuilds the Postgres table's cycle shape from the event log: one row per assignment cycle,
// carrying the timestamps of the events that closed it. No date filtering on purpose - "assigned
// this week" and "resolved this week" are different questions about different timestamps, and a
// single WHERE would miscount whichever metric doesn't share it. AssignmentsPanel scopes each
// metric client-side. LIMIT is the same soft ceiling the Postgres version carried.
async function getEscalationAssignments() {
  await ensureTables();
  const { rows } = await bq.query(`WITH cycles AS (
    SELECT
      parent_order,
      email,
      ts AS assigned_at,
      LEAD(ts) OVER (PARTITION BY parent_order ORDER BY ts) AS next_ts
    FROM \`${EVENTS}\`
    WHERE event = 'assigned'
  )
  SELECT
    c.parent_order,
    c.email,
    c.assigned_at,
    (SELECT MIN(e.ts) FROM \`${EVENTS}\` e
      WHERE e.parent_order = c.parent_order
        AND e.event IN ('reassigned_away', 'unassigned')
        AND e.ts > c.assigned_at
        AND (c.next_ts IS NULL OR e.ts < c.next_ts)) AS reassigned_away_at,
    (SELECT MIN(e.ts) FROM \`${EVENTS}\` e
      WHERE e.parent_order = c.parent_order AND e.event = 'resolved'
        AND e.ts > c.assigned_at
        AND (c.next_ts IS NULL OR e.ts < c.next_ts)) AS resolved_at,
    (SELECT ARRAY_AGG(e.resolution ORDER BY e.ts LIMIT 1)[SAFE_OFFSET(0)] FROM \`${EVENTS}\` e
      WHERE e.parent_order = c.parent_order AND e.event = 'resolved'
        AND e.ts > c.assigned_at
        AND (c.next_ts IS NULL OR e.ts < c.next_ts)) AS resolution,
    (SELECT ARRAY_AGG(e.agent_remarks ORDER BY e.ts LIMIT 1)[SAFE_OFFSET(0)] FROM \`${EVENTS}\` e
      WHERE e.parent_order = c.parent_order AND e.event = 'resolved'
        AND e.ts > c.assigned_at
        AND (c.next_ts IS NULL OR e.ts < c.next_ts)) AS agent_remarks
  FROM cycles c
  ORDER BY c.assigned_at DESC
  LIMIT 5000`);
  return rows.map((r) => ({
    parentOrder: r.parent_order,
    email: r.email,
    assignedAt: r.assigned_at,
    reassignedAwayAt: r.reassigned_away_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    agentRemarks: r.agent_remarks,
  }));
}
```

Add `buildQueueQuery`, `getEligibleOrders`, `getFreshLeads`, `getLiveEscalationAssignments`, `getEscalationAssignments` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 24 passed

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js scripts/test_escalation_bq.js
git commit -m "feat(bq): escalation read path on BigQuery"
```

---

### Task 5: Write path

**Files:**
- Modify: `api/_lib/escalationBq.js`
- Modify: `scripts/test_escalation_bq.js`

**Interfaces:**
- Produces:
  - `updateOrder(key: {sheetTab, parentOrder, awbNumber}, fields: {newOrderId, newAwb, newStatus, notes, resolvedBy}) => Promise<number>`
  - `batchUpdateOrders(items: {sheetTab, parentOrder, awbNumber, newOrderId, newAwb, newStatus, notes, resolvedBy}[]) => Promise<number>`
  - `assignEscalationOrder(key, email) => Promise<void>`
  - `unassignEscalationOrder(key) => Promise<void>`
  - `assignEscalationOrdersBulk(items: {sheetTab, parentOrder, awbNumber, agentId}[]) => Promise<number>`
  - `buildBulkUpdateMerge() => string`, `buildBulkAssignMerge() => string`

`key` is always `{sheetTab, parentOrder, awbNumber}`; `awbKey` is derived internally as `String(awbNumber || '').trim().toLowerCase()`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 5: writes ---------- */

test('write MERGEs never name a sheet-owned column', () => {
  [ebq.buildBulkUpdateMerge(), ebq.buildBulkAssignMerge()].forEach((sql) => {
    ebq.SHEET_OWNED_COLUMNS.forEach((c) => {
      if (c === 'row_number') return; // not written, and not in these statements either
      assert.ok(!new RegExp(`\\b${c}\\b`).test(sql), `write MERGE must not touch sheet-owned "${c}"`);
    });
  });
});

testAsync('updateOrder issues one UPDATE keyed on tab+parent+awb_key, plus one event', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '1' } }, // UPDATE
    { body: { jobComplete: true, numDmlAffectedRows: '1' } }, // event INSERT
  ]);
  const affected = await ebq.updateOrder(
    { sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: ' AWB1 ' },
    { newOrderId: 'HYP2', newAwb: 'AWB9', newStatus: 'Reshipped', notes: 'done', resolvedBy: 'a@x.com' }
  );
  assert.strictEqual(affected, 1);
  const update = JSON.parse(calls[0].init.body);
  assert.match(update.query, /^UPDATE/);
  assert.match(update.query, /awb_key\s*=\s*@awb_key/);
  const awbKey = update.queryParameters.find((p) => p.name === 'awb_key');
  assert.strictEqual(awbKey.parameterValue.value, 'awb1', 'awb_key is normalised on the write side too');
  assert.match(update.query, /resolved_at\s*=\s*CURRENT_TIMESTAMP\(\)/);
  const event = JSON.parse(calls[1].init.body);
  assert.match(event.query, /INSERT INTO `assignment_events`/);
  assert.strictEqual(event.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'resolved');
});

testAsync('batchUpdateOrders compiles N items into ONE statement', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '3' } }, // MERGE
    { body: { jobComplete: true, numDmlAffectedRows: '3' } }, // batched events
  ]);
  const items = ['HYP1', 'HYP2', 'HYP3'].map((p) => ({
    sheetTab: 'HYPHEN', parentOrder: p, awbNumber: `awb-${p}`,
    newOrderId: '-', newAwb: '-', newStatus: 'Delivered', notes: '', resolvedBy: 'a@x.com',
  }));
  const updated = await ebq.batchUpdateOrders(items);
  assert.strictEqual(updated, 3);
  assert.strictEqual(calls.length, 2, 'exactly one MERGE and one event insert, never one per item');
  const merge = JSON.parse(calls[0].init.body);
  assert.match(merge.query, /UNNEST\(@items\)/);
  assert.strictEqual(merge.queryParameters[0].parameterValue.arrayValues.length, 3);
});

testAsync('batchUpdateOrders with an empty list makes no BigQuery calls', async () => {
  const calls = stubFetch([]);
  assert.strictEqual(await ebq.batchUpdateOrders([]), 0);
  assert.strictEqual(calls.length, 0);
});

testAsync('assignEscalationOrdersBulk compiles N assignments into ONE statement', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '4048' } },
    { body: { jobComplete: true, numDmlAffectedRows: '4048' } },
  ]);
  const items = Array.from({ length: 4048 }, (_, i) => ({
    sheetTab: 'HYPHEN', parentOrder: `HYP${i}`, awbNumber: `AWB${i}`, agentId: 'a@x.com',
  }));
  assert.strictEqual(await ebq.assignEscalationOrdersBulk(items), 4048);
  assert.strictEqual(calls.length, 2, '4048 rows must not become 4048 DML statements');
});

testAsync('reassignment closes the previous cycle before opening the new one', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, schema: { fields: [{ name: 'assigned_to' }] }, rows: [{ f: [{ v: 'old@x.com' }] }] } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } }, // reassigned_away event
    { body: { jobComplete: true, numDmlAffectedRows: '1' } }, // UPDATE orders
    { body: { jobComplete: true, numDmlAffectedRows: '1' } }, // assigned event
  ]);
  await ebq.assignEscalationOrder({ sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' }, 'new@x.com');
  const away = JSON.parse(calls[1].init.body);
  assert.strictEqual(away.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'reassigned_away');
  assert.strictEqual(away.queryParameters.find((p) => p.name === 'email').parameterValue.value, 'old@x.com');
  const assigned = JSON.parse(calls[3].init.body);
  assert.strictEqual(assigned.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'assigned');
});

testAsync('re-assigning to the same agent writes no reassigned_away event', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, schema: { fields: [{ name: 'assigned_to' }] }, rows: [{ f: [{ v: 'same@x.com' }] }] } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } }, // UPDATE orders
    { body: { jobComplete: true, numDmlAffectedRows: '1' } }, // assigned event
  ]);
  await ebq.assignEscalationOrder({ sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' }, 'same@x.com');
  const events = calls.map((c) => JSON.parse(c.init.body).query).filter((q) => /INSERT INTO/.test(q));
  assert.strictEqual(events.length, 1, 'only the assigned event');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — `ebq.buildBulkUpdateMerge is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `api/_lib/escalationBq.js` above `module.exports`:

```javascript
function awbKeyOf(awbNumber) {
  return String(awbNumber == null ? '' : awbNumber).trim().toLowerCase();
}

function keyParams({ sheetTab, parentOrder, awbNumber }) {
  return [
    bq.strParam('sheet_tab', sheetTab),
    bq.strParam('parent_order', parentOrder),
    bq.strParam('awb_key', awbKeyOf(awbNumber)),
  ];
}

const KEY_WHERE = 'sheet_tab = @sheet_tab AND parent_order = @parent_order AND awb_key = @awb_key';

// One row per agent action. Append-only: this is the history AssignmentsPanel reads, and the
// reason a current-state-only orders table isn't enough on its own.
async function insertEvent({ sheetTab, parentOrder, awbNumber }, event, { email = null, resolution = null, agentRemarks = null } = {}) {
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, sheet_tab, awb_key, email, event, resolution, agent_remarks, ts)
     VALUES (@parent_order, @sheet_tab, @awb_key, @email, @event, @resolution, @agent_remarks, CURRENT_TIMESTAMP())`,
    [
      ...keyParams({ sheetTab, parentOrder, awbNumber }),
      bq.strParam('email', email),
      bq.strParam('event', event),
      bq.strParam('resolution', resolution),
      bq.strParam('agent_remarks', agentRemarks),
    ],
    { useQueryCache: false }
  );
}

const BULK_ITEM_FIELDS = ['sheet_tab', 'parent_order', 'awb_key', 'new_order_id', 'new_awb', 'status', 'notes', 'resolved_by'];

function buildBulkUpdateMerge() {
  return `MERGE \`${ORDERS}\` T
USING UNNEST(@items) S
ON  T.sheet_tab = S.sheet_tab AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key
WHEN MATCHED THEN UPDATE SET
  new_order_id = S.new_order_id,
  new_awb = S.new_awb,
  status = S.status,
  notes = S.notes,
  resolved_at = CURRENT_TIMESTAMP(),
  resolved_by = S.resolved_by`;
}

const BULK_ASSIGN_FIELDS = ['sheet_tab', 'parent_order', 'awb_key', 'assigned_to'];

function buildBulkAssignMerge() {
  return `MERGE \`${ORDERS}\` T
USING UNNEST(@items) S
ON  T.sheet_tab = S.sheet_tab AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key
WHEN MATCHED THEN UPDATE SET
  assigned_to = S.assigned_to,
  assigned_at = CURRENT_TIMESTAMP()`;
}

async function updateOrder(key, { newOrderId, newAwb, newStatus, notes = '', resolvedBy = null }) {
  await ensureTables();
  const { affectedRows } = await bq.query(
    `UPDATE \`${ORDERS}\` SET
       new_order_id = @new_order_id,
       new_awb = @new_awb,
       status = @status,
       notes = @notes,
       resolved_at = CURRENT_TIMESTAMP(),
       resolved_by = @resolved_by
     WHERE ${KEY_WHERE}`,
    [
      ...keyParams(key),
      bq.strParam('new_order_id', newOrderId == null ? '-' : newOrderId),
      bq.strParam('new_awb', newAwb == null ? '-' : newAwb),
      bq.strParam('status', newStatus),
      bq.strParam('notes', notes),
      bq.strParam('resolved_by', resolvedBy),
    ],
    { useQueryCache: false }
  );
  await insertEvent(key, 'resolved', { email: resolvedBy, resolution: newStatus, agentRemarks: notes });
  return affectedRows;
}

// One MERGE, never a loop: bulk-update and CSV import can carry thousands of rows, and thousands
// of individual UPDATE statements would exhaust BigQuery's DML queue.
async function batchUpdateOrders(items) {
  if (!items.length) return 0;
  await ensureTables();
  const rows = items.map((i) => ({
    sheet_tab: i.sheetTab,
    parent_order: i.parentOrder,
    awb_key: awbKeyOf(i.awbNumber),
    new_order_id: i.newOrderId == null ? '-' : i.newOrderId,
    new_awb: i.newAwb == null ? '-' : i.newAwb,
    status: i.newStatus,
    notes: i.notes == null ? '' : i.notes,
    resolved_by: i.resolvedBy == null ? '' : i.resolvedBy,
  }));
  const { affectedRows } = await bq.query(
    buildBulkUpdateMerge(),
    [bq.structArrayParam('items', BULK_ITEM_FIELDS, rows)],
    { useQueryCache: false }
  );
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, sheet_tab, awb_key, email, event, resolution, agent_remarks, ts)
     SELECT parent_order, sheet_tab, awb_key, resolved_by, 'resolved', status, notes, CURRENT_TIMESTAMP()
     FROM UNNEST(@items)`,
    [bq.structArrayParam('items', BULK_ITEM_FIELDS, rows)],
    { useQueryCache: false }
  );
  return affectedRows;
}

async function currentAssignee(key) {
  const { rows } = await bq.query(
    `SELECT assigned_to FROM \`${ORDERS}\` WHERE ${KEY_WHERE} AND resolved_at IS NULL`,
    keyParams(key),
    { useQueryCache: false }
  );
  return rows.length ? rows[0].assigned_to : null;
}

// Mirrors the Postgres cycle model: a different agent's live assignment is closed with a
// reassigned_away event before the new one opens, so history is preserved rather than
// overwritten. Re-assigning to the SAME agent closes nothing.
async function assignEscalationOrder(key, email) {
  await ensureTables();
  const previous = await currentAssignee(key);
  if (previous && previous !== email) {
    await insertEvent(key, 'reassigned_away', { email: previous });
  }
  await bq.query(
    `UPDATE \`${ORDERS}\` SET assigned_to = @assigned_to, assigned_at = CURRENT_TIMESTAMP()
     WHERE ${KEY_WHERE}`,
    [...keyParams(key), bq.strParam('assigned_to', email)],
    { useQueryCache: false }
  );
  await insertEvent(key, 'assigned', { email });
}

async function unassignEscalationOrder(key) {
  await ensureTables();
  const previous = await currentAssignee(key);
  await bq.query(
    `UPDATE \`${ORDERS}\` SET assigned_to = NULL, assigned_at = NULL
     WHERE ${KEY_WHERE} AND resolved_at IS NULL`,
    keyParams(key),
    { useQueryCache: false }
  );
  await insertEvent(key, 'unassigned', { email: previous });
}

// Auto-Assign All's write path. The client used to fire one request per unassigned order; against
// BigQuery that is thousands of concurrent DML statements and a guaranteed failure.
async function assignEscalationOrdersBulk(items) {
  if (!items.length) return 0;
  await ensureTables();
  const rows = items.map((i) => ({
    sheet_tab: i.sheetTab,
    parent_order: i.parentOrder,
    awb_key: awbKeyOf(i.awbNumber),
    assigned_to: i.agentId,
  }));
  const { affectedRows } = await bq.query(
    buildBulkAssignMerge(),
    [bq.structArrayParam('items', BULK_ASSIGN_FIELDS, rows)],
    { useQueryCache: false }
  );
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, sheet_tab, awb_key, email, event, resolution, agent_remarks, ts)
     SELECT parent_order, sheet_tab, awb_key, assigned_to, 'assigned', NULL, NULL, CURRENT_TIMESTAMP()
     FROM UNNEST(@items)`,
    [bq.structArrayParam('items', BULK_ASSIGN_FIELDS, rows)],
    { useQueryCache: false }
  );
  return affectedRows;
}
```

Add `updateOrder`, `batchUpdateOrders`, `assignEscalationOrder`, `unassignEscalationOrder`, `assignEscalationOrdersBulk`, `buildBulkUpdateMerge`, `buildBulkAssignMerge`, `awbKeyOf` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 31 passed

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js scripts/test_escalation_bq.js
git commit -m "feat(bq): escalation write path, every bulk action a single MERGE"
```

---

### Task 6: Order lookup for CSV import

**Files:**
- Modify: `api/_lib/escalationBq.js`
- Modify: `scripts/test_escalation_bq.js`

`getSheetIndex()` in `escalationSheet.js` exists only so the CSV import can match a pasted row back to a sheet row. Its BigQuery replacement returns the same two maps, built from `escalation.orders` instead of a full sheet read.

**Interfaces:**
- Produces: `getOrderIndex() => Promise<{byParent: Map<string, key>, byParentAwb: Map<string, key>}>` where `key` is `{sheetTab, parentOrder, awbNumber}`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 6: import lookup ---------- */

testAsync('getOrderIndex builds parent and parent+awb maps from BigQuery', async () => {
  stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'sheet_tab' }, { name: 'parent_order' }, { name: 'awb_number' }, { name: 'awb_key' }] },
    rows: [
      { f: [{ v: 'HYPHEN' }, { v: 'HYP1' }, { v: 'AWB1' }, { v: 'awb1' }] },
      { f: [{ v: 'mCaffeine' }, { v: 'MC1' }, { v: 'AWB2' }, { v: 'awb2' }] },
    ],
  } }]);
  const { byParent, byParentAwb } = await ebq.getOrderIndex();
  assert.deepStrictEqual(byParent.get('hyp1'), { sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' });
  assert.deepStrictEqual(byParentAwb.get('mc1||awb2'), { sheetTab: 'mCaffeine', parentOrder: 'MC1', awbNumber: 'AWB2' });
  assert.strictEqual(byParent.size, 2);
});

testAsync('getOrderIndex keeps the first row on a duplicate parent order', async () => {
  stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'sheet_tab' }, { name: 'parent_order' }, { name: 'awb_number' }, { name: 'awb_key' }] },
    rows: [
      { f: [{ v: 'HYPHEN' }, { v: 'HYP1' }, { v: 'AWB1' }, { v: 'awb1' }] },
      { f: [{ v: 'HYPHEN' }, { v: 'HYP1' }, { v: 'AWB9' }, { v: 'awb9' }] },
    ],
  } }]);
  const { byParent, byParentAwb } = await ebq.getOrderIndex();
  assert.strictEqual(byParent.get('hyp1').awbNumber, 'AWB1');
  assert.strictEqual(byParentAwb.get('hyp1||awb9').awbNumber, 'AWB9', 'the exact key still resolves the second row');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — `ebq.getOrderIndex is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `api/_lib/escalationBq.js` above `module.exports`:

```javascript
// Replaces escalationSheet.getSheetIndex - same two maps, same "prefer an exact parent+AWB match,
// fall back to parent only" contract the CSV import depends on, but read from BigQuery instead of
// re-reading both sheet tabs. Values carry the write key rather than a row number.
async function getOrderIndex() {
  await ensureTables();
  const { rows } = await bq.query(
    `SELECT sheet_tab, parent_order, awb_number, awb_key
     FROM \`${ORDERS}\` WHERE deleted_from_sheet_at IS NULL`
  );
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((r) => {
    const parent = String(r.parent_order || '').trim().toLowerCase();
    if (!parent) return;
    const key = { sheetTab: r.sheet_tab, parentOrder: r.parent_order, awbNumber: r.awb_number || '' };
    if (!byParent.has(parent)) byParent.set(parent, key);
    if (r.awb_key) byParentAwb.set(`${parent}||${r.awb_key}`, key);
  });
  return { byParent, byParentAwb };
}
```

Add `getOrderIndex` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 33 passed

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js scripts/test_escalation_bq.js
git commit -m "feat(bq): order lookup index for CSV import"
```

---

### Task 7: Wire the API handler

**Files:**
- Modify: `api/escalation/[action].js`
- Modify: `api/_lib/escalationSheet.js`
- Modify: `api/_lib/db.js`
- Modify: `scripts/test_escalation_bq.js`

**Interfaces:**
- Consumes: everything `escalationBq` produces.
- Produces: two new actions — `sync` (secret-gated) and `assign-bulk` (session-gated).

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 7: handler wiring ---------- */

const fs = require('fs');
const path = require('path');
const handlerSrc = fs.readFileSync(path.join(__dirname, '../api/escalation/[action].js'), 'utf8');
const sheetSrc = fs.readFileSync(path.join(__dirname, '../api/_lib/escalationSheet.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../api/_lib/db.js'), 'utf8');

test('the handler no longer imports sheet write paths', () => {
  assert.ok(!/updateOrder|batchUpdateOrders|getSheetIndex/.test(
    handlerSrc.slice(0, handlerSrc.indexOf('const CARD_KEY'))
  ), 'sheet write functions must not be imported');
  assert.match(handlerSrc, /require\('\.\.\/_lib\/escalationBq'\)/);
});

test('escalationSheet no longer exports any write path', () => {
  const exportLine = sheetSrc.slice(sheetSrc.lastIndexOf('module.exports'));
  ['updateOrder', 'batchUpdateOrders', 'getSheetIndex'].forEach((fn) => {
    assert.ok(!new RegExp(`\\b${fn}\\b`).test(exportLine), `${fn} must be gone`);
  });
  assert.match(exportLine, /readTabRows/);
  assert.match(exportLine, /COLUMNS/);
});

test('escalationSheet contains no Sheets write call', () => {
  assert.ok(!/values:batchUpdate/.test(sheetSrc), 'the app must not write to the sheet any more');
});

test('db.js no longer exports the escalation functions', () => {
  const exportBlock = dbSrc.slice(dbSrc.lastIndexOf('module.exports'));
  [
    'assignEscalationOrder', 'unassignEscalationOrder', 'resolveEscalationAssignment',
    'resolveEscalationAssignmentsBulk', 'getEscalationAssignments', 'getLiveEscalationAssignments',
  ].forEach((fn) => assert.ok(!new RegExp(`\\b${fn}\\b`).test(exportBlock), `${fn} must be removed from exports`));
});

test('the sync action is gated by the shared secret and a tab allowlist, not a session', () => {
  assert.match(handlerSrc, /ESCALATION_SYNC_SECRET/);
  assert.match(handlerSrc, /timingSafeEqual/, 'secret comparison must be constant-time');
  // The session gate runs after the sync branch, so Apps Script (which has no cookie) can reach it.
  assert.ok(
    handlerSrc.indexOf("action === 'sync'") < handlerSrc.indexOf('const denied = checkAccess(session)'),
    'the sync branch must be handled before the session check'
  );
});

test('assign-bulk exists and is not reachable without a session', () => {
  assert.match(handlerSrc, /action === 'assign-bulk'/);
  assert.ok(
    handlerSrc.indexOf("action === 'assign-bulk'") > handlerSrc.indexOf('const denied = checkAccess(session)'),
    'assign-bulk must sit behind the session gate'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — 6 failures in the Task 7 section

- [ ] **Step 3: Rewrite the handler's imports and gate**

In `api/escalation/[action].js`, replace the import block (lines 15–24) with:

```javascript
const crypto = require('crypto');
const { getSession } = require('../_lib/session');
const {
  getEligibleOrders, getFreshLeads, updateOrder, batchUpdateOrders, getOrderIndex,
  assignEscalationOrder, unassignEscalationOrder, assignEscalationOrdersBulk,
  getEscalationAssignments, getLiveEscalationAssignments, syncTab,
} = require('../_lib/escalationBq');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const { getCallingProcessAgents } = require('../_lib/db');
```

Then insert this immediately after `const body = req.body || {};` and **before** `const session = await getSession(req)`, reordering the handler so the session lookup follows it:

```javascript
  // The sync action is the one route here without a session gate: Apps Script fires it from the
  // escalation workbook and cannot carry a session cookie. It is gated on a shared secret
  // instead, and accepts nothing from the caller but a tab name checked against a fixed
  // allowlist - the endpoint reads the sheet itself, so a leaked secret can at worst trigger a
  // re-read of data the caller cannot see.
  if (action === 'sync') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const expected = process.env.ESCALATION_SYNC_SECRET || '';
    const supplied = String(req.headers['x-sync-secret'] || '');
    const ok = expected.length > 0
      && supplied.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Invalid sync secret' });
    try {
      return res.status(200).json(await syncTab(String(body.tab || '')));
    } catch (e) {
      console.error('api/escalation/sync error:', e);
      return res.status(500).json({ error: e.message || 'Sync failed' });
    }
  }
```

- [ ] **Step 4: Point the remaining actions at BigQuery**

In the same file, apply these replacements inside the session-gated section:

`assign` POST branch:

```javascript
      if (req.method === 'POST') {
        const { sheetTab, parentOrder, awbNumber, agentId } = body;
        if (!sheetTab || !parentOrder) return res.status(400).json({ error: 'sheetTab and parentOrder are required' });
        const key = { sheetTab, parentOrder, awbNumber: awbNumber || '' };
        if (!agentId) await unassignEscalationOrder(key);
        else await assignEscalationOrder(key, agentId);
        return res.status(200).json({ ok: true });
      }
```

New `assign-bulk` branch, placed directly after the `assign` branch:

```javascript
    // Auto-Assign All's endpoint. One MERGE for the whole selection - the client used to fire one
    // request per order, which against BigQuery is thousands of concurrent DML statements.
    if (action === 'assign-bulk') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { items } = body;
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });
      if (items.some((i) => !i.sheetTab || !i.parentOrder || !i.agentId)) {
        return res.status(400).json({ error: 'Every item requires sheetTab, parentOrder and agentId' });
      }
      return res.status(200).json({ ok: true, assigned: await assignEscalationOrdersBulk(items) });
    }
```

`update` branch:

```javascript
    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { sheetTab, parentOrder, awbNumber, newOrderId, newAwb, newStatus, notes } = body;
      if (!sheetTab || !parentOrder || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'sheetTab, parentOrder, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(
        { sheetTab, parentOrder, awbNumber: awbNumber || '' },
        { newOrderId, newAwb, newStatus, notes: notes || '', resolvedBy: session.email }
      );
      return res.status(200).json({ ok: true });
    }
```

`bulk-update` branch — drop the `resolveEscalationAssignmentsBulk` call, since `batchUpdateOrders` now writes the events itself:

```javascript
      const updated = await batchUpdateOrders(
        items.map(({ sheetTab, parentOrder, awbNumber }) => ({
          sheetTab, parentOrder, awbNumber: awbNumber || '',
          newOrderId: '-', newAwb: '-', newStatus: status, notes: '', resolvedBy: session.email,
        }))
      );
      return res.status(200).json({ ok: true, updated });
```

`import` branch — swap `getSheetIndex()` for `getOrderIndex()` and build updates from the returned key. Replace the `updates.push({...})` call and the `seenKey` line with:

```javascript
        const seenKey = `${ref.sheetTab}:${ref.parentOrder}:${ref.awbNumber}`;
        if (seenRows.has(seenKey)) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Duplicate row in file (skipped)' });
        seenRows.add(seenKey);

        updates.push({
          sheetTab: ref.sheetTab,
          parentOrder: ref.parentOrder,
          awbNumber: ref.awbNumber,
          newOrderId: String(row['New Order ID'] ?? '').trim() || '-',
          newAwb: String(row['New AWB / Tracking'] ?? '').trim() || '-',
          newStatus: status,
          notes: String(row.Notes ?? '').trim(),
          resolvedBy: session.email,
        });
```

and change the response's `rowNumbers` field to keep the client's row-key contract:

```javascript
        rowNumbers: updates.map((u) => `${u.sheetTab}:${u.parentOrder}`),
```

- [ ] **Step 5: Strip the write paths from escalationSheet.js**

Delete `updateOrder`, `batchUpdateOrders`, and `getSheetIndex` from `api/_lib/escalationSheet.js`, along with `getEligibleOrders`, `getFreshLeads`, and the `OPEN_TAT_VALUES` constant — the filters now live in `escalationBq.buildQueueQuery`. Change the final line to:

```javascript
module.exports = { readTabRows, readAllRows, COLUMNS };
```

Update the file's header comment to state that it is now read-only ingest for the BigQuery sync, and that the app no longer writes to the sheet.

- [ ] **Step 6: Remove the escalation exports from db.js**

In `api/_lib/db.js`, delete `assignEscalationOrder`, `unassignEscalationOrder`, `resolveEscalationAssignment`, `resolveEscalationAssignmentsBulk`, `getEscalationAssignments`, and `getLiveEscalationAssignments` — both the function definitions and their entries in `module.exports`.

Then **add** `pgSql` to `module.exports` — it is currently an internal helper, and Task 10's migration script needs it to read the Postgres assignment rows:

```javascript
  sql, pgSql, ensureSchema, CARD_KEYS, CARD_LABELS,
```

Leave the `escalation_lead_assignments` table DDL in `bootstrapPgSchema` untouched, with a comment:

```javascript
  // Retained deliberately. Escalation assignments moved to BigQuery in the 2026-08 migration;
  // this table is no longer read or written, and stays only as the rollback path. Drop it in a
  // later cleanup once BigQuery has run clean for a few weeks.
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 39 passed

- [ ] **Step 8: Commit**

```bash
git add api/escalation/[action].js api/_lib/escalationSheet.js api/_lib/db.js scripts/test_escalation_bq.js
git commit -m "feat(bq): point the escalation API at BigQuery, add sync and assign-bulk"
```

---

### Task 8: Client changes

**Files:**
- Modify: `app/escalation/EscalationClient.js`

**Interfaces:**
- Consumes: `/api/escalation/assign` (new payload), `/api/escalation/assign-bulk`, `/api/escalation/update` (new payload), `/api/escalation/bulk-update` (items gain `awbNumber`).

- [ ] **Step 1: Send the new assign payload**

At [line 749](../../../app/escalation/EscalationClient.js#L749), replace the body:

```javascript
        body: JSON.stringify({
          sheetTab: order.sheetTab,
          parentOrder: order.parentOrder,
          awbNumber: order.awbNumber || '',
          agentId: agentId || null,
        }),
```

- [ ] **Step 2: Send the new update payload and fix the toast copy**

At [lines 718-726](../../../app/escalation/EscalationClient.js#L718-L726), replace the body:

```javascript
        body: JSON.stringify({
          sheetTab: order.sheetTab,
          parentOrder: order.parentOrder,
          awbNumber: order.awbNumber || '',
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
```

At [line 731](../../../app/escalation/EscalationClient.js#L731), the toast no longer describes what happens:

```javascript
      onToast('success', `Resolved — ${order.parentOrder || 'row'} saved`);
```

- [ ] **Step 3: Carry awbNumber through bulk update**

At [lines 1198-1201](../../../app/escalation/EscalationClient.js#L1198-L1201), replace the item mapping:

```javascript
    const items = Array.from(selectedRows).map((key) => {
      const o = orders.find((o) => rowKey(o) === key);
      return { sheetTab: o?.sheetTab, parentOrder: o?.parentOrder, awbNumber: o?.awbNumber || '' };
    }).filter((i) => i.sheetTab && i.parentOrder);
```

- [ ] **Step 4: Collapse Auto-Assign All to one request**

Replace the body of `handleAutoAssign` ([lines 1261-1305](../../../app/escalation/EscalationClient.js#L1261-L1305)) with a single call. Both branches differ only in which agent each row gets, so build the item list first and post once:

```javascript
  async function handleAutoAssign() {
    if (!isAdmin && !googleUser?.email) return;

    setAutoAssigning(true);
    try {
      const unassigned = orders.filter((o) => !assignments[rowKey(o)]);
      if (unassigned.length === 0) { showToast('success', 'All orders already assigned!'); return; }
      if (isAdmin && agents.length === 0) { showToast('error', 'No agents available'); return; }

      // One request for the whole queue. This used to be one fetch per order in a Promise.all -
      // fine against Postgres, fatal against BigQuery, where it becomes one DML statement per row.
      const items = unassigned.map((o, i) => ({
        sheetTab: o.sheetTab,
        parentOrder: o.parentOrder,
        awbNumber: o.awbNumber || '',
        agentId: isAdmin ? agents[i % agents.length].email : googleUser.email,
      }));

      const res = await fetch('/api/escalation/assign-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Auto-assign failed');

      const newMap = {};
      unassigned.forEach((o, i) => { newMap[rowKey(o)] = { agentId: items[i].agentId }; });
      setAssignments((p) => ({ ...p, ...newMap }));
      showToast('success', isAdmin
        ? `Auto-assigned ${unassigned.length} orders (round-robin across ${agents.length} agents)`
        : `Auto-assigned ${unassigned.length} orders to you`);
    } catch (err) {
      showToast('error', err.message || 'Auto-assign failed');
    } finally { setAutoAssigning(false); }
  }
```

- [ ] **Step 5: Make single assignment optimistic**

BigQuery writes take 2–5s. Replace `handleAssign` ([lines 741-758](../../../app/escalation/EscalationClient.js#L741-L758)) so the dropdown updates immediately and reverts on failure:

```javascript
  async function handleAssign(e) {
    const agentId = e.target.value;
    const agent = agents.find((a) => a.email === agentId);
    const previous = assignment; // OrderRow already receives this prop — see its signature
    setAssigning(true);
    // Optimistic: BigQuery writes take a couple of seconds, and blocking the dropdown that long
    // reads as a hang. Reverted below if the write fails.
    onAssign(rowKey(order), agentId ? { agentId } : null);
    try {
      const res = await fetch('/api/escalation/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheetTab: order.sheetTab,
          parentOrder: order.parentOrder,
          awbNumber: order.awbNumber || '',
          agentId: agentId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save assignment');
      onToast('success', agentId ? `Assigned to ${agent?.name || agentId}` : 'Assignment cleared');
    } catch (err) {
      onAssign(rowKey(order), previous);
      onToast('error', err.message || 'Failed to save assignment');
    } finally { setAssigning(false); }
  }
```

No new prop is needed: `OrderRow` already destructures `assignment` in its signature at [line 673](../../../app/escalation/EscalationClient.js#L673) and is passed `assignment={assignments[rowKey(o)] || null}` at [line 1693](../../../app/escalation/EscalationClient.js#L1693). That value is the pre-write state to revert to.

- [ ] **Step 6: Verify no lingering rowNumber in request bodies**

Run: `grep -n "rowNumber" app/escalation/EscalationClient.js`
Expected: matches only in `rowKey()`, the `fId` DOM id, and their comments — no `JSON.stringify` body may contain `rowNumber`.

- [ ] **Step 7: Commit**

```bash
git add app/escalation/EscalationClient.js
git commit -m "feat(escalation): key writes on parent+AWB, single-call auto-assign, optimistic writes"
```

---

### Task 9: Apps Script sync trigger

**Files:**
- Create: `scripts/escalation_sync.gs`

- [ ] **Step 1: Write the script**

Create `scripts/escalation_sync.gs`:

```javascript
/**
 * Escalation workbook -> BigQuery sync trigger.
 *
 * This file is the checked-in source of truth for review. It is NOT executed by the repo: paste
 * it into the escalation workbook's Apps Script project (Extensions > Apps Script), set the two
 * script properties below, and install an onChange trigger pointing at onSheetChange.
 *
 * Install the trigger from the Apps Script UI:
 *   Triggers > Add Trigger > onSheetChange > From spreadsheet > On change
 *
 * Script properties to set (Project Settings > Script Properties):
 *   SYNC_ENDPOINT  https://<host>/api/escalation/sync
 *   SYNC_SECRET    same value as the ESCALATION_SYNC_SECRET env var on the API
 *
 * onChange, not onEdit: onChange also fires on row inserts, row deletes, and programmatic
 * writes, all of which change what the queue should show.
 */
var TABS = ['HYPHEN', 'mCaffeine'];
var DEBOUNCE_SECONDS = 30;

function onSheetChange(e) {
  var tab = SpreadsheetApp.getActiveSheet().getName();
  if (TABS.indexOf(tab) === -1) return;

  // Pasting 500 rows fires onChange many times. Without coalescing, each one triggers a full
  // reload of the tab.
  var cache = CacheService.getScriptCache();
  var pendingKey = 'pending:' + tab;
  if (cache.get(pendingKey)) return;
  cache.put(pendingKey, '1', DEBOUNCE_SECONDS);
  Utilities.sleep(DEBOUNCE_SECONDS * 1000);
  cache.remove(pendingKey);

  var props = PropertiesService.getScriptProperties();
  var endpoint = props.getProperty('SYNC_ENDPOINT');
  var secret = props.getProperty('SYNC_SECRET');
  if (!endpoint || !secret) {
    console.error('escalation sync: SYNC_ENDPOINT / SYNC_SECRET script properties are not set');
    return;
  }

  var res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Sync-Secret': secret },
    payload: JSON.stringify({ tab: tab }),
    muteHttpExceptions: true,
  });

  // The sync is idempotent (WRITE_TRUNCATE staging + MERGE), so a failure needs no compensating
  // action - the next edit retries. Log it so a persistently broken sync is visible in
  // Executions rather than silent.
  if (res.getResponseCode() !== 200) {
    console.error('escalation sync failed for ' + tab + ': ' + res.getResponseCode() + ' ' + res.getContentText());
  } else {
    console.log('escalation sync ' + tab + ': ' + res.getContentText());
  }
}

/** Run manually from the Apps Script editor to sync both tabs without waiting for an edit. */
function syncAllTabsNow() {
  TABS.forEach(function (tab) {
    var props = PropertiesService.getScriptProperties();
    UrlFetchApp.fetch(props.getProperty('SYNC_ENDPOINT'), {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Sync-Secret': props.getProperty('SYNC_SECRET') },
      payload: JSON.stringify({ tab: tab }),
      muteHttpExceptions: true,
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/escalation_sync.gs
git commit -m "feat(bq): Apps Script onChange trigger for the escalation sync"
```

---

### Task 10: Migration and reconciliation

**Files:**
- Create: `scripts/migrate_escalation_to_bq.js`

This is a one-off, run once by the user against real infrastructure. It must be safe to re-run.

**Interfaces:**
- Consumes: `escalationBq` (`ensureTables`, `syncTab`), `escalationSheet.readAllRows`, `bigquery.query`, `db.pgSql`.

- [ ] **Step 1: Write the script**

Create `scripts/migrate_escalation_to_bq.js`:

```javascript
// One-off backfill: escalation sheet + Postgres assignments -> BigQuery.
//
//   node scripts/migrate_escalation_to_bq.js --dry-run    # report only, writes nothing
//   node scripts/migrate_escalation_to_bq.js              # apply
//
// Safe to re-run: the sheet load is WRITE_TRUNCATE + MERGE, and the assignment backfill deletes
// its own previously-written events before re-inserting, so a second run converges rather than
// duplicating history.
//
// This is the one script here that talks to live infrastructure. It reconciles at the end and
// exits non-zero on any mismatch, so a partial migration cannot be mistaken for a clean one.
'use strict';
const bq = require('../api/_lib/bigquery');
const ebq = require('../api/_lib/escalationBq');
const { readAllRows } = require('../api/_lib/escalationSheet');
const { pgSql } = require('../api/_lib/db');

const DRY_RUN = process.argv.includes('--dry-run');

function log(...args) { console.log(...args); }

async function backfillOrders() {
  log('\n== Orders ==');
  await ebq.ensureTables();
  for (const tab of ebq.SHEET_TABS) {
    if (DRY_RUN) { log(`  [dry-run] would sync ${tab}`); continue; }
    const out = await ebq.syncTab(tab);
    log(`  ${tab}: read ${out.read}, loaded ${out.loaded}, duplicate keys dropped ${out.duplicates}`);
  }
}

// The sheet's T-W columns hold real historical resolutions written by agents. syncTab does not
// carry them across (it writes sheet-owned columns only, by design), so they are backfilled here
// in one MERGE, and only onto rows that have no resolution in BigQuery yet - so re-running never
// overwrites work done in BigQuery since the migration.
async function backfillHistoricalResolutions() {
  log('\n== Historical resolutions (sheet columns T-W) ==');
  const rows = await readAllRows();
  const resolved = rows
    .filter((o) => String(o.status || '').trim())
    .map((o) => ({
      sheet_tab: o.sheetTab,
      parent_order: String(o.parentOrder || ''),
      awb_key: ebq.awbKeyOf(o.awbNumber),
      new_order_id: o.newOrderId || '-',
      new_awb: o.awb || '-',
      status: o.status,
      notes: o.notes || '',
    }));
  log(`  ${resolved.length} resolved rows found in the sheet`);
  if (DRY_RUN || !resolved.length) return;

  await bq.query(
    `MERGE \`${ebq.ORDERS}\` T
     USING UNNEST(@items) S
     ON  T.sheet_tab = S.sheet_tab AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key
     WHEN MATCHED AND COALESCE(T.status, '') = '' THEN UPDATE SET
       new_order_id = S.new_order_id,
       new_awb = S.new_awb,
       status = S.status,
       notes = S.notes`,
    [bq.structArrayParam('items',
      ['sheet_tab', 'parent_order', 'awb_key', 'new_order_id', 'new_awb', 'status', 'notes'],
      resolved)],
    { useQueryCache: false }
  );
  log('  backfilled');
}

// Each Postgres assignment row becomes up to three events, so the BigQuery history reproduces the
// same cycles AssignmentsPanel renders today.
async function backfillAssignments() {
  log('\n== Assignments ==');
  const { rows } = await pgSql`
    SELECT parent_order, email, assigned_at, reassigned_away_at, resolved_at, resolution, agent_remarks
    FROM escalation_lead_assignments
    ORDER BY assigned_at ASC
  `;
  log(`  ${rows.length} Postgres assignment rows`);
  if (DRY_RUN || !rows.length) return;

  const events = [];
  rows.forEach((r) => {
    events.push({ parent_order: r.parent_order, email: r.email, event: 'assigned', resolution: null, agent_remarks: null, ts: r.assigned_at.toISOString() });
    if (r.reassigned_away_at) events.push({ parent_order: r.parent_order, email: r.email, event: 'reassigned_away', resolution: null, agent_remarks: null, ts: r.reassigned_away_at.toISOString() });
    if (r.resolved_at) events.push({ parent_order: r.parent_order, email: r.email, event: 'resolved', resolution: r.resolution, agent_remarks: r.agent_remarks, ts: r.resolved_at.toISOString() });
  });

  // Idempotence: clear anything a previous run of this script wrote before re-inserting.
  await bq.query(`DELETE FROM \`${ebq.EVENTS}\` WHERE TRUE`, [], { useQueryCache: false });
  await bq.query(
    `INSERT INTO \`${ebq.EVENTS}\` (parent_order, sheet_tab, awb_key, email, event, resolution, agent_remarks, ts)
     SELECT parent_order, NULL, NULL, email, event, resolution, agent_remarks, TIMESTAMP(ts)
     FROM UNNEST(@events)`,
    [bq.structArrayParam('events', ['parent_order', 'email', 'event', 'resolution', 'agent_remarks', 'ts'], events)],
    { useQueryCache: false }
  );
  log(`  ${events.length} events inserted`);

  // Stamp the still-live assignments onto the orders table.
  const live = rows.filter((r) => !r.reassigned_away_at && !r.resolved_at);
  if (live.length) {
    await bq.query(
      `MERGE \`${ebq.ORDERS}\` T
       USING UNNEST(@items) S
       ON T.parent_order = S.parent_order
       WHEN MATCHED AND T.assigned_to IS NULL THEN UPDATE SET
         assigned_to = S.email, assigned_at = TIMESTAMP(S.assigned_at)`,
      [bq.structArrayParam('items', ['parent_order', 'email', 'assigned_at'],
        live.map((r) => ({ parent_order: r.parent_order, email: r.email, assigned_at: r.assigned_at.toISOString() })))],
      { useQueryCache: false }
    );
    log(`  ${live.length} live assignments stamped onto orders`);
  }
}

async function reconcile() {
  log('\n== Reconcile ==');
  let failures = 0;
  const check = (label, sheet, bqValue) => {
    const ok = sheet === bqValue;
    log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: sheet/pg=${sheet} bigquery=${bqValue}`);
    if (!ok) failures++;
  };

  const sheetRows = await readAllRows();
  for (const tab of ebq.SHEET_TABS) {
    const sheetCount = sheetRows.filter((r) => r.sheetTab === tab).length;
    const { rows } = await bq.query(
      `SELECT COUNT(*) AS n FROM \`${ebq.ORDERS}\` WHERE sheet_tab = @tab AND deleted_from_sheet_at IS NULL`,
      [bq.strParam('tab', tab)], { useQueryCache: false }
    );
    // Duplicate keys collapse, so BigQuery can legitimately hold fewer rows than the sheet.
    const bqCount = Number(rows[0].n);
    log(`  ${bqCount === sheetCount ? 'ok  ' : 'note'} ${tab} rows: sheet=${sheetCount} bigquery=${bqCount}` +
        (bqCount === sheetCount ? '' : ' (difference should equal the duplicate-key count reported above)'));
  }

  const sheetResolved = sheetRows.filter((r) => String(r.status || '').trim()).length;
  const { rows: resolvedRows } = await bq.query(
    `SELECT COUNT(*) AS n FROM \`${ebq.ORDERS}\` WHERE COALESCE(status, '') != ''`, [], { useQueryCache: false }
  );
  check('resolved rows', sheetResolved, Number(resolvedRows[0].n));

  const { rows: pgLive } = await pgSql`
    SELECT COUNT(*)::int AS n FROM escalation_lead_assignments
    WHERE reassigned_away_at IS NULL AND resolved_at IS NULL
  `;
  const { rows: bqLive } = await bq.query(
    `SELECT COUNT(*) AS n FROM \`${ebq.ORDERS}\` WHERE assigned_to IS NOT NULL AND resolved_at IS NULL`,
    [], { useQueryCache: false }
  );
  check('live assignments', pgLive[0].n, Number(bqLive[0].n));

  if (failures) {
    console.error(`\n${failures} reconciliation check(s) failed — do not cut over.`);
    process.exitCode = 1;
  } else {
    log('\nReconciliation clean.');
  }
}

(async () => {
  log(DRY_RUN ? 'DRY RUN — nothing will be written\n' : 'APPLYING migration\n');
  await backfillOrders();
  await backfillHistoricalResolutions();
  await backfillAssignments();
  if (!DRY_RUN) await reconcile();
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('\nMigration failed:', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check scripts/migrate_escalation_to_bq.js`
Expected: no output (syntax OK). **Do not run the script** — it writes to live BigQuery and reads the live sheet and database. The user runs it.

- [ ] **Step 3: Run the full self-check one more time**

Run: `npm run test:escalation`
Expected: PASS — 39 passed

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate_escalation_to_bq.js
git commit -m "feat(bq): one-off escalation migration with reconciliation"
```

---

## Handover notes for the user

These steps are outside the repo and cannot be done by the implementer:

1. Grant the existing service account **BigQuery Data Editor** and **BigQuery Job User** on `BQ_PROJECT_ID`.
2. Set `BQ_PROJECT_ID`, `BQ_DATASET`, and `ESCALATION_SYNC_SECRET` in the Lambda environment.
3. Run `node scripts/migrate_escalation_to_bq.js --dry-run`, then without the flag. Confirm reconciliation is clean before cutting over.
4. Paste `scripts/escalation_sync.gs` into the escalation workbook's Apps Script project, set the `SYNC_ENDPOINT` and `SYNC_SECRET` script properties, and install the `onChange` trigger.
5. Phase 2, once the sheet's upstream writers are identified: repoint them at BigQuery and retire the sheet. No application change is required.
