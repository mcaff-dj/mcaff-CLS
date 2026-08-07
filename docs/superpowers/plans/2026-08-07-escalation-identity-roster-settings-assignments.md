# Escalation Identity, Roster, Settings & Assignments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the newly-ported Escalation desk onto the real calling-process infrastructure (`calling_agent_process`, `useCallingSession`, `CallingAdminPanel`) RTO/NDR already use, build its three placeholder screens (Agent Management, Settings, Assignments) for real, and add durable per-order assignment history.

**Architecture:** `app/escalation/EscalationClient.js` adopts the shared `useCallingSession('escalation', ...)` hook for real identity/roster instead of its current fake `role`/`USERS` toggle. Three new sibling components (`AgentManagementPanel.js`, `SettingsPanel.js`, `AssignmentsPanel.js`) render behind the sidebar's existing (currently dead) nav items. `api/escalation/[action].js` drops its hardcoded agent array and non-durable in-memory assignment map in favor of `getCallingProcessAgents('escalation')` and a new Postgres table, `escalation_lead_assignments`, added to `api/_lib/db.js` following the exact shape/pattern of the existing `ndr_lead_assignments` table.

**Tech Stack:** Next.js 14 (App Router, client components), React 18, Postgres via the `pg`-backed `pgSql` tagged-template helper in `api/_lib/db.js`, Vercel/Lambda API routes (`api/escalation/[action].js`), no automated test runner in this repo.

## Global Constraints

- **No test framework exists in this repo** (`package.json` only has `dev`/`build` scripts — no `jest`/`vitest`/anything). Every task below replaces the plan template's "write failing test → implement → run tests" cycle with: implement → run a concrete manual verification (a `curl` against the running `next dev` server, or a one-off `node -e` sanity check for a pure function) with an exact expected result → commit. This matches how every existing feature in this codebase is actually verified (there is no other convention to follow).
- **Agent identity is `email`, not a synthetic id.** `getCallingProcessAgents()` (already used by RTO/NDR) returns `{ email, name, isAdmin, status, maxQuota, isProcessAdmin, ... }` — no `id` or `avatar` field. Every place in Escalation's current code that reads `agent.id` or `agent.avatar` must change to `agent.email` and a client-computed initials string, respectively (see Task 3).
- **The durable assignment key is `parent_order` (`HYP_Parent_OrderID`), never the sheet's `rowNumber`.** `rowNumber` shifts under re-sorts/re-syncs; `parent_order` is the same stable key the CSV import path already matches on (`api/_lib/escalationSheet.js`'s `getSheetIndex`).
- **Don't touch RTO's or NDR's own files.** Every change is additive to shared infra (`api/_lib/db.js`, exports list) or scoped to `app/escalation/*` / `api/escalation/*`.
- **Resolution types (`RESOLVE_TYPES`) stay hardcoded.** Per the approved spec, admin-editable dispositions are explicitly out of scope for this plan.
- Dev server: `npm run dev` (Next.js on `http://localhost:3000` by default). All curl verification steps below assume it's running and that you're signed in (a session cookie) — where a step needs auth you can't easily get via curl, the step says to verify through the browser instead.

---

## Task 1: Durable assignment history — new table + data-access functions in `api/_lib/db.js`

**Files:**
- Modify: `api/_lib/db.js:518` (insert new table/index inside `ensurePgSchema()`, right after the existing `ndr_lead_assignments` block and before the function's closing `catch`)
- Modify: `api/_lib/db.js:952` (insert new functions right after `disposeNdrLead`, before the `dateBounds` helper)
- Modify: `api/_lib/db.js:1539-1551` (add the four new functions to `module.exports`)

**Interfaces:**
- Produces: `assignEscalationOrder(parentOrder, email)`, `unassignEscalationOrder(parentOrder)`, `resolveEscalationAssignment(parentOrder, resolution, agentRemarks)`, `getEscalationAssignments()` → `Promise<Array<{ parentOrder, email, assignedAt, reassignedAwayAt, resolvedAt, resolution, agentRemarks }>>`. Task 2 imports and calls all four.

- [ ] **Step 1: Add the table + partial unique index**

Insert immediately after line 518 (the `ndr_lead_assignments_awb_current_key` index creation), still inside the `try` block of `ensurePgSchema()`:

```js
  // Escalation desk's own assignment/resolution history - the same role lead_assignments
  // plays for RTO and ndr_lead_assignments for NDR. Deliberately keyed by parent_order
  // (HYP_Parent_OrderID), NOT the sheet's row number: a row number shifts whenever the sheet
  // is re-sorted or re-synced, while parent_order is the same stable key
  // api/_lib/escalationSheet.js's getSheetIndex already matches CSV-import rows on. Written
  // directly from api/escalation/[action].js's assign/update/bulk-update actions (there is no
  // cron equivalent of assign_leads.py for this desk - assignment here is always an admin/
  // agent clicking something in the UI), replacing the old non-durable in-memory
  // assignmentMap that lost every assignment on a Lambda cold start.
  await pgSql`
    CREATE TABLE IF NOT EXISTS escalation_lead_assignments (
      id BIGSERIAL PRIMARY KEY,
      parent_order TEXT NOT NULL,
      email TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reassigned_away_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      resolution TEXT,
      agent_remarks TEXT
    )
  `;
  // At most one live cycle per order - same partial-unique-index pattern as RTO's
  // lead_assignments_order_id_current_key and NDR's ndr_lead_assignments_awb_current_key.
  await pgSql`CREATE UNIQUE INDEX IF NOT EXISTS escalation_lead_assignments_parent_order_current_key ON escalation_lead_assignments (parent_order) WHERE reassigned_away_at IS NULL`;
```

- [ ] **Step 2: Verify the schema change loads without error**

Run: `npm run dev`, then in another terminal: `curl -s http://localhost:3000/api/escalation/orders -o /dev/null -w '%{http_code}\n'`
Expected: `401` (not authenticated) or `200` — either is fine, both prove the route handler (and therefore `ensurePgSchema()`) ran without throwing. A `500` means the new SQL has a syntax error — fix it before continuing.
Then confirm the table actually exists: `psql "$DATABASE_URL" -c "\d escalation_lead_assignments"` (or your usual Postgres client) and check the columns/index match the DDL above.

- [ ] **Step 3: Add the four data-access functions**

Insert immediately after `disposeNdrLead`'s closing `}` (currently line 952), before the `dateBounds` comment block:

```js
// Escalation's own equivalent of claimNdrLead, but explicit about reassignment: closes any
// OTHER agent's currently-live row for this order before opening a new one, so history is
// preserved (matches RTO/NDR's "reassigned_away_at, not overwritten" cycle model) rather than
// silently mutating email in place. A no-op re-assign to the SAME agent (e.g. re-saving the
// dropdown without changing it) touches nothing, same ON CONFLICT DO NOTHING safety claimNdrLead
// relies on.
async function assignEscalationOrder(parentOrder, email) {
  await ensurePgSchema();
  await pgSql`
    UPDATE escalation_lead_assignments
    SET reassigned_away_at = now()
    WHERE parent_order = ${parentOrder} AND reassigned_away_at IS NULL AND email <> ${email}
  `;
  await pgSql`
    INSERT INTO escalation_lead_assignments (parent_order, email)
    VALUES (${parentOrder}, ${email})
    ON CONFLICT (parent_order) WHERE reassigned_away_at IS NULL DO NOTHING
  `;
}

// Clears an order's live assignment (the queue table's "Clear assignment" action) without
// assigning it to anyone new - closes the live cycle, leaving its history intact.
async function unassignEscalationOrder(parentOrder) {
  await ensurePgSchema();
  await pgSql`
    UPDATE escalation_lead_assignments
    SET reassigned_away_at = now()
    WHERE parent_order = ${parentOrder} AND reassigned_away_at IS NULL
  `;
}

// Stamps a resolution onto the SAME live row assignEscalationOrder created - same relationship
// disposeNdrLead has to claimNdrLead. Silently a no-op if the order was never assigned to
// anyone (WHERE matches zero rows) - resolving an unassigned order still writes to the sheet
// (the desk's real source of truth) via updateOrder/batchUpdateOrders; this table is only the
// durable history side, so having nothing to update here is not an error.
async function resolveEscalationAssignment(parentOrder, resolution, agentRemarks) {
  await ensurePgSchema();
  await pgSql`
    UPDATE escalation_lead_assignments
    SET resolved_at = now(), resolution = ${resolution || null}, agent_remarks = ${agentRemarks || null}
    WHERE parent_order = ${parentOrder} AND reassigned_away_at IS NULL
  `;
}

// Full history, newest first. No date filtering here on purpose: "assigned this week" and
// "resolved this week" are different questions about different timestamps on the same table
// (same reasoning as getCallingOverviewStats' own per-metric date scoping above) - a single
// WHERE clause on one timestamp would silently miscount whichever metric doesn't share it.
// Callers that need date-scoped metrics (AssignmentsPanel) filter each metric by its own
// timestamp client-side instead. Also doubles as the read side of the live assignment map
// (api/escalation/[action].js's assign GET filters this down to rows with neither
// reassignedAwayAt nor resolvedAt set).
async function getEscalationAssignments() {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT parent_order, email, assigned_at, reassigned_away_at, resolved_at, resolution, agent_remarks
    FROM escalation_lead_assignments
    ORDER BY assigned_at DESC
  `;
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

- [ ] **Step 4: Export the four functions**

Modify the `module.exports` block (currently `api/_lib/db.js:1539-1551`):

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
};
```

- [ ] **Step 5: Verify the functions work end-to-end with a throwaway script**

Create a temporary file `scripts/_tmp_verify_escalation_assignments.js` (delete it in Step 6):

```js
const { assignEscalationOrder, unassignEscalationOrder, resolveEscalationAssignment, getEscalationAssignments } = require('../api/_lib/db');

