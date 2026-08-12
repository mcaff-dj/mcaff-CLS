# NDR Roster Latest-NDR-Reason Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-agent "Latest NDR Reason" hard filter to NDR Calling's Team Roster, the same shape as the existing `attemptCountFilter` ("Attempts" column), so admins can restrict an agent to leads whose latest NDR reason matches a free-text list.

**Architecture:** One new nullable TEXT column (`ndr_reason_filter`) on the existing `calling_agent_process` table, threaded through the same three layers `attempt_count_filter` already uses: `api/_lib/db.js` (schema + persistence) → `api/admin/[action].js` (route whitelist) → `app/ndr-calling/NdrCallingClient.js` (roster UI column + client-side predicted-assignment preview) → `scripts/assign_ndr_leads.py` (the actual cron that assigns leads). Match semantics: comma-separated substrings, case-insensitive `include` check against a lead's `latestNdrReason`; empty/unset = unrestricted (fail open, same contract as the attempt filter).

**Tech Stack:** Next.js/React (JS, no TypeScript), Postgres via the `pgSql` tagged-template helper in `api/_lib/db.js`, plain Python 3 (`scripts/assign_ndr_leads.py`, no test framework in this repo).

## Global Constraints

- No new dependencies, no new shared UI primitive — reuse a plain `<input type="text">`, not a new tag-input component (per the approved design spec).
- Storage contract: omitted field = leave existing value alone; `''` = explicit "clear the filter" (distinct from omitted) — same as `attempt_count_filter`'s existing contract in `api/_lib/db.js`.
- This repo has no test runner configured (no jest/pytest in `package.json`/no pytest.ini). Verification steps below run pure functions directly via `node -e` / `python -c` — no DB, no dev server, no deploy (per project convention: never run scripts against the real DB or dev server; the user verifies live behavior themselves).
- Brand and Payment Mode are explicitly out of scope (no data source yet) — do not add them.

---

### Task 1: Postgres schema + persistence (`api/_lib/db.js`)

**Files:**
- Modify: `api/_lib/db.js:394` (add `ALTER TABLE` line, mirroring the `attempt_count_filter` one directly above it)
- Modify: `api/_lib/db.js:1332-1355` (`getCallingProcessAgents` — SELECT + per-agent mapping)
- Modify: `api/_lib/db.js:1360-1418` (`setCallingProcessAgent` — param, validation/text-coercion, INSERT + ON CONFLICT UPDATE)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getCallingProcessAgents(processKey)` rows now include `ndrReasonFilter: string` (comma-separated, `''` if unset). `setCallingProcessAgent(processKey, email, { ..., ndrReasonFilter }, updatedBy)` accepts `ndrReasonFilter` as a new optional patch field with the same undefined/''/value tri-state as `attemptCountFilter`. Later tasks (API route, UI) rely on exactly this field name and tri-state contract.

- [ ] **Step 1: Add the column migration**

Insert immediately after the existing `attempt_count_filter` migration line:

```js
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS attempt_count_filter TEXT`;
  // Hard filter on a lead's Latest NDR Reason (NDR Calling only) - same "'' = no restriction"
  // contract as attempt_count_filter above, but free-text substrings instead of a fixed bucket
  // list, since courier NDR-reason strings aren't a small enumerable set. See
  // scripts/assign_ndr_leads.py's agent_reason_filter - a lead whose reason no online agent's
  // filter matches is left unassigned rather than forced onto someone.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS ndr_reason_filter TEXT`;
```

- [ ] **Step 2: Read it back in `getCallingProcessAgents`**

In the `SELECT` (currently `SELECT email, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons, reassign_payment_mode, attempt_count_filter, updated_at, updated_by`), add `ndr_reason_filter`:

```js
  const { rows: state } = await pgSql`
    SELECT email, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons,
           reassign_payment_mode, attempt_count_filter, ndr_reason_filter, updated_at, updated_by
    FROM calling_agent_process WHERE process_key = ${processKey}
  `;
```

And in the `members.map(...)` return object, add the field right after `attemptCountFilter`:

```js
      attemptCountFilter: (s && s.attempt_count_filter) || '',
      ndrReasonFilter: (s && s.ndr_reason_filter) || '',
