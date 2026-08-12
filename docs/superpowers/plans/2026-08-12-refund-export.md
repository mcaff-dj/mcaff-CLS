# Refund CSV Export (Calling Team → Exports tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Calling Team's placeholder "Exports" sidebar tab into a real, filtered CSV export of the MySQL `PEP_CLS.refund_all_brands` table.

**Architecture:** A new GET-only Express route (`api/refund-export.js`) validates a required date range plus optional status/refundType/source filters, counts matching rows before running the real query (to enforce a hard export cap), and streams the result as `text/csv`. A new page (`app/refund-export/`) provides the filter form and triggers the download via fetch+blob. PII columns are appended server-side only for company-wide admins.

**Tech Stack:** Next.js (App Router) page + React client component, Express handler mounted in the existing Lambda app, `mysql2` against the app's existing `PEP_CLS` MySQL pool (`api/_lib/db.js`), plain Node `assert` for the one pure-logic test (matches `api/_lib/db.retry.test.js`'s existing convention — no test framework in this repo).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-refund-export-design.md`.
- Table: `PEP_CLS.refund_all_brands` (MySQL, same RDS instance/pool `api/_lib/db.js` already connects to — no new connection needed).
- Base (non-PII) columns, exact order: `s_no, order_number, payment_id, platform_order_number, rrn_no, refund_id, reference_id, amount, created_at, auto_refund, refund_type, status, is_chargeback, chargeback_case_id, chargeback_case_status, moid, initiated_by, refunded_at, transaction_payment_id, source, refund_request_description`.
- PII columns (admin-only, appended after the base columns): `customer_name, customer_phone, customer_email, shipping_address, billing_address`.
- `created_at` is VARCHAR, two real formats, both day-first: `D/M/YYYY h:mm AM/PM` and `DD-MM-YYYY HH:MM`. Parse with `COALESCE(STR_TO_DATE(created_at, '%d/%c/%Y %h:%i %p'), STR_TO_DATE(created_at, '%d-%m-%Y %H:%i'))`.
- Hard export cap: **10,000 rows**. If the filtered count exceeds it, the endpoint returns 400 with the actual count instead of running the full query.
- Access: same two-check shape as `api/escalation/[action].js`'s `checkAccess` — `calling` card required, plus the `exports` tab specifically when the account has tab-level restrictions (`session.tabPerms.calling`). PII columns require `session.isAdmin` — decided server-side only, never from a client-supplied flag.
- **No live testing or deploy in this session.** Every "verify" step below is a static/offline check (`node --check`, the pure-function assert test, `npm run build`) — no script may run against the real MySQL/Postgres database, no dev server, no deploy. The user tests the live behavior themselves.
- **Ask before `git commit`/`git push`** — do not run either without the user's explicit go-ahead for that specific commit, even after a task's steps all pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `api/_lib/db.js` (modify) | Add the WHERE-builder + count/row fetchers for `refund_all_brands`, plus the column-list/cap constants. Same file every other Calling-desk data fetcher already lives in. |
| `api/_lib/db.refundExport.test.js` (new) | Offline assert test for the pure WHERE-builder, same shape as `db.retry.test.js`. |
| `api/refund-export.js` (new) | The GET handler: auth, filter validation, cap check, CSV response. |
| `api/_lambda/app.js` (modify) | One new `mount(...)` line for `/api/refund-export`. |
| `app/refund-export/page.js` (new) | Route entry, mirrors `app/ndr-calling/page.js`. |
| `app/refund-export/RefundExportClient.js` (new) | Filter form + download button. |
| `app/HomeClient.js` (modify) | Give the `exports` sidebar sub-item a real `url`. |

---

### Task 1: DB layer — WHERE builder, count, and row fetch for `refund_all_brands`

**Files:**
- Modify: `api/_lib/db.js` (add near the bottom, alongside the other exported data-fetchers, before the final `module.exports` block at `api/_lib/db.js:2250`)
- Test: `api/_lib/db.refundExport.test.js`

**Interfaces:**
- Produces (used by Task 2):
  - `REFUND_EXPORT_MAX_ROWS` — `10000` (number)
  - `REFUND_EXPORT_BASE_COLUMNS` — `string[]`, the 21 non-PII columns in the exact order listed in Global Constraints
  - `REFUND_EXPORT_PII_COLUMNS` — `string[]`, the 5 PII columns in the exact order listed in Global Constraints
  - `buildRefundExportWhere({ from, to, status, refundType, source }) => { where: string, params: any[] }` — throws `Error('from and to are required')` if either is falsy. Does NOT validate date format (the API handler's job) or `to >= from`.
  - `async getRefundExportCount(filters) => number`
  - `async getRefundExportRows(filters, { includePii }) => Array<object>` — each object is keyed by column name (matches `REFUND_EXPORT_BASE_COLUMNS`/`REFUND_EXPORT_PII_COLUMNS` exactly, since the SQL `SELECT` list is built from those same constants)

- [ ] **Step 1: Write the failing test**

Create `api/_lib/db.refundExport.test.js`:

```js
// Offline self-check for the refund_all_brands export WHERE-builder in db.js - pure/offline,
// never opens a connection. Run with `node api/_lib/db.refundExport.test.js`.
const assert = require('assert');
const { buildRefundExportWhere } = require('./db');

