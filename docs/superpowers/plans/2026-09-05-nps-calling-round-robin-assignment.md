# NPS-Calling Auto-Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace NPS-Calling's (detractor process) manual "Pull Next Lead" button with two agent-scoped auto-assign triggers: going Online batch-fills an agent to quota, and disposing a lead self-refills that one freed slot.

**Architecture:** A new `assignDetractorLeadsToAgent(email, maxCount)` in `api/_lib/db.js` loops the existing per-lead claim query up to `maxCount` times. It's called inline (no cron, no Lambda, no Python — NPS-Calling is pure MySQL with no Sheet/GoKwik dependency to justify either) from two existing API handlers: `api/auth/[action].js`'s `handleProcessPresence` (on going Online) and `api/detractor/lead-assignment.js` (on disposal). The manual pull endpoint and button are removed.

**Tech Stack:** Node.js (CommonJS), MySQL via the existing `sql` tagged-template helper in `api/_lib/db.js`, plain `node assert` self-check tests (no test framework), React (`app/nps-calling/NpsCallingClient.js`).

**Spec:** [docs/superpowers/specs/2026-09-05-nps-calling-round-robin-design.md](../specs/2026-09-05-nps-calling-round-robin-design.md)

## Global Constraints

- No new infrastructure: no cron, no AWS Lambda, no EventBridge, no Python for this process — both triggers are plain inline async calls in existing Node API routes.
- No cross-agent rotation/fairness cursor — every trigger is scoped to one agent's own action (their own presence toggle, their own disposal); RTO's `build_assignment_queue` cursor algorithm is explicitly not ported.
- Lead selection is unchanged: same 30-day recency filter, same admin-set `lead_order` (oldest/newest), same per-brand filter, same best-effort/fail-open sentiment classification on claim.
- Quota/availability chain is unchanged: `calling_agent_process.max_quota` override → `calling_process_settings.default_quota` (`detractor`) → fallback default of 15; availability check is fail-closed (no row or a lookup error = not eligible).
- Disposal self-refill only ever targets the agent who actually held the lead (`originalAgentEmail`) via their own request — an admin disposing a lead on someone else's behalf (`allowAnyAgent` override) does **not** trigger a refill; that agent gets topped up next time they go Online or dispose something themselves.
- Self-refill re-checks availability and quota at refill time, not just at dispose time (the agent may have gone Offline, or an admin may have lowered their quota, in between).

---

### Task 1: `getDetractorQuotaAndLoad` helper + move `FALLBACK_QUOTA`

**Files:**
- Modify: `api/_lib/db.js:1786` (just above `getDetractorAgentAvailability`, alongside the existing `getDetractorAgentQuota`/`getDetractorLoadByAgent` functions)
- Modify: `api/_lib/db.js:5060` (module.exports, detractor block)

**Interfaces:**
- Produces: `async function getDetractorQuotaAndLoad(email)` → `{ quota: number, load: number }`. Used by Task 3 and Task 4.
- Produces: `DETRACTOR_FALLBACK_QUOTA` (const, value `15`) — replaces `api/detractor/next-lead.js`'s own `FALLBACK_QUOTA`, which is deleted in Task 6.

This consolidates the three-call quota chain (`getDetractorAgentQuota` → `getCallingDefaultQuota('detractor')` → fallback) that `api/detractor/next-lead.js` currently owns alone, since Task 3 and Task 4 both need it and `next-lead.js` is being deleted.

- [ ] **Step 1: Add the constant and helper function**

In `api/_lib/db.js`, immediately before the `async function getDetractorAgentQuota(email) {` line (currently line 1770-ish, right after the "NPS-Calling ('detractor' process key) equivalents..." comment block), add:

```js
// Falls back to this only when no admin has ever set calling_process_settings.default_quota for
// 'detractor' (Admin Panel's Default Quota card) - a deliberately conservative starting cap.
// Moved here from the old api/detractor/next-lead.js (now deleted - see the 2026-09-05
// auto-assignment design spec) since both auto-assign trigger points need this chain, not just
// one pull endpoint.
const DETRACTOR_FALLBACK_QUOTA = 15;
```