(async () => {
  const order = `TEST-${Date.now()}`;
  await assignEscalationOrder(order, 'agent-a@example.com');
  await assignEscalationOrder(order, 'agent-b@example.com'); // reassign
  await resolveEscalationAssignment(order, 'Delivered', 'test remarks');
  const rows = (await getEscalationAssignments()).filter((r) => r.parentOrder === order);
  console.log(JSON.stringify(rows, null, 2));
  console.assert(rows.length === 2, `expected 2 history rows, got ${rows.length}`);
  console.assert(rows.some((r) => r.email === 'agent-a@example.com' && r.reassignedAwayAt), 'agent-a row should be closed');
  console.assert(rows.some((r) => r.email === 'agent-b@example.com' && r.resolution === 'Delivered'), 'agent-b row should be resolved');
  console.log('OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

Run: `node scripts/_tmp_verify_escalation_assignments.js`
Expected: prints two JSON rows (one for `agent-a@example.com` with `reassignedAwayAt` set, one for `agent-b@example.com` with `resolvedAt`/`resolution: 'Delivered'` set), then `OK`, exit code 0.

- [ ] **Step 6: Delete the throwaway script and commit**

```bash
rm scripts/_tmp_verify_escalation_assignments.js
git add api/_lib/db.js
git commit -m "feat: add escalation_lead_assignments table and data-access functions"
```

---

## Task 2: Wire `api/escalation/[action].js` onto the real roster and the new assignment table

**Files:**
- Modify: `api/escalation/[action].js` (whole `agents`/`assign`/`update`/`bulk-update` actions, plus one new `assignments` action)

**Interfaces:**
- Consumes: `getCallingProcessAgents`, `assignEscalationOrder`, `unassignEscalationOrder`, `resolveEscalationAssignment`, `getEscalationAssignments` from `../_lib/db` (Task 1); `getSheetIndex` from `../_lib/escalationSheet` (already imported elsewhere in this file's standalone form — see below).
- Produces: `GET /api/escalation/agents` → `{ agents: [{email,name,isAdmin,status,maxQuota,isProcessAdmin,...}] }` (real roster, no more fake ids). `GET /api/escalation/assign` → `{ assignments: { [rowNumber]: { agentId } } }` (agentId is now an email, no `agentName` field — the client resolves display name from the agents list). `POST /api/escalation/assign` now requires `{ rowNumber, parentOrder, agentId }` (was `{ rowNumber, agentId, agentName }`). `POST /api/escalation/update` now also requires `parentOrder` in the body. `POST /api/escalation/bulk-update` now takes `{ items: [{rowNumber, parentOrder}], status }` (was `{ rowNumbers, status }`). `GET /api/escalation/assignments` (new) → `{ assignments: [...] }`, the full history from `getEscalationAssignments()`.

- [ ] **Step 1: Swap the hardcoded `AGENTS` array for the real roster**

Replace (currently `api/escalation/[action].js:15-42`):

```js
const { getSession } = require('../_lib/session');
const {
  getEligibleOrders, updateOrder, batchUpdateOrders, getSheetIndex,
} = require('../_lib/escalationSheet');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');

const CARD_KEY = 'calling';
const TAB_KEY = 'escalation';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Escalation.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Escalation.';
  return null;
}

// Static roster for the assignment picker. Carried over from the standalone app's
// pages/api/agents.js as-is - the real roster lives in calling_agent_process (see
// /api/admin/calling-agents), and wiring this desk onto it is follow-up work; until then this
// list only labels an assignment chip and grants nothing.
const AGENTS = [
  { id: 'agent_1', name: 'Priya Sharma', email: 'priya@company.com', avatar: 'PS' },
  { id: 'agent_2', name: 'Rahul Verma', email: 'rahul@company.com', avatar: 'RV' },
  { id: 'agent_3', name: 'Anita Gupta', email: 'anita@company.com', avatar: 'AG' },
  { id: 'agent_4', name: 'Karan Mehta', email: 'karan@company.com', avatar: 'KM' },
  { id: 'agent_5', name: 'Sneha Pillai', email: 'sneha@company.com', avatar: 'SP' },
];

// Row -> agent assignment. In-memory, exactly as in the standalone app: it is a UI convenience
// (who is looking at what right now), not access control and not durable - a Lambda cold start
// or a second concurrent instance starts empty. `global` keeps it alive across the module
// re-evaluation a dev-server hot reload causes. Persisting this belongs in the sheet or
// lead_assignments alongside the rest of the port's follow-up work.
const assignmentMap = global._escalationAssignmentMap || (global._escalationAssignmentMap = {});
```

with:

```js
const { getSession } = require('../_lib/session');
const {
  getEligibleOrders, updateOrder, batchUpdateOrders, getSheetIndex,
} = require('../_lib/escalationSheet');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const {
  getCallingProcessAgents, assignEscalationOrder, unassignEscalationOrder,
  resolveEscalationAssignment, getEscalationAssignments,
} = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'escalation';
const PROCESS_KEY = 'escalation';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Escalation.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Escalation.';
  return null;
}
```

- [ ] **Step 2: Point the `agents` action at the real roster**

Replace (currently `api/escalation/[action].js:67-70`):

```js
    if (action === 'agents') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return res.status(200).json({ agents: AGENTS });
    }
```

with:

```js
    if (action === 'agents') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return res.status(200).json({ agents: await getCallingProcessAgents(PROCESS_KEY) });
    }
```

- [ ] **Step 3: Rewrite `assign` GET/POST onto the durable table, and add `assignments`**

Replace (currently `api/escalation/[action].js:77-87`):

```js
    if (action === 'assign') {
      if (req.method === 'GET') return res.status(200).json({ assignments: assignmentMap });
      if (req.method === 'POST') {
        const { rowNumber, agentId, agentName } = body;
        if (!rowNumber) return res.status(400).json({ error: 'rowNumber required' });
        if (!agentId) delete assignmentMap[rowNumber];
        else assignmentMap[rowNumber] = { agentId, agentName: agentName || agentId };
        return res.status(200).json({ ok: true, assignments: assignmentMap });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }
```

with:

```js
    if (action === 'assign') {
      if (req.method === 'GET') {
        const history = await getEscalationAssignments();
        const { byParent } = await getSheetIndex();
        const assignments = {};
        history.forEach((r) => {
          if (r.reassignedAwayAt || r.resolvedAt) return; // not a live cycle
          const rowNumber = byParent.get(String(r.parentOrder).trim().toLowerCase());
          if (rowNumber != null) assignments[rowNumber] = { agentId: r.email };
        });
        return res.status(200).json({ assignments });
      }
      if (req.method === 'POST') {
        const { rowNumber, parentOrder, agentId } = body;
        if (!rowNumber || !parentOrder) return res.status(400).json({ error: 'rowNumber and parentOrder are required' });
        if (!agentId) await unassignEscalationOrder(parentOrder);
        else await assignEscalationOrder(parentOrder, agentId);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'assignments') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return res.status(200).json({ assignments: await getEscalationAssignments() });
    }
```

- [ ] **Step 4: Stamp resolutions from `update` and `bulk-update`**

Replace (currently `api/escalation/[action].js:89-97`):

```js
    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumber, newOrderId, newAwb, newStatus, notes } = body;
      if (!rowNumber || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'rowNumber, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(rowNumber, { newOrderId, newAwb, newStatus, notes: notes || '' });
      return res.status(200).json({ ok: true });
    }
```

with:

```js
    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumber, parentOrder, newOrderId, newAwb, newStatus, notes } = body;
      if (!rowNumber || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'rowNumber, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(rowNumber, { newOrderId, newAwb, newStatus, notes: notes || '' });
      if (parentOrder) await resolveEscalationAssignment(parentOrder, newStatus, notes || '');
      return res.status(200).json({ ok: true });
    }
```

Replace (currently `api/escalation/[action].js:99-115`):

```js
    if (action === 'bulk-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { rowNumbers, status } = body;
      if (!Array.isArray(rowNumbers) || !rowNumbers.length) {
        return res.status(400).json({ error: 'rowNumbers array is required' });
      }
      if (!status) return res.status(400).json({ error: 'status is required' });
      if (!BULK_ALLOWED.includes(status)) {
        return res.status(400).json({
          error: `Bulk update only supports statuses that need no replacement: ${BULK_ALLOWED.join(', ')}`,
        });
      }
      const updated = await batchUpdateOrders(
        rowNumbers.map((rowNumber) => ({ rowNumber, newOrderId: '-', newAwb: '-', newStatus: status }))
      );
      return res.status(200).json({ ok: true, updated });
    }
```

with:

```js
    if (action === 'bulk-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { items, status } = body;
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'items array is required' });
      }
      if (!status) return res.status(400).json({ error: 'status is required' });
      if (!BULK_ALLOWED.includes(status)) {
        return res.status(400).json({
          error: `Bulk update only supports statuses that need no replacement: ${BULK_ALLOWED.join(', ')}`,
        });
      }
      const updated = await batchUpdateOrders(
        items.map(({ rowNumber }) => ({ rowNumber, newOrderId: '-', newAwb: '-', newStatus: status }))
      );
      await Promise.all(
        items.map(({ parentOrder }) => (parentOrder ? resolveEscalationAssignment(parentOrder, status, '') : Promise.resolve()))
      );
      return res.status(200).json({ ok: true, updated });
    }
```

- [ ] **Step 5: Verify with curl against the running dev server**

Run: `npm run dev`, sign in via the browser once so you have a session cookie, then extract it (`document.cookie` in devtools, or use the browser's Network tab to copy the request as curl). With that cookie:

```bash
curl -s -H "Cookie: <paste session cookie>" http://localhost:3000/api/escalation/agents | head -c 500
```
Expected: `{"agents":[...]}` with real `email`/`name` fields (people who actually have `calling` access), not `agent_1..agent_5`.

```bash
curl -s -H "Cookie: <paste session cookie>" http://localhost:3000/api/escalation/assignments
```
Expected: `{"assignments":[]}` on a fresh table, or existing history rows if Task 1's verify script data is still present (it was cleaned up in Task 1 Step 6, so this should be empty unless real assignments have happened by now).

- [ ] **Step 6: Commit**

```bash
git add "api/escalation/[action].js"
git commit -m "feat: back escalation agents/assign/update/bulk-update with the real roster and assignment table"
```

---

## Task 3: Real session identity in `EscalationClient.js` — remove the fake role switcher

**Files:**
- Create: `app/escalation/escalationHelpers.js`
- Modify: `app/escalation/EscalationClient.js`

**Interfaces:**
- Consumes: `useCallingSession('escalation', {})` from `../_calling/useCallingSession`, returning (per its actual code) `{ googleUser, sessionIsAdmin, isProcessAdmin, processAgents, saveProcessAgent, savingAgentEmail, agentStatus, serverPresence, setStatus, setStatusForAgent, showToast, toast, ... }`.
- Produces: `initials(name)` from the new `escalationHelpers.js`, used by Task 4/5/6/7. `isAdmin` (local const `= sessionIsAdmin || isProcessAdmin`) replaces every prior use of `role === 'admin'`. `googleUser` replaces every prior use of `USERS[role]`.

- [ ] **Step 1: Create the shared helper**

```js
// app/escalation/escalationHelpers.js
// Real agents (from calling_agent_process, via getCallingProcessAgents) carry only
// email/name - no stored avatar string like the old hardcoded AGENTS array had. This derives
// a 2-letter initials badge from a display name, used everywhere Escalation shows a small
// avatar circle (topbar, sidebar footer, assignment chips, roster table).
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
```

- [ ] **Step 2: Verify the helper**

Run: `node -e "const {initials} = require('./app/escalation/escalationHelpers.js'); console.log(initials('Priya Sharma'), initials('Admin'), initials(''), initials(undefined))"`

This will fail as-is because the file uses `export`, not `module.exports` (Next.js transpiles ESM; plain `node` doesn't). Instead verify with a quick inline transpile-free check:

Run: `node -e "function initials(name){const p=String(name||'').trim().split(/\s+/).filter(Boolean);if(!p.length)return '?';if(p.length===1)return p[0].slice(0,2).toUpperCase();return (p[0][0]+p[1][0]).toUpperCase();} console.log(initials('Priya Sharma'), initials('Admin'), initials(''), initials(undefined))"`
Expected: `PS AD ? ?`

- [ ] **Step 3: Remove the fake role/USERS/AGENT_STATUSES-key-mismatch state and wire the real hook**

Add the import at the top of `EscalationClient.js` (after the existing `import './escalation.css';` at line 12):

```js
import { useCallingSession } from '../_calling/useCallingSession';
import { initials } from './escalationHelpers';
```

Replace the `USERS` constant (currently `EscalationClient.js:59-63`):

```js
// Simulated user profiles — in a real app this would come from auth
const USERS = {
  admin: { name: 'Admin User',   avatar: 'AU', roleLabel: 'Administrator',  agentId: null },
  agent: { name: 'Priya Sharma', avatar: 'PS', roleLabel: 'Support Agent',  agentId: 'agent_1' },
};
```

by deleting it entirely — real identity comes from `googleUser` now.

Replace the `AGENT_STATUSES` constant (currently `EscalationClient.js:65-71`) — the old keys (`online/busy/break/offline`) don't match `useCallingSession`'s real status vocabulary (`Online/Busy/OnCall/Offline`, where confusingly `'Busy'` means *on break* and `'OnCall'` means *on a call* — see the hook's own comment):

```js
// Availability states an agent can broadcast. `color` maps to a CSS variable family.
const AGENT_STATUSES = [
  { key: 'online',  label: 'Online',  color: 'success', desc: 'Available for new tickets' },
  { key: 'busy',    label: 'Busy',    color: 'danger',  desc: 'On a call — do not disturb' },
  { key: 'break',   label: 'On Break', color: 'warning', desc: 'Away for a short while' },
  { key: 'offline', label: 'Offline', color: 'muted',   desc: 'Not working right now' },
];
```

with:

```js
// Availability states an agent can broadcast — matches useCallingSession's real vocabulary
// exactly (STATUS_OPTIONS in app/_calling/useCallingSession.js), not an Escalation-local set,
// since this now writes real presence RTO/NDR's own tooling reads too.
const AGENT_STATUSES = [
  { key: 'Online',  label: 'Online',   color: 'success', desc: 'Available for new tickets' },
  { key: 'OnCall',  label: 'Busy',     color: 'danger',  desc: 'On a call — do not disturb' },
  { key: 'Busy',    label: 'On Break', color: 'warning', desc: 'Away for a short while' },
  { key: 'Offline', label: 'Offline',  color: 'muted',   desc: 'Not working right now' },
];
```

In the main `EscalationClient` function, replace (currently `EscalationClient.js:1024-1029`):

```js
  const [role,             setRole]             = useState('admin');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme,            setTheme]            = useState('light');
  const [view,             setView]             = useState('queue'); // 'queue' | 'overview' | 'agents' | 'assigns' | 'settings'
  const [agentStatus,      setAgentStatus]      = useState('online'); // 'online' | 'offline' | 'busy' | 'break'
```

with:

```js
  const session = useCallingSession('escalation', {});
  const {
    googleUser, sessionIsAdmin, isProcessAdmin,
    processAgents, saveProcessAgent, savingAgentEmail,
    agentStatus, serverPresence, setStatus, setStatusForAgent,
  } = session;
  const isAdmin = sessionIsAdmin || isProcessAdmin;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme,            setTheme]            = useState('light');
  const [view,             setView]             = useState('queue'); // 'queue' | 'overview' | 'agents' | 'assigns' | 'settings'
```

Replace the bounce-effect (currently `EscalationClient.js:1111-1116`):

```js
  // Overview / Agents / Assignments are admin-only — bounce agents back to the queue.
  useEffect(() => {
    if (role !== 'admin' && (view === 'overview' || view === 'agents' || view === 'assigns')) {
      setView('queue');
    }
  }, [role, view]);
```

with:

```js
  // Overview / Agent Management / Assignments / Settings are admin-only — bounce agents
  // back to the queue.
  useEffect(() => {
    if (!isAdmin && (view === 'overview' || view === 'agents' || view === 'assigns' || view === 'settings')) {
      setView('queue');
    }
  }, [isAdmin, view]);
```

Delete the old `isAdmin` derivation line (currently `EscalationClient.js:1318`):

```js
  const isAdmin   = role === 'admin';
```

(it's now declared once, near the top of the function, from the session hook — see above).

- [ ] **Step 4: Verify the file still compiles and the page loads**

Run: `npm run dev`, open `http://localhost:3000/escalation` in a browser while signed in with an account that has `calling` access.
Expected: page loads with no red Next.js error overlay. It's fine (expected, fixed in Task 4) if the topbar/sidebar still reference now-undefined `role`/`USERS` — that's the next task. If the dev server itself fails to start or shows a build error mentioning `useCallingSession` not found, double check the import path (`../_calling/useCallingSession` — `app/escalation/` and `app/_calling/` are siblings under `app/`, same depth as `app/ndr-calling/` which imports it the same way).

- [ ] **Step 5: Commit**

```bash
git add app/escalation/escalationHelpers.js app/escalation/EscalationClient.js
git commit -m "feat: replace Escalation's simulated role/user state with real useCallingSession identity"
```

---

## Task 4: Finish the identity rewire — Sidebar, topbar, agent picker, auto-assign

**Files:**
- Modify: `app/escalation/EscalationClient.js`

**Interfaces:**
- Consumes: `isAdmin`, `googleUser`, `processAgents` (aliased to the existing local `agents` state — see Step 3), `agentStatus`, `setStatus`, `initials` from Task 3.
- Produces: `Sidebar` component's prop shape changes from `{ role }` to `{ isAdmin, user }`. `OrderRow`'s `agents` prop items now have `{ email, name }` (no `id`/`avatar`) — every consumer must key/display by `email`/`initials(name)`.

- [ ] **Step 1: Update `Sidebar` to take `isAdmin`/`user` instead of `role`**

Replace (currently `EscalationClient.js:303-350`):

```js
function Sidebar({ collapsed, role, pendingCount, view, onViewChange }) {
  const navItems = [
    { id: 'queue',    icon: I.inbox,    label: 'RTO Queue',        badge: pendingCount },
    ...(role === 'admin' ? [
      { id: 'overview', icon: I.zap,     label: 'Overview',         badge: null },
      { id: 'agents',   icon: I.users,   label: 'Agent Management', badge: null },
      { id: 'assigns',  icon: I.assign,  label: 'Assignments',      badge: null },
    ] : []),
    { id: 'settings', icon: I.settings, label: 'Settings',         badge: null },
  ];
  const user = USERS[role];
  return (
    <aside className="sidebar">
      <div className="sidebarLogo">
        <div className="sidebarLogoMark">E</div>
        <div className="sidebarLogoText">
          <div className="sidebarLogoTitle">Escalation</div>
          <div className="sidebarLogoSub">Operations Hub</div>
        </div>
      </div>
      <nav className="sidebarNav">
        {role === 'admin' && <div className="navSection">Admin</div>}
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`navItem${view === item.id ? ' active' : ''}`}
            onClick={() => onViewChange(item.id)}
            title={item.label}
          >
            <span className="navItemIcon"><Icon path={item.icon} size={14} /></span>
            <span className="navItemLabel">{item.label}</span>
            {item.badge > 0 && <span className="navBadge">{item.badge > 99 ? '99+' : item.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebarFooter">
        <div className="sidebarUser">
          <div className="userAvatar">{user.avatar}</div>
          <div className="userInfo">
            <div className="userName">{user.name}</div>
            <div className="userRole">{user.roleLabel}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
```

with:

```js
function Sidebar({ collapsed, isAdmin, pendingCount, view, onViewChange, user }) {
  const navItems = [
    { id: 'queue',    icon: I.inbox,    label: 'RTO Queue',        badge: pendingCount },
    ...(isAdmin ? [
      { id: 'overview', icon: I.zap,     label: 'Overview',         badge: null },
      { id: 'agents',   icon: I.users,   label: 'Agent Management', badge: null },
      { id: 'assigns',  icon: I.assign,  label: 'Assignments',      badge: null },
      { id: 'settings', icon: I.settings, label: 'Settings',        badge: null },
    ] : []),
  ];
  return (
    <aside className="sidebar">
      <div className="sidebarLogo">
        <div className="sidebarLogoMark">E</div>
        <div className="sidebarLogoText">
          <div className="sidebarLogoTitle">Escalation</div>
          <div className="sidebarLogoSub">Operations Hub</div>
        </div>
      </div>
      <nav className="sidebarNav">
        {isAdmin && <div className="navSection">Admin</div>}
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`navItem${view === item.id ? ' active' : ''}`}
            onClick={() => onViewChange(item.id)}
            title={item.label}
          >
            <span className="navItemIcon"><Icon path={item.icon} size={14} /></span>
            <span className="navItemLabel">{item.label}</span>
            {item.badge > 0 && <span className="navBadge">{item.badge > 99 ? '99+' : item.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebarFooter">
        <div className="sidebarUser">
          <div className="userAvatar">{initials(user?.name)}</div>
          <div className="userInfo">
            <div className="userName">{user?.name || 'Signed out'}</div>
            <div className="userRole">{isAdmin ? 'Administrator' : 'Support Agent'}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
```

Note: `Settings` moved into the admin-only block (per the approved spec, Settings is admin-only business-hours editing, not a page every agent should see) — it was previously shown to every role.

- [ ] **Step 2: Update the `Sidebar` call site, topbar, and remove the role switcher**

Replace the `Sidebar` call (currently `EscalationClient.js:1389-1390`):

```js
      <Sidebar collapsed={sidebarCollapsed} role={role} pendingCount={totalPending}
        view={view} onViewChange={setView} />
```

with:

```js
      <Sidebar collapsed={sidebarCollapsed} isAdmin={isAdmin} pendingCount={totalPending}
        view={view} onViewChange={setView} user={googleUser} />
```

Replace the topbar's right-hand block (currently `EscalationClient.js:1406-1432`):

```js
          <div className="topbarRight">
            <div className="roleSwitcher" role="group">
              {['admin', 'agent'].map((r) => (
                <button key={r} type="button"
                  className={`roleTab${role === r ? ' active' : ''}`}
                  onClick={() => setRole(r)}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </button>
              ))}
            </div>
            {/* Availability status */}
            <StatusControl status={agentStatus} onChange={setAgentStatus} />
            {/* Theme toggle */}
            <button type="button" className="topbarBtn themeToggle" onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              <Icon path={theme === 'dark' ? I.sun : I.moon} size={13} />
            </button>
            <button type="button" className="topbarBtn" onClick={load} disabled={loading} title="Refresh">
              {/* esc-spin, not spin — keyframes are prefixed when the stylesheet is scoped */}
              <span style={{ display: 'flex', animation: loading ? 'esc-spin 0.8s linear infinite' : 'none' }}>
                <Icon path={I.refresh} size={13} />
              </span>
            </button>
            <div className="userAvatar" style={{ cursor: 'default' }} title={USERS[role].name}>
              {USERS[role].avatar}
            </div>
          </div>
```

with:

```js
          <div className="topbarRight">
            {/* Availability status */}
            <StatusControl status={agentStatus} onChange={setStatus} />
            {/* Theme toggle */}
            <button type="button" className="topbarBtn themeToggle" onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              <Icon path={theme === 'dark' ? I.sun : I.moon} size={13} />
            </button>
            <button type="button" className="topbarBtn" onClick={load} disabled={loading} title="Refresh">
              {/* esc-spin, not spin — keyframes are prefixed when the stylesheet is scoped */}
              <span style={{ display: 'flex', animation: loading ? 'esc-spin 0.8s linear infinite' : 'none' }}>
                <Icon path={I.refresh} size={13} />
              </span>
            </button>
            <div className="userAvatar" style={{ cursor: 'default' }} title={googleUser?.name}>
              {initials(googleUser?.name)}
            </div>
          </div>
```

- [ ] **Step 3: Rewire the assign dropdown / assignment chip / clear button to use `email`, not `id`/`avatar`**

In `OrderRow`, replace (currently `EscalationClient.js:743-757`):

```js
  async function handleAssign(e) {
    const agentId = e.target.value;
    const agent = agents.find((a) => a.id === agentId);
    setAssigning(true);
    try {
      await fetch('/api/escalation/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNumber: order.rowNumber, agentId: agentId || null, agentName: agent?.name || null }),
      });
      onAssign(order.rowNumber, agentId ? { agentId, agentName: agent?.name } : null);
      onToast('success', agentId ? `Assigned to ${agent?.name}` : 'Assignment cleared');
    } catch {
      onToast('error', 'Failed to save assignment');
    } finally { setAssigning(false); }
  }
```

with:

```js
  async function handleAssign(e) {
    const agentId = e.target.value;
    const agent = agents.find((a) => a.email === agentId);
    setAssigning(true);
    try {
      await fetch('/api/escalation/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNumber: order.rowNumber, parentOrder: order.parentOrder, agentId: agentId || null }),
      });
      onAssign(order.rowNumber, agentId ? { agentId } : null);
      onToast('success', agentId ? `Assigned to ${agent?.name || agentId}` : 'Assignment cleared');
    } catch {
      onToast('error', 'Failed to save assignment');
    } finally { setAssigning(false); }
  }
```

Replace the "Assigned To" cell (currently `EscalationClient.js:825-842`):

```js
        {/* Assigned To (admin only) */}
        {isAdmin && (
          <td>
            {assigning ? <span className="spinner spinnerMuted" /> : assignment ? (
              <span className="assignChip">
                <span className="assignChipAvatar">
                  {agents.find((a) => a.id === assignment.agentId)?.avatar?.slice(0, 2) || '?'}
                </span>
                {assignment.agentName}
              </span>
            ) : (
              <select className="assignDropdown" value="" onChange={handleAssign} aria-label="Assign agent">
                <option value="">Assign…</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </td>
        )}
```

with:

```js
        {/* Assigned To (admin only) */}
        {isAdmin && (
          <td>
            {assigning ? <span className="spinner spinnerMuted" /> : assignment ? (
              <span className="assignChip">
                <span className="assignChipAvatar">
                  {initials(agents.find((a) => a.email === assignment.agentId)?.name)}
                </span>
                {agents.find((a) => a.email === assignment.agentId)?.name || assignment.agentId}
              </span>
            ) : (
              <select className="assignDropdown" value="" onChange={handleAssign} aria-label="Assign agent">
                <option value="">Assign…</option>
                {agents.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
              </select>
            )}
          </td>
        )}
```

- [ ] **Step 4: Fix `handleSubmit`'s POST body (needs `parentOrder` now) and `handleBulkApply`/`handleAutoAssign`**

In `OrderRow`'s `handleSubmit` (currently `EscalationClient.js:714-741`), the fetch body:

```js
      const res = await fetch('/api/escalation/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rowNumber: order.rowNumber,
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
      });
```

becomes:

```js
      const res = await fetch('/api/escalation/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rowNumber: order.rowNumber,
          parentOrder: order.parentOrder,
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
      });
```

In the top-level `EscalationClient` function, replace `handleBulkApply` (currently `EscalationClient.js:1156-1175`):

```js
  async function handleBulkApply(status) {
    const rowNumbers = Array.from(selectedRows);
    setBulkLoading(true);
    try {
      const res = await fetch('/api/escalation/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNumbers, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk update failed');
      setOrders((p) => p.filter((o) => !selectedRows.has(o.rowNumber)));
      setResolvedCount((c) => c + rowNumbers.length);
      setSelectedRows(new Set());
      showToast('success', `${data.updated} orders marked as "${status}"`);
    } catch (err) {
      showToast('error', err.message);
    } finally { setBulkLoading(false); }
  }
```

with:

```js
  async function handleBulkApply(status) {
    const items = Array.from(selectedRows).map((rowNumber) => ({
      rowNumber,
      parentOrder: orders.find((o) => o.rowNumber === rowNumber)?.parentOrder,
    }));
    setBulkLoading(true);
    try {
      const res = await fetch('/api/escalation/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk update failed');
      setOrders((p) => p.filter((o) => !selectedRows.has(o.rowNumber)));
      setResolvedCount((c) => c + items.length);
      setSelectedRows(new Set());
      showToast('success', `${data.updated} orders marked as "${status}"`);
    } catch (err) {
      showToast('error', err.message);
    } finally { setBulkLoading(false); }
  }
```

Replace `handleAutoAssign` (currently `EscalationClient.js:1215-1258`):

```js
  async function handleAutoAssign() {
    const user = USERS[role];
    if (!user.agentId && role !== 'admin') return;

    setAutoAssigning(true);
    try {
      const unassigned = orders.filter((o) => !assignments[o.rowNumber]);
      if (unassigned.length === 0) { showToast('success', 'All orders already assigned!'); return; }

      if (role === 'agent') {
        // Assign all unassigned to self
        const updates = unassigned.map((o) =>
          fetch('/api/escalation/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowNumber: o.rowNumber, agentId: user.agentId, agentName: user.name }),
          })
        );
        await Promise.all(updates);
        const newMap = {};
        unassigned.forEach((o) => { newMap[o.rowNumber] = { agentId: user.agentId, agentName: user.name }; });
        setAssignments((p) => ({ ...p, ...newMap }));
        showToast('success', `Auto-assigned ${unassigned.length} orders to you`);
      } else {
        // Admin: round-robin across all agents
        if (agents.length === 0) { showToast('error', 'No agents available'); return; }
        const updates = unassigned.map((o, i) => {
          const agent = agents[i % agents.length];
          return fetch('/api/escalation/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowNumber: o.rowNumber, agentId: agent.id, agentName: agent.name }),
          }).then(() => ({ rowNumber: o.rowNumber, agentId: agent.id, agentName: agent.name }));
        });
        const results = await Promise.all(updates);
        const newMap = {};
        results.forEach(({ rowNumber, agentId, agentName }) => { newMap[rowNumber] = { agentId, agentName }; });
        setAssignments((p) => ({ ...p, ...newMap }));
        showToast('success', `Auto-assigned ${unassigned.length} orders (round-robin across ${agents.length} agents)`);
      }
    } catch { showToast('error', 'Auto-assign failed'); }
    finally { setAutoAssigning(false); }
  }
```

with:

```js
  async function handleAutoAssign() {
    if (!isAdmin && !googleUser?.email) return;

    setAutoAssigning(true);
    try {
      const unassigned = orders.filter((o) => !assignments[o.rowNumber]);
      if (unassigned.length === 0) { showToast('success', 'All orders already assigned!'); return; }

      if (!isAdmin) {
        // Assign all unassigned to self
        const updates = unassigned.map((o) =>
          fetch('/api/escalation/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowNumber: o.rowNumber, parentOrder: o.parentOrder, agentId: googleUser.email }),
          })
        );
        await Promise.all(updates);
        const newMap = {};
        unassigned.forEach((o) => { newMap[o.rowNumber] = { agentId: googleUser.email }; });
        setAssignments((p) => ({ ...p, ...newMap }));
        showToast('success', `Auto-assigned ${unassigned.length} orders to you`);
      } else {
        // Admin: round-robin across all agents
        if (agents.length === 0) { showToast('error', 'No agents available'); return; }
        const updates = unassigned.map((o, i) => {
          const agent = agents[i % agents.length];
          return fetch('/api/escalation/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowNumber: o.rowNumber, parentOrder: o.parentOrder, agentId: agent.email }),
          }).then(() => ({ rowNumber: o.rowNumber, agentId: agent.email }));
        });
        const results = await Promise.all(updates);
        const newMap = {};
        results.forEach(({ rowNumber, agentId }) => { newMap[rowNumber] = { agentId }; });
        setAssignments((p) => ({ ...p, ...newMap }));
        showToast('success', `Auto-assigned ${unassigned.length} orders (round-robin across ${agents.length} agents)`);
      }
    } catch { showToast('error', 'Auto-assign failed'); }
    finally { setAutoAssigning(false); }
  }
```

- [ ] **Step 5: Point the `agents` state load at the session hook's `processAgents` instead of a second fetch**

The page currently fetches `/api/escalation/agents` itself (`EscalationClient.js:1105-1107`):

```js
  useEffect(() => {
    fetch('/api/escalation/agents').then((r) => r.json()).then((d) => setAgents(d.agents || [])).catch(() => {});
  }, []);
```

`useCallingSession` already fetches the equivalent data (`/api/admin/calling-agents?process=escalation`) into `processAgents` — but that endpoint requires the caller to already be a full admin or this process's admin (`isCallingProcessAdmin`), whereas `/api/escalation/agents` (Task 2) is open to anyone with Escalation access (agents need the roster to see names in the "Assigned To" column too, not just admins). **Keep both**: the existing `useEffect` above still fetches `/api/escalation/agents` (now real data via Task 2) into local `agents` state for every signed-in user; `processAgents` from the hook stays reserved for the admin-only Agent Management screen (Task 5), which needs the extra admin-only fields (`isProcessAdmin`, `maxQuota`) `/api/escalation/agents` doesn't return. No code change needed for this step — this note just prevents a wrong "simplification" that would break the agent-facing "Assigned To" column for non-admins. Move on to Step 6.

- [ ] **Step 6: Verify in the browser**

With `npm run dev` running, sign in and open `/escalation`:
1. Topbar shows your real name's initials (not "AU"/"PS"), no role-switcher buttons.
2. Sidebar footer shows your real name and "Administrator" or "Support Agent" matching your actual `is_admin`/process-admin status, not a manual toggle.
3. In the queue table, the "Assign…" dropdown lists real people (from `/api/escalation/agents`); picking one assigns and shows their initials + name in the chip.
4. Toggle your status via the topbar's status control — check in Postgres (`SELECT * FROM agent_presence WHERE email = '<you>'`) that it actually changed, confirming `setStatus` reached the server (this proves the real hook is wired, not just visually similar).

- [ ] **Step 7: Commit**

```bash
git add app/escalation/EscalationClient.js
git commit -m "feat: rewire Escalation's sidebar/topbar/assign-picker onto real agent identities"
```

---

## Task 5: Agent Management screen

**Files:**
- Create: `app/escalation/AgentManagementPanel.js`
- Modify: `app/escalation/EscalationClient.js` (import + render branch)

**Interfaces:**
- Consumes: `session` object from Task 3 (`processAgents`, `saveProcessAgent`, `savingAgentEmail`, `sessionIsAdmin`, `setStatusForAgent`), `initials` from `escalationHelpers.js`, `Icon`/`I` from `EscalationClient.js` (passed as props — see below, since `Icon`/`I` aren't exported from that file and shouldn't be, per Task 3's note about keeping the default export focused).
- Produces: `<AgentManagementPanel session={session} />`, rendered when `view === 'agents'`.

- [ ] **Step 1: Export `Icon`/`I` from `EscalationClient.js` so the new panel can render consistent icons**

`Icon` (currently `EscalationClient.js:104-112`) and the `I` path map (currently `EscalationClient.js:114-140`) are already plain, presentation-only — add `export` to both declarations (`export function Icon({ path, size = 14 }) {`, `export const I = {`). No other change to their bodies.

- [ ] **Step 2: Create the panel**

```js
// app/escalation/AgentManagementPanel.js
'use client';

import { useState } from 'react';
import { Icon, I } from './EscalationClient';
import { initials } from './escalationHelpers';

// Modeled directly on NDR's renderNdrRosterTable (app/ndr-calling/NdrCallingClient.js) -
// deliberately the SIMPLER of the two existing roster patterns in this app (RTO's own
// reconciles a legacy localStorage/ticket-scraped roster Escalation has no equivalent of).
// Membership is exactly processAgents (who's actually invited via report_tab_permissions) -
// there is no add/remove button here; inviting someone is an Admin -> Permissions action.
const HOURS_STATUS_OPTIONS = [
  { key: 'Online', label: 'Online' },
  { key: 'OnCall', label: 'Busy (on a call)' },
  { key: 'Busy', label: 'On Break' },
  { key: 'Offline', label: 'Offline' },
];

export default function AgentManagementPanel({ session }) {
  const { processAgents, saveProcessAgent, savingAgentEmail, sessionIsAdmin, setStatusForAgent } = session;
  const [statusFilter, setStatusFilter] = useState('');

  const rows = (processAgents || []).filter((a) => !statusFilter || a.status === statusFilter);

  return (
    <div className="overviewPanel">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Agent Management</h1>
          <p className="pageSubtitle">Everyone invited to Escalation, their live status, quota, and process-admin rights.</p>
        </div>
        <select className="filterSelect" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All Statuses</option>
          {HOURS_STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <div className="card">
        {processAgents === null ? (
          <div className="emptyState"><span className="emptyEmoji">⏳</span><div className="emptyTitle">Loading roster…</div></div>
        ) : rows.length === 0 ? (
          <div className="emptyState">
            <span className="emptyEmoji">👥</span>
            <div className="emptyTitle">No one invited yet</div>
            <div className="emptyDesc">Grant access from Admin → Permissions.</div>
          </div>
        ) : (
          <table className="overviewTable">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Max Quota</th>
                <th style={{ textAlign: 'center' }}>Process Admin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.email}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="userAvatar" style={{ fontSize: 10, width: 24, height: 24 }}>{initials(a.name)}</div>
                      <div>
                        <strong>{a.name}</strong>
                        <div style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{a.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <select
                      className="assignDropdown"
                      value={a.status}
                      disabled={savingAgentEmail === a.email}
                      onChange={(e) => setStatusForAgent(a.email, e.target.value, a.name)}
                    >
                      {HOURS_STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      className="field"
                      style={{ width: 90 }}
                      defaultValue={a.maxQuota ?? ''}
                      placeholder="Default"
                      disabled={savingAgentEmail === a.email}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        saveProcessAgent(a.email, { maxQuota: v === '' ? null : Number(v) });
                      }}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {a.isAdmin ? (
                      <span style={{ color: 'var(--fg-muted)', fontSize: 11 }} title="Company-wide admin already administers every process">all</span>
                    ) : (
                      <input
                        type="checkbox"
                        className="rowCheckbox"
                        checked={!!a.isProcessAdmin}
                        disabled={!sessionIsAdmin || savingAgentEmail === a.email}
                        onChange={(e) => saveProcessAgent(a.email, { isProcessAdmin: e.target.checked })}
                        title={sessionIsAdmin ? 'Let this person manage Escalation' : 'Only a full admin can change this'}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `EscalationClient.js`'s render**

Add the import near the top (after Task 3's `useCallingSession`/`initials` imports):

```js
import AgentManagementPanel from './AgentManagementPanel';
```

The render's view switch is the big `{view === 'overview' ? ( ... ) : view === 'queue' ? ( ... ) : ( ... )}` expression inside `<main className="pageBody">` (currently spanning `EscalationClient.js:1436-1694`). Its final alternative — the closing `) : ( ... )}` — is currently (`EscalationClient.js:1682-1694`):

```jsx
            </>
          ) : (
            <div className="pageHeader">
              <div>
                <h1 className="pageTitle">{VIEW_LABELS[view] || 'Coming Soon'}</h1>
                <p className="pageSubtitle">
                  {view === 'agents'   && 'Agent roster management — coming soon.'}
                  {view === 'assigns'  && 'Assignment overview — coming soon.'}
                  {view === 'settings' && 'Workspace settings — coming soon.'}
                </p>
              </div>
            </div>
          )}
```

Replace it with (same closing `</>` that ends the `queue` branch immediately above stays untouched — only the `) : ( ... )}` part after it changes):

```jsx
            </>
          ) : view === 'agents' ? (
            <AgentManagementPanel session={session} />
          ) : view === 'assigns' ? (
            <AssignmentsPanel agents={agents} />
          ) : view === 'settings' ? (
            <SettingsPanel hours={hours} />
          ) : null}
```

(The `AssignmentsPanel`/`SettingsPanel` branches reference `agents` and `hours`, neither of which exist yet at this point in the plan — `agents` already exists as this component's own state (`EscalationClient.js:1059`, unchanged by this task), but `hours` isn't declared until Task 6 Step 1. Move to Step 4 below immediately — it stubs both panels to accept and ignore extra props — before running the dev server, since a reference to the not-yet-declared `hours` would otherwise throw. Task 6 Step 1 adds the real `const hours = useBusinessHours(...)` line; until then this branch is unreachable for a non-admin and merely unexercised for an admin who hasn't clicked "Settings" yet, which is fine since JSX branches aren't evaluated unless rendered.)

- [ ] **Step 4: Stub the other two panels so the app builds (Tasks 6/7 replace these)**

Create `app/escalation/SettingsPanel.js`:

```js
'use client';
export default function SettingsPanel() { return null; }
```

Create `app/escalation/AssignmentsPanel.js`:

```js
'use client';
export default function AssignmentsPanel() { return null; }
```

Add both imports next to `AgentManagementPanel`'s in `EscalationClient.js`:

```js
import SettingsPanel from './SettingsPanel';
import AssignmentsPanel from './AssignmentsPanel';
```

- [ ] **Step 5: Verify in the browser**

As an admin/process-admin, click "Agent Management" in the sidebar.
Expected: a table of real invited agents with working Status/Quota/Process Admin controls. Changing a status and refreshing the page should show the change persisted (confirms `saveProcessAgent` actually wrote to Postgres, not just local state).
As a plain agent (or by temporarily testing with `isAdmin` forced false), the sidebar shouldn't show "Agent Management"/"Assignments"/"Settings"/"Overview" at all (Task 4 Step 1 moved them into the admin-only block).

- [ ] **Step 6: Commit**

```bash
git add app/escalation/EscalationClient.js app/escalation/AgentManagementPanel.js app/escalation/SettingsPanel.js app/escalation/AssignmentsPanel.js
git commit -m "feat: add Escalation's Agent Management screen, backed by the real roster"
```

---

## Task 6: Settings screen (business hours)

**Files:**
- Modify: `app/escalation/SettingsPanel.js` (replace the Task 5 stub)
- Modify: `app/escalation/EscalationClient.js` (wire `useBusinessHours` and pass it down)

**Interfaces:**
- Consumes: `useBusinessHours`, `CallingHoursCard` from `../_calling/CallingAdminPanel` (exact signatures confirmed in `app/_calling/CallingAdminPanel.js:26-91`/`:94-184`).
- Produces: `<SettingsPanel hours={hours} />`.

- [ ] **Step 1: Wire `useBusinessHours` in `EscalationClient.js`**

Add the import next to the other Task 3/5 imports:

```js
import { useBusinessHours, CallingHoursCard } from '../_calling/CallingAdminPanel';
```

Right after the `useCallingSession` block from Task 3 (`const session = useCallingSession(...)` etc.), add:

```js
  const hours = useBusinessHours('escalation', { userRole: isAdmin ? 'Admin' : 'Agent', isProcessAdmin, showToast: session.showToast });
```

(`useBusinessHours` expects a `userRole` of `'Admin'`/`'Team Lead'`/anything-else per its own gating check `userRole === 'Admin' || userRole === 'Team Lead' || isProcessAdmin` — Escalation has no "Team Lead" concept, so `isAdmin ? 'Admin' : 'Agent'` correctly triggers the same admin-or-process-admin gate.)

Update the `SettingsPanel` render branch added in Task 5 Step 3:

```jsx
          ) : view === 'settings' ? (
            <SettingsPanel hours={hours} />
```

- [ ] **Step 2: Replace the `SettingsPanel` stub**

```js
// app/escalation/SettingsPanel.js
'use client';

import { CallingHoursCard } from '../_calling/CallingAdminPanel';

// Business hours only, this round - reuses CallingHoursCard exactly as NDR does
// (app/_calling/CallingAdminPanel.js), already generic per-process. Admin-editable
// resolution types (RESOLVE_TYPES in EscalationClient.js) stay hardcoded per the approved
// design spec - the generic calling_process_dispositions table has no columns for the
// needsOrder/needsAwb/isBulkable metadata the resolve form and BULK_ALLOWED depend on.
export default function SettingsPanel({ hours }) {
  return (
    <div className="overviewPanel">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Settings</h1>
          <p className="pageSubtitle">Escalation desk configuration.</p>
        </div>
      </div>
      <CallingHoursCard processKey="escalation" processLabel="Escalation" hours={hours} />
    </div>
  );
}
```

Note: `CallingHoursCard` renders Tailwind utility classes (`bg-zinc-900/90`, etc.), not Escalation's own `.card`/`.pageHeader` classes — this works unchanged because `app/layout.js` loads `app/globals.css` (which includes Tailwind) on every route, including `/escalation` (per `escalation.css`'s own header comment explaining why its rules are scoped: to avoid fighting over `:root` tokens with that same globally-loaded stylesheet, not because Tailwind is absent here).

- [ ] **Step 3: Verify in the browser**

As an admin, click "Settings". Expected: the same business-hours weekly editor RTO/NDR admins see (per-day Open/Close time inputs, Save/Reset buttons), labeled "Escalation". Change a day's hours, click "Save hours", refresh the page, and confirm the change persisted (and check `SELECT * FROM calling_business_hours WHERE process_key = 'escalation'` in Postgres).

- [ ] **Step 4: Commit**

```bash
git add app/escalation/SettingsPanel.js app/escalation/EscalationClient.js
git commit -m "feat: add Escalation's Settings screen (business hours, reusing CallingHoursCard)"
```

---

## Task 7: Assignments screen (per-agent history summary)

**Files:**
- Modify: `app/escalation/AssignmentsPanel.js` (replace the Task 5 stub)
- Modify: `app/escalation/EscalationClient.js` (pass `agents`/`session` down — already wired as part of Task 5 Step 3's render branch)

**Interfaces:**
- Consumes: `GET /api/escalation/assignments` (Task 2) → `{ assignments: [{parentOrder, email, assignedAt, reassignedAwayAt, resolvedAt, resolution, agentRemarks}] }`. `agents` prop (the same `agents` state `EscalationClient.js` already loads from `/api/escalation/agents` — real `{email, name}` list, available to every signed-in user per Task 4 Step 5's note).

- [ ] **Step 1: Replace the `AssignmentsPanel` stub**

```js
// app/escalation/AssignmentsPanel.js
'use client';

import { useState, useEffect, useMemo } from 'react';

// One row per agent: currently-assigned (live, unresolved) count, resolved count, and average
// time-to-resolve. Each metric is scoped by ITS OWN timestamp (assigned_at vs resolved_at) -
// same reasoning db.js's getCallingOverviewStats comment gives for RTO's own metrics: a single
// shared date filter would silently misattribute one of the two. Client-side aggregation,
// mirroring how NDR's own Agent Performance Summary table (NdrCallingClient.js) is computed in
// the browser from raw per-lead rows rather than a single backend aggregate query.
function fmtMinutes(mins) {
  if (mins == null || !Number.isFinite(mins)) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function AssignmentsPanel({ agents }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    fetch('/api/escalation/assignments')
      .then((r) => r.json())
      .then((d) => setHistory(d.assignments || []))
      .catch(() => setError('Could not load assignment history'));
  }, []);

  const inRange = (iso) => {
    if (!iso) return false;
    const day = iso.slice(0, 10);
    if (fromDate && day < fromDate) return false;
    if (toDate && day > toDate) return false;
    return true;
  };

  const rows = useMemo(() => {
    if (!history) return [];
    const byEmail = new Map();
    const get = (email) => {
      if (!byEmail.has(email)) {
        const a = (agents || []).find((x) => x.email === email);
        byEmail.set(email, { email, name: a?.name || email, currentlyAssigned: 0, resolved: 0, totalResolveMinutes: 0 });
      }
      return byEmail.get(email);
    };
    history.forEach((r) => {
      if (!r.reassignedAwayAt && !r.resolvedAt) {
        get(r.email).currentlyAssigned += 1;
      }
      if (r.resolvedAt && inRange(r.resolvedAt)) {
        const row = get(r.email);
        row.resolved += 1;
        row.totalResolveMinutes += (new Date(r.resolvedAt) - new Date(r.assignedAt)) / 60000;
      } else if (!r.resolvedAt) {
        // ensure agents with only live (unresolved) assignments still appear
        get(r.email);
      }
    });
    return Array.from(byEmail.values())
      .map((r) => ({ ...r, avgResolveMinutes: r.resolved ? r.totalResolveMinutes / r.resolved : null }))
      .sort((a, b) => b.currentlyAssigned - a.currentlyAssigned);
  }, [history, agents, fromDate, toDate]);

  const totals = rows.reduce((acc, r) => ({
    currentlyAssigned: acc.currentlyAssigned + r.currentlyAssigned,
    resolved: acc.resolved + r.resolved,
  }), { currentlyAssigned: 0, resolved: 0 });

  return (
    <div className="overviewPanel">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Assignments</h1>
          <p className="pageSubtitle">Who's currently holding what, and resolution throughput per agent.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="srOnly" htmlFor="assign-from">Resolved from</label>
          <input id="assign-from" type="date" className="field" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <span style={{ color: 'var(--fg-muted)' }}>to</span>
          <label className="srOnly" htmlFor="assign-to">Resolved to</label>
          <input id="assign-to" type="date" className="field" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>

      {error && <div className="banner bannerError" role="alert">{error}</div>}

      <div className="card">
        {history === null ? (
          <div className="emptyState"><span className="emptyEmoji">⏳</span><div className="emptyTitle">Loading…</div></div>
        ) : rows.length === 0 ? (
          <div className="emptyState">
            <span className="emptyEmoji">📭</span>
            <div className="emptyTitle">No assignment history yet</div>
            <div className="emptyDesc">Assign an order from the queue to start building this.</div>
          </div>
        ) : (
          <table className="overviewTable">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="thNum">Currently Assigned</th>
                <th className="thNum">Resolved{(fromDate || toDate) ? ' (range)' : ''}</th>
                <th className="thNum">Avg Time to Resolve</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email}>
                  <td><strong>{r.name}</strong></td>
                  <td className="thNum">{r.currentlyAssigned}</td>
                  <td className="thNum">{r.resolved}</td>
                  <td className="thNum">{fmtMinutes(r.avgResolveMinutes)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td>Team Total</td>
                <td className="thNum">{totals.currentlyAssigned}</td>
                <td className="thNum">{totals.resolved}</td>
                <td className="thNum">—</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify in the browser**

Assign a couple of queue rows to different agents, resolve one of them, then open "Assignments" as an admin.
Expected: the resolved agent shows `Currently Assigned` decremented and `Resolved` incremented with a real (non-`—`) average resolve time; an agent with only a live (unresolved) assignment shows up with `Currently Assigned: 1`, `Resolved: 0`. Set the date range to exclude today and confirm the `Resolved` column drops to 0 for everyone (proves the client-side date filter is actually applied to `resolvedAt`, not just displayed).

- [ ] **Step 3: Commit**

```bash
git add app/escalation/AssignmentsPanel.js
git commit -m "feat: add Escalation's Assignments screen with per-agent resolution history"
```

---

## Task 8: Visual polish — stat-card icons, sticky header, row density, sidebar active state

**Files:**
- Modify: `NDR Calling/styles/globals.css` (source of truth per `escalation.css`'s own header comment)
- Modify: `app/escalation/escalation.css` (regenerated, not hand-edited, from the above — see Step 4)
- Modify: `app/escalation/EscalationClient.js` (stat-card icon props, row-density toggle state/markup)

**Interfaces:** none new — this task only changes presentation of existing data.

- [ ] **Step 1: Unify stat-card icons onto the existing SVG `Icon` set**

Every `<StatCard icon="...">` call currently passes a raw emoji string (`OverviewPanel`, `EscalationClient.js:182-189`; the queue view's stat cards, `EscalationClient.js:1509-1512`). `StatCard` itself (`EscalationClient.js:355-366`) just renders `{icon}` directly inside `.statCardIcon` — it doesn't care whether that's a string or an element, so no change is needed to `StatCard` itself, only to what's passed in.

Replace (`EscalationClient.js:182-189`, inside `OverviewPanel`):

```jsx
        <StatCard variant="assigned" icon="📊" value={loading ? null : assignedTotal}
          label="Assigned Orders" sub={`${agents.length} active agents`} />
        <StatCard variant="resolved" icon="✅" value={resolvedCount}
          label="Resolved" sub="This session" />
        <StatCard variant="pending" icon="🚨" value={loading ? null : priority.high}
          label="High Priority" sub="Needs attention" />
        <StatCard variant="unassigned" icon="⚠️" value={loading ? null : escalations}
          label="Escalations" sub={`${Object.keys(tagCounts).length} tags active`} />
```

with:

```jsx
        <StatCard variant="assigned" icon={<Icon path={I.users} size={16} />} value={loading ? null : assignedTotal}
          label="Assigned Orders" sub={`${agents.length} active agents`} />
        <StatCard variant="resolved" icon={<Icon path={I.check} size={16} />} value={resolvedCount}
          label="Resolved" sub="This session" />
        <StatCard variant="pending" icon={<Icon path={I.alert} size={16} />} value={loading ? null : priority.high}
          label="High Priority" sub="Needs attention" />
        <StatCard variant="unassigned" icon={<Icon path={I.flag} size={16} />} value={loading ? null : escalations}
          label="Escalations" sub={`${Object.keys(tagCounts).length} tags active`} />
```

Replace (`EscalationClient.js:1509-1512`, in the queue view):

```jsx
            <StatCard variant="pending"    icon="🚨" value={loading ? null : totalPending}    label="Total Pending"   sub="Needs resolution" />
            <StatCard variant="unassigned" icon="⏳" value={loading ? null : unassignedCount} label="Unassigned"      sub="No agent yet" />
            <StatCard variant="assigned"   icon="👤" value={loading ? null : assignedCount}   label="Assigned"        sub="In progress" />
            <StatCard variant="resolved"   icon="✅" value={resolvedCount}                    label="Resolved"        sub="This session" />
```

with:

```jsx
            <StatCard variant="pending"    icon={<Icon path={I.alert} size={16} />} value={loading ? null : totalPending}    label="Total Pending"   sub="Needs resolution" />
            <StatCard variant="unassigned" icon={<Icon path={I.chevDown} size={16} />} value={loading ? null : unassignedCount} label="Unassigned"      sub="No agent yet" />
            <StatCard variant="assigned"   icon={<Icon path={I.users} size={16} />} value={loading ? null : assignedCount}   label="Assigned"        sub="In progress" />
            <StatCard variant="resolved"   icon={<Icon path={I.check} size={16} />} value={resolvedCount}                    label="Resolved"        sub="This session" />
```

(`I.chevDown` for "Unassigned" is a deliberately neutral/waiting glyph — there's no existing hourglass path in the `I` map and adding a brand-new SVG path for one icon isn't worth it; reuse an existing one rather than growing the icon set for a single spot.)

- [ ] **Step 2: Sticky table header on the queue table**

In `NDR Calling/styles/globals.css`, find the rule block for `.tableWrap table thead` (or add one immediately after the existing `.tableWrap` rules if no `thead`-specific rule exists yet — search the file for `.tableWrap` to find the right spot). Add:

```css
.tableWrap {
  max-height: 70vh;
  overflow-y: auto;
}
.tableWrap table thead th {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg-elevated);
}
```

(`.tableWrap` already exists as the table's scroll container per `EscalationClient.js:1609`; giving it a bounded height + `overflow-y: auto` is what makes "sticky" have anything to stick against — without a scrolling ancestor, `position: sticky` on `<th>` does nothing.)

- [ ] **Step 3: Row-density toggle**

In `EscalationClient.js`, inside the main component, add state near the other pagination state (after `const [pageSize, setPageSize] = useState(25);`):

```js
  const [rowDensity, setRowDensity] = useState(() => {
    try { return localStorage.getItem('escalation_row_density') || 'comfortable'; } catch { return 'comfortable'; }
  });
  useEffect(() => {
    try { localStorage.setItem('escalation_row_density', rowDensity); } catch {}
  }, [rowDensity]);
```

Add a toggle button next to the existing "Download CSV"/"Upload CSV"/"Auto-Assign" buttons in the queue view's page header (right after the `livePill` div, still inside that same flex container, `EscalationClient.js:1487-1490`):

```jsx
              <button
                type="button"
                className="btn btnSecondary"
                onClick={() => setRowDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
                title="Toggle row density"
                style={{ fontSize: 12 }}
              >
                {rowDensity === 'compact' ? 'Comfortable rows' : 'Compact rows'}
              </button>
```

Apply the density as a class on the table wrapper (`EscalationClient.js:1609`):

```jsx
                <div className="tableWrap">
```

becomes:

```jsx
                <div className={`tableWrap${rowDensity === 'compact' ? ' tableWrap--compact' : ''}`}>
```

In `NDR Calling/styles/globals.css`, add (near the other `.tableWrap`/table rules):

```css
.tableWrap--compact td, .tableWrap--compact th {
  padding-top: 4px;
  padding-bottom: 4px;
}
```

- [ ] **Step 4: Sidebar active-item affordance**

In `NDR Calling/styles/globals.css`, find `.navItem.active` (search for `navItem`). Strengthen it — e.g., if it currently only changes background/color, add a left accent bar so the active view is unmistakable at a glance:

```css
.navItem.active {
  position: relative;
}
.navItem.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}
```

(Adjust `top`/`bottom` insets to match the existing `.navItem` padding if the file's actual rule uses different spacing — check the real current CSS for `.navItem` padding before finalizing these two values.)

- [ ] **Step 5: Regenerate the scoped stylesheet**

Run: `node scripts/scope_escalation_css.js "NDR Calling/styles/globals.css" app/escalation/escalation.css`
Expected: exits 0, and `git diff app/escalation/escalation.css` shows the same rules just added above, now prefixed under `.escalation-page` with `esc-`-prefixed keyframes (per that script's documented behavior — do not hand-edit `escalation.css` directly, per its own header comment).

- [ ] **Step 6: Verify in the browser**

Reload `/escalation`. Confirm: stat cards show crisp SVG icons matching the rest of the page's icon language (not emoji); scrolling a long queue table keeps the header row pinned; the row-density button visibly tightens/loosens row spacing; the active sidebar item has a clear accent bar.

- [ ] **Step 7: Commit**

```bash
git add "NDR Calling/styles/globals.css" app/escalation/escalation.css app/escalation/EscalationClient.js
git commit -m "style: unify Escalation's stat-card icons, add sticky header, row density, sidebar active accent"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (identity) → Tasks 3-4. Section 2 (Agent Management) → Tasks 2 (backend), 5. Section 3 (Settings) → Task 6. Section 4 (Assignments + durable history) → Tasks 1, 2, 7. Section 5 (visual polish) → Task 8. Every spec section has at least one task.
- **Type/shape consistency checked:** `agent.email` (not `.id`) and `initials(name)` (not `.avatar`) used consistently across Tasks 2-7 wherever an agent is rendered or matched. `assignment` shape is `{ agentId }` everywhere after Task 2/4 (no lingering `agentName` field expected anywhere). `parentOrder` is threaded through every client call that reaches `assign`/`update`/`bulk-update` (Task 4 Steps 3-4), matching the server's new requirement (Task 2 Steps 3-4).
- **No placeholders:** every step above has real code, real file:line anchors, and a concrete expected verification result.
- **Sequencing:** Task 1 before Task 2 (Task 2 imports Task 1's functions) before Tasks 3-4 (client needs the backend's real shapes) before Tasks 5-7 (new screens need the session/agents wiring from Tasks 3-4) before Task 8 (polish, independent of the rest, placed last since it's purely cosmetic and touches the shared generated CSS file).