(async () => {
  // 1. Date-only filter: half-open range on the parsed-date expression, `to` treated as
  //    end-of-day via DATE_ADD so a same-day range isn't empty.
  {
    const { where, params } = buildRefundExportWhere({ from: '2026-08-01', to: '2026-08-12' });
    assert.ok(where.includes('>= ?'), 'must have a lower bound');
    assert.ok(where.includes('DATE_ADD(?, INTERVAL 1 DAY)'), 'upper bound must be end-of-day inclusive');
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12']);
  }

  // 2. Missing from/to throws - this is the one enforcement point for "date range required".
  assert.throws(() => buildRefundExportWhere({ from: '', to: '2026-08-12' }), /from and to are required/);
  assert.throws(() => buildRefundExportWhere({ from: '2026-08-01', to: '' }), /from and to are required/);
  assert.throws(() => buildRefundExportWhere({}), /from and to are required/);

  // 3. A single status value becomes a one-item IN(...), appended after the date params.
  {
    const { where, params } = buildRefundExportWhere({ from: '2026-08-01', to: '2026-08-12', status: 'Completed' });
    assert.ok(where.includes('status IN (?)'));
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12', 'Completed']);
  }

  // 4. Comma-separated multi-value filters, whitespace trimmed, duplicates collapsed - and all
  //    three filter columns can combine in one query.
  {
    const { where, params } = buildRefundExportWhere({
      from: '2026-08-01', to: '2026-08-12',
      status: ' Completed, Failed ,Completed',
      refundType: 'Full',
      source: 'Shopify,Others',
    });
    assert.ok(where.includes('status IN (?,?)'));
    assert.ok(where.includes('refund_type IN (?)'));
    assert.ok(where.includes('source IN (?,?)'));
    assert.deepStrictEqual(params, [
      '2026-08-01', '2026-08-12', 'Completed', 'Failed', 'Full', 'Shopify', 'Others',
    ]);
  }

  // 5. An empty/whitespace-only filter value is the same as omitting it entirely.
  {
    const { where, params } = buildRefundExportWhere({ from: '2026-08-01', to: '2026-08-12', status: '  ,  ' });
    assert.ok(!where.includes('status IN'));
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12']);
  }

  console.log('db.refundExport.test.js: all assertions passed');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/db.refundExport.test.js`
Expected: throws `TypeError: buildRefundExportWhere is not a function` (or similar — the function doesn't exist in `db.js` yet).

- [ ] **Step 3: Write the implementation**

In `api/_lib/db.js`, add this block just before the final `module.exports = { ... }` (currently at line 2250):

```js
// Refund CSV export (Calling Team "Exports" tab) - reads PEP_CLS.refund_all_brands, a table
// fed by GoKwik refund records across every brand storefront (see
// api/refund/gokwik-initiate.js for the refund-INITIATION side of this data; nothing in this
// app writes refund_all_brands itself). See
// docs/superpowers/specs/2026-08-12-refund-export-design.md for the full column/format audit
// this is built from.
//
// created_at/refunded_at are VARCHAR, not real timestamps, and mix two real formats in the
// data - both day-first: 'D/M/YYYY h:mm AM/PM' and 'DD-MM-YYYY HH:MM'. STR_TO_DATE returns
// NULL on a non-matching format rather than erroring, so COALESCE picks whichever pattern
// actually matched a given row.
const REFUND_EXPORT_CREATED_AT_EXPR =
  "COALESCE(STR_TO_DATE(created_at, '%d/%c/%Y %h:%i %p'), STR_TO_DATE(created_at, '%d-%m-%Y %H:%i'))";

const REFUND_EXPORT_BASE_COLUMNS = [
  's_no', 'order_number', 'payment_id', 'platform_order_number', 'rrn_no', 'refund_id',
  'reference_id', 'amount', 'created_at', 'auto_refund', 'refund_type', 'status',
  'is_chargeback', 'chargeback_case_id', 'chargeback_case_status', 'moid', 'initiated_by',
  'refunded_at', 'transaction_payment_id', 'source', 'refund_request_description',
];
// Admin-only - api/refund-export.js decides whether to ask for these from session.isAdmin.
const REFUND_EXPORT_PII_COLUMNS = [
  'customer_name', 'customer_phone', 'customer_email', 'shipping_address', 'billing_address',
];
// Sized from the actual table: measured avg row 438 bytes / true max 1104 bytes across all
// 90k+ rows (all 26 columns) - 10k rows is ~4.4MB expected, safely under Lambda's 6MB response
// ceiling. See the design doc for the full measurement.
const REFUND_EXPORT_MAX_ROWS = 10000;

// Splits a comma-separated query-param value into a trimmed, deduped, non-empty list. ''/null/
// undefined and a value that's only commas/whitespace all mean "no filter on this column".
function splitRefundExportFilterList(value) {
  if (!value) return [];
  const seen = new Set();
  for (const raw of String(value).split(',')) {
    const v = raw.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

// Builds the WHERE clause + positional params shared by the count and row queries below.
// `from`/`to` must already be validated 'YYYY-MM-DD' strings - validating that shape is
// api/refund-export.js's job, since it's the one place that can return a 400 with a useful
// message; this function only enforces that a range was supplied at all; it has no HTTP
// response to give a caller so callers that skip validation get a plain thrown Error instead.
//
// `to` is compared as the START of the day AFTER `to` (a half-open interval), not
// `<= '<to> 23:59:59'` - a bare `<=` against a literal date string compares against midnight
// and would exclude every row with a nonzero time component, silently turning a same-day
// range (from=to) into zero rows.
function buildRefundExportWhere({ from, to, status, refundType, source }) {
  if (!from || !to) throw new Error('from and to are required');
  const clauses = [
    `${REFUND_EXPORT_CREATED_AT_EXPR} >= ?`,
    `${REFUND_EXPORT_CREATED_AT_EXPR} < DATE_ADD(?, INTERVAL 1 DAY)`,
  ];
  const params = [from, to];

  for (const [column, raw] of [['status', status], ['refund_type', refundType], ['source', source]]) {
    const values = splitRefundExportFilterList(raw);
    if (values.length) {
      clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
  }
  return { where: clauses.join(' AND '), params };
}

async function getRefundExportCount(filters) {
  const { where, params } = buildRefundExportWhere(filters);
  const pool = await getPool();
  const [rows] = await pool.execute(`SELECT COUNT(*) AS n FROM refund_all_brands WHERE ${where}`, params);
  return rows[0].n;
}

// includePii must come from session.isAdmin at the call site (api/refund-export.js) - this
// function trusts its caller completely, same as every other data-fetcher in this file.
async function getRefundExportRows(filters, { includePii } = {}) {
  const { where, params } = buildRefundExportWhere(filters);
  const columns = includePii
    ? [...REFUND_EXPORT_BASE_COLUMNS, ...REFUND_EXPORT_PII_COLUMNS]
    : REFUND_EXPORT_BASE_COLUMNS;
  const columnList = columns.map((c) => `\`${c}\``).join(', ');
  const pool = await getPool();
  // REFUND_EXPORT_MAX_ROWS is a fixed internal constant, never user input - safe to
  // interpolate directly rather than as a bound parameter (mysql2 prepared statements are
  // inconsistent about accepting a placeholder in LIMIT across versions).
  const [rows] = await pool.execute(
    `SELECT ${columnList} FROM refund_all_brands WHERE ${where} ORDER BY ${REFUND_EXPORT_CREATED_AT_EXPR} LIMIT ${REFUND_EXPORT_MAX_ROWS}`,
    params
  );
  return rows;
}
```

Then update the `module.exports` block at the end of `api/_lib/db.js` (currently):

```js
module.exports = {
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserById, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  getCallingOverviewStats, getCallingHourlyStats, getCallingOverviewData,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
  isCallingProcessAdmin, getAdministeredProcesses,
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions,
  claimNdrLead, disposeNdrLead,
  assignEscalationOrder, unassignEscalationOrder, resolveEscalationAssignment, getEscalationAssignments,
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk, setEscalationTags,
  getEligibleOrders, getFreshLeads, getEscalationOrderIndex, getEscalationOrdersForExport,
  getEscalationOrdersFingerprint,
  // Exported for api/_lib/db.retry.test.js and db.cache.test.js only - nothing in the app calls
  // these directly.
  isPoolExhausted, withPgConnectRetry, toTransactionModePooler, cachedRead, invalidateCache, CACHE_TTL_MS,
};
```

to:

```js
module.exports = {
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserById, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  getCallingOverviewStats, getCallingHourlyStats, getCallingOverviewData,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
  isCallingProcessAdmin, getAdministeredProcesses,
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions,
  claimNdrLead, disposeNdrLead,
  assignEscalationOrder, unassignEscalationOrder, resolveEscalationAssignment, getEscalationAssignments,
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk, setEscalationTags,
  getEligibleOrders, getFreshLeads, getEscalationOrderIndex, getEscalationOrdersForExport,
  getEscalationOrdersFingerprint,
  REFUND_EXPORT_MAX_ROWS, REFUND_EXPORT_BASE_COLUMNS, REFUND_EXPORT_PII_COLUMNS,
  getRefundExportCount, getRefundExportRows,
  // Exported for api/_lib/db.retry.test.js, db.cache.test.js and db.refundExport.test.js only -
  // nothing in the app calls these directly.
  isPoolExhausted, withPgConnectRetry, toTransactionModePooler, cachedRead, invalidateCache, CACHE_TTL_MS,
  buildRefundExportWhere,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/db.refundExport.test.js`
Expected: `db.refundExport.test.js: all assertions passed`

- [ ] **Step 5: Syntax-check the modified file**

Run: `node --check api/_lib/db.js`
Expected: no output (exit code 0)

- [ ] **Step 6: Commit**

Ask the user before running this — do not commit without their go-ahead.

```bash
git add api/_lib/db.js api/_lib/db.refundExport.test.js
git commit -m "feat: add refund_all_brands export query layer to db.js"
```

---

### Task 2: API endpoint — `GET /api/refund-export`

**Files:**
- Create: `api/refund-export.js`
- Modify: `api/_lambda/app.js:49` (add one mount line after the existing `refund/gokwik-initiate` mount)

**Interfaces:**
- Consumes (from Task 1): `getSession` (`api/_lib/session.js`, pre-existing — returns `{ isAdmin, perms, tabPerms, ... }` or `null`), `toCSV(rows, headers)` (`api/_lib/escalationCsv.js`, pre-existing), `REFUND_EXPORT_MAX_ROWS`, `REFUND_EXPORT_BASE_COLUMNS`, `REFUND_EXPORT_PII_COLUMNS`, `getRefundExportCount`, `getRefundExportRows` (all from `api/_lib/db.js`, Task 1).
- Produces: `GET /api/refund-export?from=YYYY-MM-DD&to=YYYY-MM-DD&status=...&refundType=...&source=...` → `200` with `text/csv` body and `Content-Disposition: attachment`, or a JSON `{ error }` body with `401`/`403`/`400`/`500`. This is what Task 3's frontend calls.

No DB access happens in this session, so this task has no live-query test — verification is static (syntax + code review) plus the user's own manual test once deployed, per Global Constraints.

- [ ] **Step 1: Write `api/refund-export.js`**

```js
// GET /api/refund-export - Calling Team's "Exports" tab: a filtered CSV download of
// PEP_CLS.refund_all_brands (see api/_lib/db.js's own comment above
// getRefundExportCount/getRefundExportRows for what that table is). Gated the same way as
// every other Calling desk endpoint - see api/escalation/[action].js's own checkAccess,
// which this mirrors exactly except for the tab key. PII columns are decided from
// session.isAdmin ONLY - never from anything the client sends, so there is no query param
// that can ask for them.
const { getSession } = require('./_lib/session');
const { toCSV } = require('./_lib/escalationCsv');
const {
  REFUND_EXPORT_MAX_ROWS, REFUND_EXPORT_BASE_COLUMNS, REFUND_EXPORT_PII_COLUMNS,
  getRefundExportCount, getRefundExportRows,
} = require('./_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
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

  const { from, to, status, refundType, source } = req.query || {};
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD' });
  }
  if (to < from) {
    return res.status(400).json({ error: 'to must not be before from' });
  }

  const filters = { from, to, status, refundType, source };

  try {
    const count = await getRefundExportCount(filters);
    if (count > REFUND_EXPORT_MAX_ROWS) {
      return res.status(400).json({
        error: `${count} rows match - narrow your date range (max ${REFUND_EXPORT_MAX_ROWS} per export)`,
        count,
      });
    }

    const rows = await getRefundExportRows(filters, { includePii: session.isAdmin });
    const headers = session.isAdmin
      ? [...REFUND_EXPORT_BASE_COLUMNS, ...REFUND_EXPORT_PII_COLUMNS]
      : REFUND_EXPORT_BASE_COLUMNS;
    const filename = `refund-export_${from}_to_${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(toCSV(rows, headers));
  } catch (e) {
    console.error('api/refund-export error:', e);
    return res.status(500).json({ error: e.message || 'Export failed' });
  }
};
```

- [ ] **Step 2: Syntax-check it**

Run: `node --check api/refund-export.js`
Expected: no output (exit code 0)

- [ ] **Step 3: Mount the route**

In `api/_lambda/app.js`, find this existing line (currently line 49):

```js
mount('post', '/api/refund/gokwik-initiate', '../refund/gokwik-initiate.js');
```

Add immediately after it:

```js
mount('post', '/api/refund/gokwik-initiate', '../refund/gokwik-initiate.js');
mount('get', '/api/refund-export', '../refund-export.js');
```

- [ ] **Step 4: Syntax-check the modified file**

Run: `node --check api/_lambda/app.js`
Expected: no output (exit code 0)

- [ ] **Step 5: Commit**

Ask the user before running this.

```bash
git add api/refund-export.js api/_lambda/app.js
git commit -m "feat: add GET /api/refund-export endpoint"
```

---

### Task 3: Frontend — filter form + download page

**Files:**
- Create: `app/refund-export/page.js`
- Create: `app/refund-export/RefundExportClient.js`

**Interfaces:**
- Consumes: `GET /api/refund-export` (Task 2) via `fetch`.
- Produces: default export `RefundExportClient` (React component, no props), rendered by `page.js` at route `/refund-export`. Task 4 points the sidebar's `exports.url` at this route.

No JSX-safe static check exists via `node --check` (it doesn't parse JSX) — verification here is `npm run build`, a pure compile step (no DB/network access), per Global Constraints.

- [ ] **Step 1: Write `app/refund-export/RefundExportClient.js`**

```jsx
'use client';

// Calling Team's "Exports" tab - filtered CSV download of PEP_CLS.refund_all_brands via
// GET /api/refund-export. No admin/PII branching here: the server (session.isAdmin) decides
// which columns come back, so this page just downloads whatever it's given - see that
// endpoint and docs/superpowers/specs/2026-08-12-refund-export-design.md for why.
import { useState } from 'react';

const STATUS_OPTIONS = ['Completed', 'Initiated', 'Failed', 'Rejected'];
const REFUND_TYPE_OPTIONS = ['Full', 'Partial'];
const SOURCE_OPTIONS = ['Shopify', 'Payment Link', 'Others'];

function FilterGroup({ label, options, selected, onToggle }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {options.map((opt) => (
        <label key={opt} style={{ marginRight: 12, fontSize: 13 }}>
          <input type="checkbox" checked={selected.has(opt)} onChange={() => onToggle(opt)} /> {opt}
        </label>
      ))}
    </div>
  );
}

export default function RefundExportClient() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState(new Set());
  const [refundType, setRefundType] = useState(new Set());
  const [source, setSource] = useState(new Set());
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  function toggle(set, setSet, value) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    setSet(next);
  }

  async function handleDownload() {
    setError('');
    setDownloading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (status.size) params.set('status', [...status].join(','));
      if (refundType.size) params.set('refundType', [...refundType].join(','));
      if (source.size) params.set('source', [...source].join(','));

      const res = await fetch(`/api/refund-export?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `refund-export_${from}_to_${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  const canDownload = Boolean(from) && Boolean(to) && !downloading;

  return (
    <div style={{ padding: 24, maxWidth: 640, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Refund Export</h1>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13 }}>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13 }}>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>
      </div>

      <FilterGroup label="Status" options={STATUS_OPTIONS} selected={status} onToggle={(v) => toggle(status, setStatus, v)} />
      <FilterGroup label="Refund Type" options={REFUND_TYPE_OPTIONS} selected={refundType} onToggle={(v) => toggle(refundType, setRefundType, v)} />
      <FilterGroup label="Source" options={SOURCE_OPTIONS} selected={source} onToggle={(v) => toggle(source, setSource, v)} />

      <button onClick={handleDownload} disabled={!canDownload} style={{ marginTop: 16, padding: '8px 16px' }}>
        {downloading ? 'Preparing…' : 'Download CSV'}
      </button>

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Write `app/refund-export/page.js`**

```js
import RefundExportClient from './RefundExportClient';

export const metadata = {
  title: 'Calling Team — Refund Export',
};

export default function Page() {
  return <RefundExportClient />;
}
```

- [ ] **Step 3: Compile check**

Run: `npm run build`
Expected: build succeeds (exit code 0), with `/refund-export` listed among the compiled routes in the output. This only compiles the app — it does not start a server, hit the database, or deploy anything.

- [ ] **Step 4: Commit**

Ask the user before running this.

```bash
git add app/refund-export/page.js app/refund-export/RefundExportClient.js
git commit -m "feat: add /refund-export filter + download page"
```

---

### Task 4: Wire the "Exports" sidebar tab to the new page

**Files:**
- Modify: `app/HomeClient.js:54`

**Interfaces:**
- Consumes: route `/refund-export` (Task 3).
- Produces: nothing further downstream — this is the last task.

- [ ] **Step 1: Update the sidebar entry**

In `app/HomeClient.js`, find (currently line 47-55):

```js
var CALLING_TEAM_SUBITEMS = {
  overview: { label: 'Overview', text: 'Calling Team Overview', url: '/calling-overview' },
  rto: { label: 'RTO-Calling', text: 'RTO CRM Agent & Refund Portal', url: '/rto-crm' },
  ndr: { label: 'NDR-Calling', text: 'NDR Calling Agent Portal', url: '/ndr-calling' },
  escalation: { label: 'Escalation', text: 'Escalation Agent Portal', url: '/escalation' },
  // No url yet, so selectCallingTeamView falls through to the placeholder panel. Give it a
  // url once there's a real page; CSV download today lives inside each process's own screen.
  exports: { label: 'Exports', text: 'Exports workspace is coming soon.' }
};
```

Replace with:

```js
var CALLING_TEAM_SUBITEMS = {
  overview: { label: 'Overview', text: 'Calling Team Overview', url: '/calling-overview' },
  rto: { label: 'RTO-Calling', text: 'RTO CRM Agent & Refund Portal', url: '/rto-crm' },
  ndr: { label: 'NDR-Calling', text: 'NDR Calling Agent Portal', url: '/ndr-calling' },
  escalation: { label: 'Escalation', text: 'Escalation Agent Portal', url: '/escalation' },
  exports: { label: 'Exports', text: 'Refund Export', url: '/refund-export' }
};
```

- [ ] **Step 2: Syntax-check it**

Run: `node --check app/HomeClient.js`
Expected: fails — this file contains JSX further down (same reason Task 3 uses `npm run build` instead). Run the real check instead:

Run: `npm run build`
Expected: build succeeds (exit code 0).

- [ ] **Step 3: Commit**

Ask the user before running this.

```bash
git add app/HomeClient.js
git commit -m "feat: point the Exports sidebar tab at /refund-export"
```

---

## Manual Verification (user's own — not run in this session)

Once deployed:
1. As a non-admin account with the `exports` tab granted: open Calling Team → Exports, pick a date range, download — confirm the CSV has the 21 base columns and no PII columns.
2. As a company-wide admin: same flow — confirm all 26 columns are present.
3. As an account without the `exports` tab (but with other `calling` tabs granted): confirm the sidebar entry doesn't appear / the endpoint 403s.
4. Pick a date range known to match >10,000 rows (e.g. the full 2025-01-01 to today range) — confirm the UI shows the "N rows match, narrow your date range" error instead of downloading.
5. Pick a same-day range (`from` = `to`) — confirm it returns that day's rows rather than an empty file (this is the half-open-interval edge case Task 1's test covers at the SQL-fragment level, but the actual date arithmetic only runs against real data live).