Then, immediately after the closing brace of `getDetractorLoadByAgent` (the function ending `return Number(rows[0].n) || 0;\n}`), add:

```js

// Consolidates the quota-then-load chain both auto-assign trigger points need: per-agent
// override (calling_agent_process.max_quota) -> admin-set default
// (calling_process_settings.default_quota) -> DETRACTOR_FALLBACK_QUOTA, plus this agent's
// current undisposed load. One definition so api/auth/[action].js's going-Online trigger and
// api/detractor/lead-assignment.js's on-disposal trigger can't drift on the fallback chain.
async function getDetractorQuotaAndLoad(email) {
  const quotaOverride = await getDetractorAgentQuota(email);
  const processDefault = await getCallingDefaultQuota('detractor');
  const quota = quotaOverride != null ? quotaOverride : (processDefault != null ? processDefault : DETRACTOR_FALLBACK_QUOTA);
  const load = await getDetractorLoadByAgent(email);
  return { quota, load };
}
```

- [ ] **Step 2: Export it**

In `api/_lib/db.js`'s `module.exports` block, change:

```js
  getDetractorAgentQuota, getDetractorAgentAvailability, getDetractorLoadByAgent,
  getNextDetractorLead, getUnassignedDetractorLeads, disposeDetractorLead, getDetractorTicketsForAgent, getAllDetractorTickets,
```

to:

```js
  getDetractorAgentQuota, getDetractorAgentAvailability, getDetractorLoadByAgent, getDetractorQuotaAndLoad,
  getNextDetractorLead, getUnassignedDetractorLeads, disposeDetractorLead, getDetractorTicketsForAgent, getAllDetractorTickets,
  assignDetractorLeadsToAgent,
```

(`assignDetractorLeadsToAgent` is added in Task 2 — exporting it here now is fine, it just doesn't exist yet until that task's Step 1 runs. Complete Task 2 immediately after this one, before running anything that imports it.)

- [ ] **Step 3: Sanity-check the file still parses**

Run: `node -e "require('./api/_lib/db.js')"`
Expected: no output, exit code 0 (a syntax error would throw and print a stack trace). This will fail until Task 2's Step 1 adds `assignDetractorLeadsToAgent` — if you're doing Task 1 and Task 2 as separate commits, run this check after Task 2 instead.

