# Escalation desk — real identity, roster, settings, assignment history, and visual polish

Date: 2026-08-07
Status: Approved by user, ready for implementation planning

## Background

The Escalation desk (`app/escalation/`) was just merged from a standalone app ported into
this monorepo (commit `ddbfc8b`). It is visually complete (sidebar, topbar, queue table,
overview panel, resolve/import/export flows) but functionally disconnected from the rest of
the app's calling-process infrastructure that RTO and NDR already use:

- `role`/`USERS` in `EscalationClient.js` is a client-only simulated toggle, not real session
  identity.
- The agent list (`AGENTS` in `api/escalation/[action].js`) is a hardcoded array of 5 fake
  people.
- Row→agent assignment lives in a plain in-memory object (`assignmentMap`) that is lost on
  every cold start and shared incorrectly across concurrent Lambda instances.
- The sidebar's "Agent Management", "Assignments", and "Settings" nav items are all
  "coming soon" placeholders.

Meanwhile, RTO and NDR already solved "real agents, real permissions, real per-process
settings" via `calling_agent_process` (Postgres), `/api/admin/calling-agents`,
`/api/admin/business-hours`, and the shared `useCallingSession` hook +
`app/_calling/CallingAdminPanel.js` components. `'escalation'` is already a registered
process key in `api/_lib/callingProcesses.json` and already works against every one of those
endpoints today with **zero backend change** — the desk itself just never adopted them.

This spec wires Escalation onto that existing infrastructure, builds its three placeholder
screens for real, adds durable assignment history (the one genuinely new piece of backend),
and makes a few concrete visual-polish fixes. Scope was set through user Q&A during
brainstorming: user confirmed (a) build out the placeholder screens rather than hide them,
(b) add real backend (not UI-only), (c) include durable assignment history (not just a live
snapshot), and (d) leave resolution-type dispositions hardcoded rather than making them
admin-editable this round.

## Section 1 — Identity & session wiring

**Problem:** `EscalationClient.js` has no real session at all client-side — unlike every
other calling page in this app. `role` defaults to `'admin'` and is just a manual UI toggle
(`app/escalation/EscalationClient.js:1025`, `:1407-1428`). The server (`checkAccess` in
`api/escalation/[action].js:24-30`) already gates correctly on a real session; the client
just never surfaces who that session actually is.

**Change:** Adopt `useCallingSession('escalation', {...})` from
`app/_calling/useCallingSession.js` — the same hook `RtoCrmClient.js` and
`NdrCallingClient.js` already use. This hook, on mount:
- Fetches `/api/auth/me` once → real `googleUser` (email/name/picture), `sessionIsAdmin`.
- Fetches `/api/admin/calling-agents?process=escalation` → `processAgents` (the real
  roster) and derives `isProcessAdmin` by finding the caller's own email in that list.
- Exposes `saveProcessAgent`, `setStatus`/`setStatusForAgent`, live presence
  (`serverPresence` via `/api/auth/presence`), and a toast helper.

Remove the `role`/`USERS` state and the role-switcher UI entirely (it was a demo affordance
with no counterpart in RTO/NDR). "Admin mode" throughout `EscalationClient.js` becomes
`sessionIsAdmin || isProcessAdmin`. The existing `StatusControl` component in the topbar
wires to the hook's real `setStatus`/`serverPresence` instead of the current local-only
`agentStatus` state.

**Files touched:** `app/escalation/EscalationClient.js` (session wiring, remove role
switcher, thread `isAdmin` from the hook through existing props), no server change (the
endpoints it calls already exist and already accept `process: 'escalation'`).

## Section 2 — Agent Management screen (new, admin-only)

**Problem:** Sidebar nav item exists (`app/escalation/EscalationClient.js:308`) but renders
a "coming soon" placeholder (`:1684-1694`). The assign-dropdown throughout the queue table
is backed by the hardcoded `AGENTS` array in `api/escalation/[action].js:36-42`.

**Change:**
1. `api/escalation/[action].js`'s `agents` action (`:67-70`) drops the hardcoded array and
   calls `getCallingProcessAgents('escalation')` (already exported from `api/_lib/db.js`,
   used identically by RTO/NDR) — no schema change, this function already works for any
   process key.