```

- [ ] **Step 3: Accept and persist it in `setCallingProcessAgent`**

Add `ndrReasonFilter` to the destructured params:

```js
async function setCallingProcessAgent(processKey, email, { status, maxQuota, isProcessAdmin, prepaidPct, priorityRtoReasons, reassignPaymentMode, attemptCountFilter, ndrReasonFilter } = {}, updatedBy) {
```

Right after `attemptFilterText` is computed, add the same tri-state coercion:

```js
  const attemptFilterText = attemptCountFilter === undefined ? null : String(attemptCountFilter || '').trim();
  // Same "'' is a real, distinct-from-NULL value" contract as attemptFilterText above.
  const ndrReasonFilterText = ndrReasonFilter === undefined ? null : String(ndrReasonFilter || '').trim();
```

Add the column to both the `INSERT` column/value lists and the `ON CONFLICT DO UPDATE SET` clause:

```js
  await pgSql`
    INSERT INTO calling_agent_process (email, process_key, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons, reassign_payment_mode, attempt_count_filter, ndr_reason_filter, updated_at, updated_by)
    VALUES (${key}, ${processKey}, ${status || 'Offline'}, ${quota}, ${adminFlag === null ? false : adminFlag}, ${prepaidTarget}, ${reasonsText || ''}, ${reassignModeText || ''}, ${attemptFilterText || ''}, ${ndrReasonFilterText || ''}, now(), ${updatedBy || null})
    ON CONFLICT (email, process_key) DO UPDATE
      SET status = COALESCE(${status || null}, calling_agent_process.status),
          max_quota = COALESCE(${quota}, calling_agent_process.max_quota),
          is_process_admin = COALESCE(${adminFlag}, calling_agent_process.is_process_admin),
          prepaid_pct = COALESCE(${prepaidTarget}, calling_agent_process.prepaid_pct),
          priority_rto_reasons = COALESCE(${reasonsText}, calling_agent_process.priority_rto_reasons),
          reassign_payment_mode = COALESCE(${reassignModeText}, calling_agent_process.reassign_payment_mode),
          attempt_count_filter = COALESCE(${attemptFilterText}, calling_agent_process.attempt_count_filter),
          ndr_reason_filter = COALESCE(${ndrReasonFilterText}, calling_agent_process.ndr_reason_filter),
          updated_at = now(),
          updated_by = ${updatedBy || null}
  `;
```

- [ ] **Step 4: Verify by inspection (no DB access in this task)**

This task is a direct structural mirror of `attempt_count_filter`'s three existing call sites — same tri-state coercion, same COALESCE shape, only the field/column name differs. Confirm by re-reading the diff that every place `attempt_count_filter`/`attemptCountFilter`/`attemptFilterText` appears in the three touched spots now has a matching `ndr_reason_filter`/`ndrReasonFilter`/`ndrReasonFilterText` line. Do not run this against the real database (project convention — the user applies/verifies migrations themselves).

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(ndr): add ndr_reason_filter column + persistence"
```

---

### Task 2: API route passthrough (`api/admin/[action].js`)

**Files:**
- Modify: `api/admin/[action].js:15-17` (doc comment)
- Modify: `api/admin/[action].js:317-322` (`setCallingProcessAgent` call inside `handleCallingAgents`)

**Interfaces:**
- Consumes: `setCallingProcessAgent(processKey, email, patch, updatedBy)` from Task 1 — `patch` now accepts `ndrReasonFilter`.
- Produces: `POST /api/admin/calling-agents` now accepts an `ndrReasonFilter` body field. Task 3's `saveProcessAgent(email, { ndrReasonFilter })` call relies on this being forwarded.

- [ ] **Step 1: Update the doc comment**

```js
//   POST   /api/admin/calling-agents  -> { processKey, email, status?, maxQuota?, prepaidPct?,
//                                          priorityRtoReasons?, reassignPaymentMode?,
//                                          attemptCountFilter?, ndrReasonFilter? }
```

- [ ] **Step 2: Forward the field**

```js
      const agents = await setCallingProcessAgent(
        body.processKey, body.email,
        {
          status: body.status, maxQuota: body.maxQuota, isProcessAdmin: body.isProcessAdmin,
          prepaidPct: body.prepaidPct, priorityRtoReasons: body.priorityRtoReasons,
          reassignPaymentMode: body.reassignPaymentMode,
          attemptCountFilter: body.attemptCountFilter,
          ndrReasonFilter: body.ndrReasonFilter,
        },
        session.email,
      );
```

- [ ] **Step 3: Verify by inspection**

No branching logic added — this is a straight passthrough field, same as its four neighbors. Confirm the field name matches Task 1's destructured param exactly (`ndrReasonFilter`, not `ndrReasonsFilter`/`ndrReasonFilter_`/etc.) by grepping: `grep -n "ndrReasonFilter" api/_lib/db.js api/admin/[action].js` should show it in both files with identical spelling.

- [ ] **Step 4: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "feat(ndr): forward ndrReasonFilter through calling-agents route"
```

---

### Task 3: Roster UI column + predicted-assignment preview (`app/ndr-calling/NdrCallingClient.js`)

**Files:**
- Modify: `app/ndr-calling/NdrCallingClient.js:416-424` (`ndrPredicted` useMemo — `onlineAgents` mapping + `covers`)
- Modify: `app/ndr-calling/NdrCallingClient.js:487-573` (`renderNdrRosterTable` — new column)

**Interfaces:**
- Consumes: `a.ndrReasonFilter` (string, comma-separated) from `processAgents` rows (Task 1's `getCallingProcessAgents` shape). `saveProcessAgent(email, patch)` (existing, from `useCallingSession`) — patch now may include `{ ndrReasonFilter: string }`.
- Produces: none consumed by later tasks — Task 4 (Python) is an independent mirror of the same match semantics, not a caller of this JS.

- [ ] **Step 1: Extend the predicted-assignment `covers` check**

Currently (`ndrPredicted` useMemo):

```js
  const ndrPredicted = useMemo(() => {
    const onlineAgents = (processAgents || [])
      .filter(a => a.status === 'Online')
      .map(a => ({
        email: a.email,
        quota: a.maxQuota != null ? a.maxQuota : 20, // DEFAULT_QUOTA in assign_ndr_leads.py
        filter: (a.attemptCountFilter || '').split(',').map(s => s.trim()).filter(Boolean),
      }));
    if (!onlineAgents.length) return { rows: [], onlineAgents: [] };
```

Change to also carry the reason filter, and later in the same useMemo, `covers` (currently `const covers = (agent, bucket) => !agent.filter.length || bucket === null || agent.filter.includes(bucket);`) gains a reason argument:

```js
  const ndrPredicted = useMemo(() => {
    const onlineAgents = (processAgents || [])
      .filter(a => a.status === 'Online')
      .map(a => ({
        email: a.email,
        quota: a.maxQuota != null ? a.maxQuota : 20, // DEFAULT_QUOTA in assign_ndr_leads.py
        filter: (a.attemptCountFilter || '').split(',').map(s => s.trim()).filter(Boolean),
        // Free-text substrings, case-insensitive - mirrors scripts/assign_ndr_leads.py's
        // agent_reason_filter/_reason_covers exactly (see that script for the canonical version).
        reasonFilter: (a.ndrReasonFilter || '').split(',').map(s => s.trim()).filter(Boolean),
      }));
    if (!onlineAgents.length) return { rows: [], onlineAgents: [] };
```

Then update `covers` (a few lines below, currently `const covers = (agent, bucket) => !agent.filter.length || bucket === null || agent.filter.includes(bucket);`) to also gate on reason:

```js
    const covers = (agent, bucket) => !agent.filter.length || bucket === null || agent.filter.includes(bucket);
    // Case-insensitive substring match against the lead's own latestNdrReason - an agent with
    // no reasonFilter values is unrestricted (fail open), same contract as the attempt bucket
    // check above.
    const reasonCovers = (agent, latestNdrReason) => {
      if (!agent.reasonFilter.length) return true;
      const reason = (latestNdrReason || '').toLowerCase();
      return agent.reasonFilter.some(r => reason.includes(r.toLowerCase()));
    };
```

Finally, find where `covers(remaining[cand], t.bucket)` is called inside the assignment loop (`for (let step = 0; step < n; step++) { const cand = ...; if (covers(remaining[cand], t.bucket)) { chosen = cand; break; } }`) and change it to also check the reason:

```js
        if (covers(remaining[cand], t.bucket) && reasonCovers(remaining[cand], t.latestNdrReason)) { chosen = cand; break; }
```

- [ ] **Step 2: Verify the pure matching logic directly (no DB/dev server)**

Run this via Bash to check `reasonCovers`'s exact semantics before wiring it into the component (it's a plain function with no React/DOM dependency, so it runs standalone under plain Node):

```bash
node -e "
const reasonCovers = (agent, latestNdrReason) => {
  if (!agent.reasonFilter.length) return true;
  const reason = (latestNdrReason || '').toLowerCase();
  return agent.reasonFilter.some(r => reason.includes(r.toLowerCase()));
};
const assert = require('assert');
assert.strictEqual(reasonCovers({ reasonFilter: [] }, 'Customer not available'), true, 'no filter = unrestricted');
assert.strictEqual(reasonCovers({ reasonFilter: ['customer not available'] }, 'Customer Not Available - called twice'), true, 'case-insensitive substring match');
assert.strictEqual(reasonCovers({ reasonFilter: ['address issue'] }, 'Customer not available'), false, 'non-matching reason excluded');
assert.strictEqual(reasonCovers({ reasonFilter: ['address issue'] }, ''), true, 'blank reason fails open (unrestricted)');
console.log('reasonCovers: all assertions passed');
"
```

Expected output: `reasonCovers: all assertions passed`

- [ ] **Step 3: Add the roster column**

In `renderNdrRosterTable`, add a table header after the existing Attempts `<th>` (currently `<th ... title="Hard filter: restricts this agent to leads whose delivery-attempt count falls in the selected bucket(s). No selection = unrestricted.">Attempts</th>`):

```jsx
                <th className="py-3 px-4 text-left font-medium" title="Hard filter: restricts this agent to leads whose Latest NDR Reason contains any of these (case-insensitive), comma-separated. No text = unrestricted.">Latest NDR Reason</th>
```

Bump the empty-state `colSpan` from `5` to `6` (the `<td colSpan={5} ...>No one invited...` row).

Add a matching `<td>` after the Attempts `<td>` (the one containing `<MultiSelectDropdown ... options={NDR_ATTEMPT_FILTER_OPTIONS} />`). This needs local draft state per row since it's a free-text input saved on blur, not an immediate-commit select — add a small helper component right above `renderNdrRosterTable`:

```jsx
  // Free-text hard filter, save-on-blur (unlike the Attempts MultiSelectDropdown, there's no
  // fixed option list to pick from - courier NDR-reason strings aren't a small enumerable set).
  // Local draft state so typing doesn't fire a save per keystroke; commits only on blur, and
  // only if the value actually changed.
  const NdrReasonFilterInput = ({ value, onSave }) => {
    const [draft, setDraft] = useState(value || '');
    useEffect(() => { setDraft(value || ''); }, [value]);
    return (
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft !== (value || '')) onSave(draft); }}
        placeholder="e.g. Customer not available, Address issue"
        className="w-56 h-8 px-3 py-1 bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 rounded-lg text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
      />
    );
  };
```

Then in the row markup:

```jsx
                    <td className="py-3 px-4">
                      <NdrReasonFilterInput
                        value={a.ndrReasonFilter}
                        onSave={(next) => saveProcessAgent(a.email, { ndrReasonFilter: next })}
                      />
                    </td>
```

- [ ] **Step 4: Verify by inspection**

Read back `renderNdrRosterTable` end to end and confirm: header count matches cell count per row (6 `<th>`, 6 `<td>` per data row), `colSpan` on the empty-state row is `6`, and `NdrReasonFilterInput` is declared before `renderNdrRosterTable` uses it (both are inside the same component function, so declaration order only matters if one is called during the other's render — confirm `NdrReasonFilterInput` is defined above the `const renderNdrRosterTable = () => {...}` line).

- [ ] **Step 5: Commit**

```bash
git add app/ndr-calling/NdrCallingClient.js
git commit -m "feat(ndr): Latest NDR Reason hard-filter column on Team Roster"
```

---

### Task 4: Cron enforcement (`scripts/assign_ndr_leads.py`)

**Files:**
- Modify: `scripts/assign_ndr_leads.py:31-42` (column constants)
- Modify: `scripts/assign_ndr_leads.py:50-61` (near `attempt_bucket` — add `reason_covers`)
- Modify: `scripts/assign_ndr_leads.py:74-126` (`fetch_online_ndr_agents`)
- Modify: `scripts/assign_ndr_leads.py:160-240` (`main` — read the reason column, apply the gate)

**Interfaces:**
- Consumes: `ndr_reason_filter` column from Task 1 (read directly via `cur.execute`, not through any JS interface).
- Produces: nothing consumed by other tasks — this is the actual enforcement point; Task 3's JS `reasonCovers` is a preview of this same behavior, not a dependency.

- [ ] **Step 1: Add the sheet column constant**

```python
COL_ATTEMPTS = 14                # O - Attempt Count
COL_LATEST_NDR_DATE = 15         # P - "DD-MM-YYYY", the round-robin's oldest-first sort key
COL_LATEST_NDR_REASON = 16       # Q - free-text courier NDR reason, matched by agent_reason_filter
COL_AGENT = 18                   # S - Agent Name - the only column this script writes
```

(Insert the new `COL_LATEST_NDR_REASON` line between the existing `COL_LATEST_NDR_DATE` and `COL_AGENT` lines — `COL_AGENT`'s own line and everything below it is unchanged.)

- [ ] **Step 2: Add `reason_covers` next to `attempt_bucket`**

```python
def reason_covers(filt, latest_ndr_reason):
    """True if this agent's reason filter (a list of substrings, already lowercased) allows a
    lead with this Latest NDR Reason - empty filter list = unrestricted (fails open), same
    contract as attempt_bucket's ATTEMPT_BUCKETS check below."""
    if not filt:
        return True
    reason = str(latest_ndr_reason or "").lower()
    return any(r in reason for r in filt)
```

- [ ] **Step 3: Verify `reason_covers` standalone (no DB/sheets)**

```bash
python -c "
def reason_covers(filt, latest_ndr_reason):
    if not filt:
        return True
    reason = str(latest_ndr_reason or '').lower()
    return any(r in reason for r in filt)

assert reason_covers([], 'Customer not available') is True, 'no filter = unrestricted'
assert reason_covers(['customer not available'], 'Customer Not Available - called twice') is True, 'case-insensitive substring match'
assert reason_covers(['address issue'], 'Customer not available') is False, 'non-matching reason excluded'
assert reason_covers(['address issue'], '') is True, 'blank reason fails open'
print('reason_covers: all assertions passed')
"
```

Expected output: `reason_covers: all assertions passed`

- [ ] **Step 4: Read the new filter column in `fetch_online_ndr_agents`**

Change the `SELECT` and the tuple-unpacking loop to also carry `ndr_reason_filter`:

```python
            try:
                cur.execute(
                    "SELECT email, status, max_quota, attempt_count_filter, ndr_reason_filter "
                    "FROM calling_agent_process WHERE process_key = %s",
                    (PROCESS_KEY,),
                )
                per_process = cur.fetchall()
            except Exception as e:
                print(f"  (calling_agent_process unavailable: {e} - using global presence)")
                return sorted(present), {}, {}, {}

    if not per_process:
        print(f"  no per-process availability set for '{PROCESS_KEY}' - using global presence")
        return sorted(present), {}, {}, {}

    online_for_process = {e.lower() for e, status, _, _, _ in per_process if status == "Online"}
    quotas = {e.lower(): q for e, _, q, _, _ in per_process if q is not None}
    attempt_filters = {}
    reason_filters = {}
    for e, _, _, filt, reason_filt in per_process:
        buckets = [b.strip() for b in (filt or "").split(",") if b.strip()]
        if buckets:
            attempt_filters[e.lower()] = buckets
        reasons = [r.strip().lower() for r in (reason_filt or "").split(",") if r.strip()]
        if reasons:
            reason_filters[e.lower()] = reasons
    eligible = sorted(online_for_process & present)
    if online_for_process and not eligible:
        print(f"  {len(online_for_process)} agent(s) marked Online for '{PROCESS_KEY}', but "
              f"none are heartbeat-fresh (within {STALE_MINUTES}m) - nobody is actually at "
              f"their desk.")
    return eligible, quotas, attempt_filters, reason_filters
```

Also update the function's docstring line about the return shape and update its `return [], {}, {}` early-exit (no `POSTGRES_URL`) to `return [], {}, {}, {}`.

- [ ] **Step 5: Thread the new return value through `main`**

```python
    online_agents, quotas, attempt_filters, reason_filters = fetch_online_ndr_agents()
```

In the row-scan loop, also read the reason column:

```python
        else:
            latest_ndr_date = parse_latest_ndr_date(row[COL_LATEST_NDR_DATE] if len(row) > COL_LATEST_NDR_DATE else "")
            bucket = attempt_bucket(row[COL_ATTEMPTS] if len(row) > COL_ATTEMPTS else "")
            reason = row[COL_LATEST_NDR_REASON] if len(row) > COL_LATEST_NDR_REASON else ""
            awb = row[COL_AWB] if len(row) > COL_AWB else ""
            if awb:
                unassigned.append((i + 2, latest_ndr_date, bucket, reason, awb))
```

Update the sort/unpack to carry `reason` through (the tuple grew by one element, so every place that unpacks `unassigned` tuples must add it):

```python
    unassigned.sort(key=lambda t: t[1] if t[1] is not None else EPOCH_MAX)
    ...
    def _covers(email, bucket):
        filt = attempt_filters.get(email)
        return not filt or bucket is None or bucket in filt

    ...
    for row_num, _, bucket, reason, awb in unassigned:
        if not remaining_agents:
            break
        n = len(remaining_agents)
        chosen = None
        for step in range(n):
            cand_idx = (idx + step) % n
            candidate = remaining_agents[cand_idx]
            if _covers(candidate, bucket) and reason_covers(reason_filters.get(candidate), reason):
                chosen = cand_idx
                break
```

Update the "nothing could be assigned" print message to mention reason too (currently `"...no online agent's attempt filter covers them)..."`):

```python
        print(f"{len(unassigned)} unassigned lead(s) found, but none could be assigned "
              f"(quota exhausted, or no online agent's attempt/reason filter covers them). "
              f"Nothing to assign.")
```

- [ ] **Step 6: Verify by inspection**

`unassigned` tuples grew from 4 elements (`row_num, latest_ndr_date, bucket, awb`) to 5 (`row_num, latest_ndr_date, bucket, reason, awb`) — grep every place `unassigned.append(` and `for row_num,` appear in this file and confirm both are updated consistently (a tuple-arity mismatch here is a silent `ValueError: too many values to unpack` at runtime, not a type error caught earlier). Confirm `fetch_online_ndr_agents`'s three return statements (`return [], {}, {}`× the no-`POSTGRES_URL` early exit, `return sorted(present), {}, {}` × the no-per-process-rows case, and the calling_agent_process-unavailable except branch) all now return 4 values, not 3.

- [ ] **Step 7: Commit**

```bash
git add scripts/assign_ndr_leads.py
git commit -m "feat(ndr): enforce Latest NDR Reason filter in the assignment cron"
```

---

## Self-Review Notes

- **Spec coverage:** Storage/persistence (Task 1) ✓, API passthrough (Task 2) ✓, roster UI column + predicted preview (Task 3) ✓, cron enforcement (Task 4) ✓. Brand/Payment Mode explicitly excluded per spec's "Out of scope" section — no task touches them.
- **Type consistency:** `ndrReasonFilter` (JS/API/DB-JS-side) and `ndr_reason_filter` (DB column/Python) are used consistently across all four tasks — verified by name against Task 1's own definitions before writing Tasks 2-4.
- **No placeholders:** every step has literal, complete code — none of it depends on values invented ad hoc (e.g., column letter Q for `latestNdrReason` was confirmed from the existing `mapNdrRow`/`COL_LATEST_NDR_DATE`/`COL_AGENT` constants already in the two files, not guessed).