- [ ] **Step 4: Commit** (combine with Task 2's commit, since Step 3 above only passes once both exist)

---

### Task 2: `assignDetractorLeadsToAgent` batch-claim loop + test

**Files:**
- Modify: `api/_lib/db.js` (immediately after `getNextDetractorLead`, i.e. after its closing brace at the line `return lead;\n}`)
- Create: `api/_lib/db.detractorAssign.test.js`

**Interfaces:**
- Consumes: `getNextDetractorLead(email)` (existing, unchanged) as the default `claimFn`.
- Produces: `async function assignDetractorLeadsToAgent(email, maxCount, claimFn = getNextDetractorLead)` → `Promise<Array<lead>>`. Used by Task 3 (`maxCount = 1`) and Task 4 (`maxCount = quota - load`).

- [ ] **Step 1: Write the failing test**

Create `api/_lib/db.detractorAssign.test.js`:

```js
// Self-check for assignDetractorLeadsToAgent's loop control (db.js) - pure once claimFn is
// stubbed out, no database involved. Run with `node api/_lib/db.detractorAssign.test.js`.
const assert = require('assert');
const { assignDetractorLeadsToAgent } = require('./db');

(async () => {
  // Stops exactly at maxCount when the pool never runs out.
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { response_id: `L${calls}` }; };
    const claimed = await assignDetractorLeadsToAgent('a@x.com', 3, claimFn);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(claimed.map((c) => c.response_id), ['L1', 'L2', 'L3']);
  }

  // Stops early the moment the pool is exhausted (null) - never calls claimFn again after.
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return calls <= 2 ? { response_id: `L${calls}` } : null; };
    const claimed = await assignDetractorLeadsToAgent('a@x.com', 5, claimFn);
    assert.strictEqual(calls, 3, 'must stop at the first null, not keep calling for the remaining slots');
    assert.strictEqual(claimed.length, 2);
  }

  // maxCount 0 (agent already at/over quota): never calls claimFn at all.
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { response_id: 'L1' }; };
    const claimed = await assignDetractorLeadsToAgent('a@x.com', 0, claimFn);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(claimed, []);
  }

  console.log('db.detractorAssign.test.js: all assertions passed');
})();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node api/_lib/db.detractorAssign.test.js`
Expected: throws, since `assignDetractorLeadsToAgent` doesn't exist yet in `db.js`'s exports (e.g. `TypeError: assignDetractorLeadsToAgent is not a function`).

- [ ] **Step 3: Implement it**

In `api/_lib/db.js`, immediately after `getNextDetractorLead`'s closing brace (the line `return lead;\n}` that ends that function, right before the `// Read-only peek at what getNextDetractorLead would hand out next...` comment), add:

```js

// Claims up to maxCount fresh detractor leads for `email` in a loop, stopping the moment
// getNextDetractorLead returns null (pool exhausted) - the replacement for the removed manual
// pull button, used by both auto-assign trigger points (going-Online batch-fill, on-disposal
// self-refill). claimFn is injectable so db.detractorAssign.test.js can verify the loop's stop
// conditions without a real database.
async function assignDetractorLeadsToAgent(email, maxCount, claimFn = getNextDetractorLead) {
  const claimed = [];
  for (let i = 0; i < maxCount; i++) {
    const lead = await claimFn(email);
    if (!lead) break;
    claimed.push(lead);
  }
  return claimed;
}
```

(The export line for this was already added in Task 1 Step 2.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node api/_lib/db.detractorAssign.test.js`
Expected: prints `db.detractorAssign.test.js: all assertions passed`, exit code 0.

- [ ] **Step 5: Re-run Task 1's sanity check**

Run: `node -e "require('./api/_lib/db.js')"`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add api/_lib/db.js api/_lib/db.detractorAssign.test.js
git commit -m "feat(nps-calling): add getDetractorQuotaAndLoad and assignDetractorLeadsToAgent"
```

---

### Task 3: Wire on-disposal self-refill

**Files:**
- Modify: `api/detractor/lead-assignment.js`

**Interfaces:**
- Consumes: `getDetractorAgentAvailability(email)` (existing), `getDetractorQuotaAndLoad(email)` (Task 1), `assignDetractorLeadsToAgent(email, maxCount)` (Task 2).
- Produces: the endpoint's JSON response gains an `assignedLeads: array` field (was previously just `{ ok: true }`). Consumed by Task 5's client change.

- [ ] **Step 1: Update the imports**

In `api/detractor/lead-assignment.js`, change:

```js
const { disposeDetractorLead, isCallingProcessAdmin, logEvent } = require('../_lib/db');
```

to:

```js
const {
  disposeDetractorLead, isCallingProcessAdmin, logEvent,
  getDetractorAgentAvailability, getDetractorQuotaAndLoad, assignDetractorLeadsToAgent,
} = require('../_lib/db');
```

- [ ] **Step 2: Add the self-refill call after a successful dispose**

Change:

```js
    const { originalAgentEmail } = await disposeDetractorLead(
      responseId, disposition, agentRemarks, connected, attempt, session.email,
      { allowAnyAgent, affectedProducts: Array.isArray(affectedProducts) ? affectedProducts.join(', ') : (affectedProducts || null) },
    );
    if (allowAnyAgent && originalAgentEmail && originalAgentEmail.toLowerCase() !== session.email.toLowerCase()) {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      await logEvent(session.uid, session.email, CARD_KEY, 'detractor-dispose-override',
        `Disposed ${responseId} (assigned to ${originalAgentEmail}) on their behalf`, ip);
    }
    res.status(200).json({ ok: true });
```

to:

```js
    const { originalAgentEmail } = await disposeDetractorLead(
      responseId, disposition, agentRemarks, connected, attempt, session.email,
      { allowAnyAgent, affectedProducts: Array.isArray(affectedProducts) ? affectedProducts.join(', ') : (affectedProducts || null) },
    );
    const isOverrideOntoSomeoneElse = allowAnyAgent && originalAgentEmail
      && originalAgentEmail.toLowerCase() !== session.email.toLowerCase();
    if (isOverrideOntoSomeoneElse) {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      await logEvent(session.uid, session.email, CARD_KEY, 'detractor-dispose-override',
        `Disposed ${responseId} (assigned to ${originalAgentEmail}) on their behalf`, ip);
    }
    // Self-refill: the disposing agent gets their freed slot back immediately, same shape as
    // RTO/NDR's on-disposal top-up - but never for an admin override onto someone ELSE's lead
    // (isOverrideOntoSomeoneElse above), since the disposer isn't the one whose slot opened up.
    // Re-checks availability and quota now, not just whatever they were at dispose time - the
    // agent may have gone Offline, or an admin may have lowered their quota, in between.
    let assignedLeads = [];
    if (!isOverrideOntoSomeoneElse) {
      const stillOnline = (await getDetractorAgentAvailability(session.email)) === 'Online';
      if (stillOnline) {
        const { quota, load } = await getDetractorQuotaAndLoad(session.email);
        if (load < quota) {
          assignedLeads = await assignDetractorLeadsToAgent(session.email, 1);
        }
      }
    }
    res.status(200).json({ ok: true, assignedLeads });
```

- [ ] **Step 3: Sanity-check it parses**

Run: `node -e "require('./api/detractor/lead-assignment.js')"`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add api/detractor/lead-assignment.js
git commit -m "feat(nps-calling): self-refill on disposal instead of manual pull"
```

---

### Task 4: Wire going-Online batch-fill

**Files:**
- Modify: `api/auth/[action].js`

**Interfaces:**
- Consumes: `getDetractorQuotaAndLoad(email)` (Task 1), `assignDetractorLeadsToAgent(email, maxCount)` (Task 2).

- [ ] **Step 1: Update the imports**

In `api/auth/[action].js`, line 4-5, change:

```js
const { CARD_KEYS, CARD_LABELS, getUserByEmail, getUserPermissions, getUserTabPermissions, bootstrapAdminIfNeeded, logEvent, upsertAgentPresence, getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent, isCallingProcessAdmin, resolveCallerTeam, getDeliveryEscalationUserRoleByEmail } = require('../_lib/db');
```

to:

```js
const { CARD_KEYS, CARD_LABELS, getUserByEmail, getUserPermissions, getUserTabPermissions, bootstrapAdminIfNeeded, logEvent, upsertAgentPresence, getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent, isCallingProcessAdmin, resolveCallerTeam, getDeliveryEscalationUserRoleByEmail,
  getDetractorQuotaAndLoad, assignDetractorLeadsToAgent } = require('../_lib/db');
```

- [ ] **Step 2: Add the detractor branch to the Online-trigger chain**

In `handleProcessPresence`, change:

```js
  if (body.status === 'Online' && PROCESS_ASSIGN_LAMBDA[body.processKey]) {
    triggerImmediateLambdaAssignment(PROCESS_ASSIGN_LAMBDA[body.processKey]).catch(() => {});
  } else if (body.status === 'Online' && PROCESS_ASSIGN_WORKFLOW[body.processKey]) {
    triggerImmediateAssignment(PROCESS_ASSIGN_WORKFLOW[body.processKey]).catch(() => {});
  }
  res.status(200).json({ ok: true, processKey: body.processKey, status: body.status });
```

to:

```js
  if (body.status === 'Online' && PROCESS_ASSIGN_LAMBDA[body.processKey]) {
    triggerImmediateLambdaAssignment(PROCESS_ASSIGN_LAMBDA[body.processKey]).catch(() => {});
  } else if (body.status === 'Online' && PROCESS_ASSIGN_WORKFLOW[body.processKey]) {
    triggerImmediateAssignment(PROCESS_ASSIGN_WORKFLOW[body.processKey]).catch(() => {});
  } else if (body.status === 'Online' && body.processKey === 'detractor') {
    // No Sheet, no GoKwik, no cron/Lambda for this process (see the 2026-09-05 auto-assignment
    // design spec) - going Online batch-fills the agent up to quota with a plain inline MySQL
    // call instead, fire-and-forget same as the two branches above so a slow/failed fill never
    // blocks the presence-toggle response the agent is waiting on.
    (async () => {
      try {
        const { quota, load } = await getDetractorQuotaAndLoad(body.email || session.email);
        await assignDetractorLeadsToAgent(session.email, Math.max(0, quota - load));
      } catch (e) {
        console.error('handleProcessPresence: detractor auto-fill failed:', e.message || e);
      }
    })();
  }
  res.status(200).json({ ok: true, processKey: body.processKey, status: body.status });
```

Note: use `session.email` for both calls (there's no `body.email` in this handler — it's always the caller's own row, per `setCallingProcessAgent(body.processKey, session.email, ...)` two lines above). Write it as:

```js
        const { quota, load } = await getDetractorQuotaAndLoad(session.email);
        await assignDetractorLeadsToAgent(session.email, Math.max(0, quota - load));
```

- [ ] **Step 3: Sanity-check it parses**

Run: `node -e "require('./api/auth/[action].js')"`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add "api/auth/[action].js"
git commit -m "feat(nps-calling): auto-fill to quota on going Online"
```

---

### Task 5: Remove the manual pull button, wire self-refill into the UI

**Files:**
- Modify: `app/nps-calling/NpsCallingClient.js`

- [ ] **Step 1: Remove `pulling` state and `pullNextLead`**

Delete these lines (around line 361-376):

```js
  const [pulling, setPulling] = useState(false);
  const pullNextLead = async () => {
    setPulling(true);
    try {
      const r = await fetch('/api/detractor/next-lead', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`⚠️ ${d.error || 'Could not pull a lead'}`); return; }
      if (!d.assigned) { showToast(d.reason || 'No lead available right now.'); return; }
      setTickets((prev) => [{ ...d.lead, agent_email: googleUser?.email, assigned_at: new Date().toISOString() }, ...prev]);
      showToast(`New lead: ${d.lead.customer_name || d.lead.response_id}`);
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setPulling(false);
    }
  };

```

- [ ] **Step 2: Remove the button from `CallingShell`'s `rightSlot`**

Change:

```js
        session={session}
        rightSlot={
          <button
            type="button"
            onClick={pullNextLead}
            disabled={pulling}
            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-[13px] font-bold text-white transition-colors shrink-0"
          >
            {pulling ? 'Pulling…' : '📞 Pull Next Lead'}
          </button>
        }
      />
```

to:

```js
        session={session}
      />
```

- [ ] **Step 3: Update the empty-state copy**

Change (around line 803):

```js
                    {!ticketsLoading && !pendingTickets.length && (
                      <p className="text-[13px] text-zinc-500">No leads in your queue. Click Pull Next Lead above.</p>
                    )}
```

to:

```js
                    {!ticketsLoading && !pendingTickets.length && (
                      <p className="text-[13px] text-zinc-500">No leads in your queue. Go Online to get assigned automatically.</p>
                    )}
```

- [ ] **Step 4: Handle `assignedLeads` in the dispose response**

In `saveDisposition`, change:

```js
      setTickets((prev) => prev.map(patch));
      // detailTkt can be someone else's lead (admin/process-admin override via the All/Fresh
      // Leads tables, not just this agent's own tickets array) - patch allTickets too so the
      // admin table reflects it without a refetch.
      setAllTickets((prev) => (prev ? prev.map(patch) : prev));
      showToast('Disposition saved');
      closeDispose();
```

to:

```js
      setTickets((prev) => prev.map(patch));
      // detailTkt can be someone else's lead (admin/process-admin override via the All/Fresh
      // Leads tables, not just this agent's own tickets array) - patch allTickets too so the
      // admin table reflects it without a refetch.
      setAllTickets((prev) => (prev ? prev.map(patch) : prev));
      // Self-refill (api/detractor/lead-assignment.js): 0 or 1 freshly-claimed lead for THIS
      // agent, replacing the one just disposed. Absent for an admin-override dispose onto
      // someone else's lead - see that endpoint's own isOverrideOntoSomeoneElse check.
      if (Array.isArray(d.assignedLeads) && d.assignedLeads.length) {
        const now = new Date().toISOString();
        setTickets((prev) => [
          ...d.assignedLeads.map((lead) => ({ ...lead, agent_email: googleUser?.email, assigned_at: now })),
          ...prev,
        ]);
        showToast(`Disposition saved. New lead: ${d.assignedLeads[0].customer_name || d.assignedLeads[0].response_id}`);
      } else {
        showToast('Disposition saved');
      }
      closeDispose();
```

- [ ] **Step 5: Update the stale `FALLBACK_QUOTA` comment**

Change (around line 17-18):

```js
// Keep in sync with api/detractor/next-lead.js's own FALLBACK_QUOTA - shown in the admin card so
```

to:

```js
// Keep in sync with api/_lib/db.js's own DETRACTOR_FALLBACK_QUOTA - shown in the admin card so
```

- [ ] **Step 6: Manual check (no live test/deploy — user verifies in browser per their own workflow)**

Confirm the file still builds: run whatever this project's existing lint/build check is (e.g. `npx eslint app/nps-calling/NpsCallingClient.js` if ESLint is configured) to catch a stray reference to the removed `pulling`/`pullNextLead` names. Do not start the dev server or hit a live endpoint — the user tests this themselves.

- [ ] **Step 7: Commit**

```bash
git add app/nps-calling/NpsCallingClient.js
git commit -m "feat(nps-calling): remove manual pull button, wire self-refill into dispose flow"
```

---

### Task 6: Delete the manual pull endpoint

**Files:**
- Delete: `api/detractor/next-lead.js`
- Modify: `api/_lambda/app.js:104`

- [ ] **Step 1: Remove the route mount**

In `api/_lambda/app.js`, delete this line:

```js
mount('post', '/api/detractor/next-lead', '../detractor/next-lead.js');
```

- [ ] **Step 2: Delete the endpoint file**

```bash
git rm api/detractor/next-lead.js
```

- [ ] **Step 3: Confirm nothing else references it**

Run: `grep -rn "detractor/next-lead" --include=*.js api/ app/`
Expected: no matches (Task 5 already removed the client's `fetch('/api/detractor/next-lead', ...)` call).

- [ ] **Step 4: Sanity-check the lambda app still parses**

Run: `node -e "require('./api/_lambda/app.js')"`
Expected: no output, exit code 0 (a dangling `require('../detractor/next-lead.js')` from a leftover `mount()` line would throw `Cannot find module`).

- [ ] **Step 5: Commit**

```bash
git add api/_lambda/app.js
git commit -m "chore(nps-calling): remove manual pull endpoint, replaced by auto-assign triggers"
```

---

## Self-Review Notes

- **Spec coverage:** Trigger A (Task 4), Trigger B (Task 3), removed pull button/endpoint (Tasks 5-6), `assignDetractorLeadsToAgent` (Task 2), quota/load consolidation (Task 1), override-onto-someone-else skip (Task 3), re-checked availability/quota at refill time (Task 3) — all covered.
- **Testing convention:** this codebase's `db.js`-adjacent test files (`db.redispose.test.js`, `db.npsProductExport.test.js`, etc.) are plain `node assert` self-checks of pure/injectable logic, never DB-mocked integration tests — no handler-level test file exists today for `next-lead.js`, `lead-assignment.js`, or `auth/[action].js`. Task 2's test follows that existing convention exactly; Tasks 3/4/5 intentionally add no test file, matching how every other handler in this area is (not) tested.
- **Type/signature consistency:** `assignDetractorLeadsToAgent(email, maxCount, claimFn)` and `getDetractorQuotaAndLoad(email) -> {quota, load}` are used identically in Task 3 and Task 4.