2. New `AgentManagementPanel` component in `EscalationClient.js`, modeled directly on NDR's
   `renderNdrRosterTable` (`app/ndr-calling/NdrCallingClient.js:482-573`) — deliberately the
   simpler of the two existing patterns (RTO's roster reconciles legacy
   localStorage/ticket-scraped agents that Escalation has no equivalent of; NDR's roster is
   exactly `processAgents`, nothing more).
   - Columns: Agent (avatar/name/email), Status (dropdown → `saveProcessAgent`), Max Quota
     (number input → `saveProcessAgent`), Process Admin (checkbox, only a full admin
     — `sessionIsAdmin` — may toggle it, mirroring the privilege-escalation guard already
     enforced server-side at `api/admin/[action].js:310-313`), and a computed **Assigned
     now** column (live count from the current queue + assignment state — see Section 4).
   - No add/remove buttons. Roster membership stays a `report_tab_permissions` grant via
     Admin → Permissions, exactly like NDR (`app/ndr-calling/NdrCallingClient.js:482-486`).

**Files touched:** `api/escalation/[action].js` (agents action), `app/escalation/EscalationClient.js`
(new panel + view routing). No new tables.

## Section 3 — Settings screen (new, admin-only)

**Problem:** Same "coming soon" placeholder.

**Change:** Reuse `useBusinessHours('escalation', {...})` + `<CallingHoursCard>` from
`app/_calling/CallingAdminPanel.js:26-91` / `:94-184` verbatim — a per-weekday open/close
time editor hitting `/api/admin/business-hours`, already valid for `processKey: 'escalation'`
(`api/_lib/callingProcesses.json` already carries a default hours entry for it). Zero
backend change.

**Explicitly out of scope for this round:** admin-editable resolution types. Escalation's
`RESOLVE_TYPES` (`app/escalation/EscalationClient.js:35-41`) stays hardcoded. The generic
`calling_process_dispositions` table (`api/_lib/db.js:401-412`) has no columns for the
`needsOrder`/`needsAwb`/`isBulkable`/`group` metadata the resolve form and the server's
`BULK_ALLOWED = ['Delivered']` rule (`api/escalation/[action].js:53`) depend on — and RTO
keeps its own outcome lists hardcoded for the identical reason (that table only backs
processes with no disposition list of their own, per its own comment at `db.js:395-400`).
Confirmed with user during brainstorming; making this editable would need new columns on
that table and is a real, separately-scoped follow-up.

**Files touched:** `app/escalation/EscalationClient.js` (new panel, imports from
`CallingAdminPanel.js`). No new tables, no server change.

## Section 4 — Assignments screen (new, admin-only) + durable assignment history

