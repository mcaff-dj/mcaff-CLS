# NPS-Calling (Detractor) — Auto-Assignment Design

## Context

NPS-Calling's "detractor" process is the only calling process left on pull-on-demand:
an agent clicks "Pull Next Lead" ([api/detractor/next-lead.js](../../../api/detractor/next-lead.js)),
which checks availability/quota and hands them one oldest/newest-eligible `nps_delivery`
Detractor row. RTO and NDR moved off pull-on-demand to periodic round-robin sweeps
(`scripts/assign_leads.py`, `scripts/assign_ndr_leads.py`, now running on AWS Lambda +
EventBridge — see [lambda/README.md](../../../lambda/README.md)), plus an on-disposal
top-up call so a freed slot refills without waiting for the next tick.

This spec moves NPS-Calling to the same auto-assignment shape as RTO/NDR's on-disposal
top-up, **without** a periodic sweep — NPS has no Sheet, no GoKwik lookup, no cron-worthy
external dependency, and both triggers below are always scoped to one specific agent's
own action, so there is no scenario where a shared cross-agent rotation cursor would ever
run. Each agent claims from the shared pool via the same atomic DB claim the pull endpoint
already uses today, just auto-triggered instead of button-triggered.

## Goals

- Remove the manual "Pull Next Lead" button and its endpoint.
- Going Online (flipping `calling_agent_process.status` to `'Online'` for the `detractor`
  process) immediately fills the agent up to their quota.
- Disposing a lead immediately refills that one freed slot for the same agent
  (self-refill), same as RTO/NDR's on-disposal top-up.
- No new infrastructure (no Lambda, no cron, no Python) — NPS-Calling is pure MySQL
  (`nps_delivery` → `CLS_NPS_calling`), so both triggers run as a plain inline async call
  in the existing Node/Vercel API routes.

## Non-goals

- No cross-agent fairness/rotation pass. Each trigger is agent-scoped by construction
  (an agent's own presence toggle, an agent's own disposal); there is no batch moment
  where several agents' capacity is decided together, so RTO's `build_assignment_queue`
  cursor algorithm has nothing to do here and is not ported.
- No change to lead selection criteria: same 30-day recency filter, same admin-set
  `lead_order` (oldest/newest), same best-effort sentiment classification on claim.
- No change to quota/availability rules: same `calling_agent_process.max_quota` override
  → admin default → `FALLBACK_QUOTA` (15) chain, same fail-closed availability check.

## Design

### `assignDetractorLeadsToAgent(email, maxCount)` — new, in `api/_lib/db.js`

Extracts the existing single-row select+insert body of `getNextDetractorLead` (the
30-day-filtered, lead-order-sorted `nps_delivery` query plus the `CLS_NPS_calling` INSERT
and best-effort sentiment classification) into a `claimOneDetractorLead(email)` helper.
`assignDetractorLeadsToAgent` loops that helper up to `maxCount` times, stopping early the
first time it returns `null` (pool exhausted). Returns the array of claimed leads (possibly
shorter than `maxCount`, possibly empty — never an error).

Each loop iteration re-runs the full query, so a lead claimed by iteration *N* is already
excluded (via the existing `LEFT JOIN ... IS NULL`) from iteration *N+1* — no separate
locking needed beyond what the pull endpoint already relies on today.

### Trigger A — going Online

[api/auth/[action].js](../../../api/auth/[action].js) `handleProcessPresence`, POST branch:
today, `body.status === 'Online'` fires `PROCESS_ASSIGN_LAMBDA[processKey]` (ndr) or
`PROCESS_ASSIGN_WORKFLOW[processKey]` (none currently) as a fire-and-forget nudge to the
external sweep. For `processKey === 'detractor'`, add a third branch: compute
`quota - load` (reusing `getDetractorAgentQuota` / `getCallingDefaultQuota` /
`getDetractorLoadByAgent`, same chain `next-lead.js` uses today) and call
`assignDetractorLeadsToAgent(session.email, Math.max(0, quota - load))` inline, awaited,
wrapped in try/catch — a failure here must not block the presence-toggle response, same
contract as every other best-effort enrichment in this codebase.

### Trigger B — disposal

[api/detractor/lead-assignment.js](../../../api/detractor/lead-assignment.js): after
`disposeDetractorLead` succeeds, re-check `getDetractorAgentAvailability(email) === 'Online'`
(the agent may have gone Offline between holding the lead and disposing it) and, if still
online and under quota, call `assignDetractorLeadsToAgent(email, 1)`. Fail-closed exactly
like the availability check the pull endpoint already enforces — no refill if the agent
isn't verifiably online.

### Removed

- [api/detractor/next-lead.js](../../../api/detractor/next-lead.js) and its test.
- The "Pull Next Lead" button and its handler in
  [app/nps-calling/NpsCallingClient.js](../../../app/nps-calling/NpsCallingClient.js).

## Edge cases

- Going Online already at/over quota (shouldn't happen, but defensive): `quota - load`
  clamped to `Math.max(0, …)` → zero-iteration no-op.
- Pool exhausted mid-loop (going-Online batch or disposal refill): loop just stops early;
  agent ends up holding fewer than quota. No error surfaced — matches today's
  `assigned:false` semantics, just silent since there's no button/response for an agent to
  read anymore.
- Sentiment classification stays best-effort/fail-open per claimed lead, unchanged.
- Concurrency: unchanged from today — the `LEFT JOIN ... IS NULL` + `INSERT` pair is the
  same implicit claim the pull endpoint already used; nothing here changes its race
  properties.

## Testing

- New/extended unit coverage for `assignDetractorLeadsToAgent`: stops at `maxCount`, stops
  when the pool empties before `maxCount`, never exceeds quota.
- Update `handleProcessPresence` tests for the new inline `detractor` branch.
- Update `api/detractor/lead-assignment.js` tests for the post-disposal self-refill call,
  including the re-checked-availability skip case.
- Remove `api/detractor/next-lead.test.js`.