**Problem:** Sidebar nav item is a placeholder. The underlying data it would show doesn't
durably exist: `assignmentMap` in `api/escalation/[action].js:44-49` is a plain in-memory
object on `global`, explicitly documented there as non-durable ("a Lambda cold start or a
second concurrent instance starts empty"). There is no `escalation_lead_assignments` table
the way RTO has `lead_assignments` and NDR has `ndr_lead_assignments`.

**Change — new table** (`api/_lib/db.js`, added to `ensurePgSchema()` alongside the other
two, following the exact same shape/comments convention):

```sql
CREATE TABLE IF NOT EXISTS escalation_lead_assignments (
  id BIGSERIAL PRIMARY KEY,
  parent_order TEXT NOT NULL,
  email TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reassigned_away_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  agent_remarks TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS escalation_lead_assignments_parent_order_current_key
  ON escalation_lead_assignments (parent_order) WHERE reassigned_away_at IS NULL;
```

Keyed by `parent_order` (`HYP_Parent_OrderID`), **not** the sheet's `rowNumber` — rowNumber
is a raw row index that shifts whenever the sheet is re-sorted, has rows inserted, or is
re-synced; `parent_order` is the same stable business key the CSV import path already matches
rows on (`api/escalation/[action].js:136-151`). This mirrors `ndr_lead_assignments`'s
`awb_number` key exactly (`db.js:503-518`) and reuses the same "at most one live cycle" partial
unique index pattern RTO/NDR both already rely on.

**Write path changes in `api/escalation/[action].js`:**
- `assign` POST (`:79-85`): upserts a row here (insert new row when there's no live cycle for
  that `parent_order`, or update `email` on the existing live row when reassigning) instead of
  only touching the in-memory map. `assign` GET reads from this table (keyed by `parent_order`,
  translated back to the sheet's current `rowNumber` via `getSheetIndex()` — same lookup the
  import path already uses) instead of the in-memory object, closing the cold-start data-loss
  gap called out in that file's own comment.
- `update` POST (`:89-97`) and `bulk-update` POST (`:99-115`): after the sheet write succeeds,
  stamp `resolved_at = now()`, `resolution = newStatus`, `agent_remarks = notes` on the
  matching live row (by `parent_order`).
- The in-memory `assignmentMap` is removed once the table is live — it was only ever a
  workaround for not having durable storage.

**New read function** in `api/_lib/db.js`, e.g. `getEscalationAssignmentSummary()`: one row
per agent — currently-assigned count (live rows with `resolved_at IS NULL`), resolved count
(optionally date-range filtered), average time-to-resolve (`resolved_at - assigned_at`),
plus a team-total row — the same shape as NDR's `ndrSummaryRows`
(`app/ndr-calling/NdrCallingClient.js:1179-1286`).

**UI:** `AssignmentsPanel` component, one row per agent per the shape above, date-range
filter matching the convention used elsewhere in this app's admin panels.

**Files touched:** `api/_lib/db.js` (new table + index in `ensurePgSchema`, new read/write
functions), `api/escalation/[action].js` (assign/update/bulk-update actions),
`app/escalation/EscalationClient.js` (new panel + view routing). No migration script needed
for existing data — this is a brand-new table with nothing to backfill (today's in-memory
assignments are lost on every cold start already, so there is nothing durable to migrate
from).

## Section 5 — Visual polish (Queue + Overview, all roles)

Concrete fixes addressing the "visual polish/density" feedback, independent of the
identity/backend work above:

1. **Unify stat-card icons onto SVG.** `StatCard` currently takes a raw emoji string
   (`app/escalation/EscalationClient.js:182-189`, `:1509-1512` — 📊 ✅ 🚨 ⚠️ ⏳ 👤) while
   every other icon in the page (`Icon` component, `:104-140`) is a consistent
   stroke-width SVG set. Swap the emoji props for `I.*` SVG paths so the whole page uses one
   icon language.
2. **Sticky table header** on the queue table (`.tableWrap table thead`) so column headers
   stay visible while scrolling a long page of results.
3. **Row-density toggle** (comfortable/compact) for the queue table, persisted in
   `localStorage` — a lighter-weight way to see more rows at once without changing the
   default for everyone.
4. **Sidebar active-item affordance** — tighten the visual weight of `.navItem.active` so the
   current view is unambiguous at a glance (relevant now that the sidebar has real,
   navigable Agent Management/Assignments/Settings destinations instead of dead-end
   placeholders).

**Files touched:** `app/escalation/EscalationClient.js`, `app/escalation/escalation.css` (and
the source of truth it's generated from, `NDR Calling/styles/globals.css` — see the
regeneration note at the top of `escalation.css`; both must be edited together and
re-scoped via `scripts/scope_escalation_css.js`, exactly as `EscalationClient.js`'s own
header comment describes).

## Explicitly out of scope

- Admin-editable resolution/disposition types (Section 3) — needs a schema change, deferred.
- Any change to RTO's or NDR's own roster/settings/assignment code — this spec only touches
  Escalation-specific files plus additive changes to shared infrastructure
  (`db.js`, `CallingAdminPanel.js` consumers), never their existing behavior.
- Historical migration of pre-existing in-memory assignment data (none exists durably today).

## Open risk / follow-up for the implementation plan to address explicitly

- `getSheetIndex()` (used today only by CSV import) becomes a second consumer once `assign`
  GET needs to translate `parent_order` back to a live `rowNumber` — confirm its caching/
  freshness behavior is adequate for that additional call pattern, or give assign its own
  lighter lookup if not.
- Reassignment semantics: when an admin reassigns a row that already has a live assignment
  row, the plan needs to decide explicitly whether that closes the old row
  (`reassigned_away_at = now()`) and opens a new one (preserving full history, matching RTO/
  NDR's own cycle model) versus simply overwriting `email` in place — the former is what this
  spec's data model above assumes and what "history" implies, so the plan should implement
  that, not a naive overwrite.
