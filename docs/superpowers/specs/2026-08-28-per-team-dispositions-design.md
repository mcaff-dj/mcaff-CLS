# NDR Calling — Per-Team Disposition Trees — Design Spec

**Date:** 2026-08-28
**Status:** Awaiting user review of this spec, pending written-plan handoff
**Follows:** `2026-08-26-ndr-per-team-isolation-design.md`, which deliberately left the
disposition tree per-process and shared. This spec reverses that one decision.

## Goal

Each NDR team gets its own disposition tree. What Team Aditi's agents may select when disposing
a call is decided by Team Aditi's lead, and is invisible to and unaffected by Team Shahid's.

## Why the shared tree has to go

The per-team isolation spec kept `calling_process_dispositions` per-process and mitigated the
resulting hazard by locking edits to a full admin whenever a process has two or more active
teams (`handleDispositions` in `api/admin/[action].js`, and its own comment says why):

> NDR's calling flow branches on specific literal label strings when it saves a call outcome
> (see `NdrCallingClient.js`'s `saveNdrDisposition`) — so on a process that actually HAS two
> teams, one team's lead renaming or reordering an option can silently break the OTHER team's
> metrics, or its agents' ability to dispose a call at all.

That lock traded the hazard for a bottleneck: every wording change either team wants goes
through a full admin, and even then the two teams cannot disagree. Per-team trees remove the
hazard at its source, so the lock is removed with it.

## Scope decisions (confirmed with user)

| Decision | Choice |
| --- | --- |
| Tree model | Every team has its own **complete** tree, cloned from the shared tree when the team is created |
| Shared (`team_id IS NULL`) rows | Survive as the fallback for the no-team / pre-split desk, and for every other process |
| Existing teams (Aditi, Shahid) | One-time migration clones today's NDR tree into both, so day one looks identical to today |
| A team whose tree is empty | Falls back to the shared tree — an agent is never shown an empty picker and blocked from disposing |
| Write access | A Team Lead edits their own team's tree; a full admin edits any team's, plus the shared tree |
| Other processes (RTO, Escalation) | Untouched: all their rows stay `team_id IS NULL` and every code path behaves as today |

## Schema

One nullable column and one index on the existing table:

```
calling_process_dispositions
  + team_id INT NULL
      FOREIGN KEY (team_id) REFERENCES calling_teams(id) ON DELETE CASCADE
  + KEY calling_process_dispositions_team_idx (process_key, team_id, sort_order)
```

`NULL` means **shared / fallback**, not "unassigned". This is the same convention
`calling_teams`-related columns already use for absence and the inverse of
`report_tab_permissions` (where absent rows mean unrestricted); it is chosen so that every
pre-existing row — for every process — keeps its current meaning with no data migration.

`ON DELETE CASCADE` matches the existing self-referencing `parent_id` FK: deleting a team takes
its tree with it, and there is no orphan state to handle.

### Rejected alternatives

- **A separate `calling_team_dispositions` table.** Duplicates the self-referencing parent
  structure and all five read/write functions, leaving two code paths to keep in sync forever.
- **Encoding the team into `process_key` (`ndr#5`).** Breaks `callingProcesses.json` validation
  (`known.includes(processKey)`) and every existing `process_key = 'ndr'` query, including
  `scripts/assign_ndr_leads.py`.

## Resolution rules

One rule, used by both reads and writes:

```
resolveDispositionTeam(processKey, teamId):
  teamId given AND that (process_key, team_id) has rows  -> that team's rows only
  teamId given AND that team has no rows                 -> shared rows (team_id IS NULL)
  no teamId                                              -> shared rows only
```

The fallback in the middle line is what makes a failed clone, a newly created team, and a
process with no teams at all behave identically: agents keep working off the shared list.

### Where `teamId` comes from

Never from an agent's client. Same trust model as `api/ndr/sheet.js`'s `resolveSheetFor`:

| Caller | Read (`GET`) | Write (`POST`/`PUT`/`DELETE`) |
| --- | --- | --- |
| Agent | derived from their own `calling_agent_process.team_id` | n/a (no write access) |
| Team Lead (process admin) | derived, same as agent | **derived** — `body.teamId` is ignored, so a TL cannot target another team even with a valid id |
| Full admin | `?teamId=` honored; omitted means the shared tree | `body.teamId` honored; omitted means the shared tree |

A write always targets the derived team's **own** tree, even while that team's reads are still
falling back to the shared one. Consequence, accepted: a TL whose team somehow has an empty tree
and who adds one option goes from seeing the whole shared list to seeing exactly that option.
Clone-on-create plus the migration mean an empty team tree should not exist in the first place;
this is the honest behaviour of the fallback, not a state anyone is expected to reach.

A TL who administers a process with 2+ active teams but holds no team row of their own gets 403
on writes: there is no tree that is theirs to edit. On a process with fewer than two active
teams (RTO, Escalation, and NDR before a split) every path resolves to the shared tree, which is
today's behaviour unchanged.

## API changes — `api/admin/[action].js`

- `handleDispositions` GET: resolves `teamId` per the table above and passes it to
  `getProcessDispositions`. Reads stay open to anyone with calling access to the process.
- `handleDispositions` POST/PUT/DELETE: the existing `activeTeamCount >= 2` full-admin-only lock
  is **removed** and replaced by the derived-`teamId` rule. The `isCallingProcessAdmin` check
  stays.
- `logEvent` messages gain the team name (or `shared`), so the audit trail records which tree
  changed rather than just which process.

## DB layer changes — `api/_lib/db.js`

All five functions take a `teamId` (defaulting to `null` = shared) and scope every statement on
`(process_key, team_id)`:

- `getProcessDispositions(processKey, teamId)` — applies the resolution rules above. The
  existing two-pass parent/child build is unchanged.
- `addProcessDisposition(...)` — the parent-row lookup additionally requires the parent to sit in
  the **same** `(process_key, team_id)` tree, so a child can never be grafted onto another
  team's node by id. `sort_order` is computed within the same scope.
- `updateProcessDisposition(...)`, `deleteProcessDisposition(...)` — the `WHERE id = ...` guard
  gains the same team scope, so an id from another team's tree simply does not match.
- `reorderProcessDispositions(...)` — same, on both the `parent_id IS NULL` and
  `parent_id = ?` branches.
- `createCallingTeam(...)` — clones the process's shared tree into the new team after inserting
  it: roots first, then children keyed by the new parent ids, preserving `label`,
  `description`, `sort_order` and `children_input_type`. A clone that fails leaves the team with
  an empty tree, which the fallback rule renders harmless (agents see the shared list) rather
  than fatal.

## UI changes

- `useProcessDispositions(processKey, { teamId })` (`app/_calling/CallingAdminPanel.js`) sends
  `teamId` on load and on every mutation, and refetches when it changes.
- `app/ndr-calling/NdrCallingClient.js` passes the **existing header team picker's** selection
  (`ndrSheetTeam`), so one control drives both the sheet and the tree — no second dropdown.
- `ProcessDispositionsCard` heading names the tree it is editing: `Disposition List — NDR
  Calling · Team Aditi`, or `· Shared (fallback)` when no team is selected. Without this an
  admin cannot tell which tree their edit lands in, which is the one thing this feature makes
  possible to get wrong.
- The agent-facing dispose modal in `NdrCallingClient.js` needs no change: it renders whatever
  the server-scoped GET returned.
- `app/rto-crm/RtoCrmClient.js` and the Escalation page pass no `teamId` — unchanged.

## Migration — `scripts/migrate_team_dispositions.py`

Same shape as `scripts/migrate_ndr_team_id.py`: dry-run by default, `--apply` performs the work,
idempotent and safe to re-run.

1. Add `team_id` + the index if absent (detected via `information_schema`, as `ensureSchema`
   contains no `ALTER TABLE` and `CREATE TABLE IF NOT EXISTS` is inert against an existing
   table).
2. For each active `calling_teams` row of process `ndr` that has **zero** disposition rows of its
   own, clone the shared NDR tree into it (roots then children, preserving order and input
   types). A team that already has rows is skipped, which is what makes step 2 re-runnable.

**Run order matters:** this must be applied *before* the `api/` deploy. `api/` code selecting a
column that does not exist throws `ER_BAD_FIELD_ERROR` inside `getProcessDispositions`, which
serves the Escalation desk's dispose modal as well as NDR.

Rollback: `ALTER TABLE calling_process_dispositions DROP COLUMN team_id` drops every team tree
and restores the shared tree for everyone. Cloned rows carry `created_by = 'migration'` so a
partial clone can also be removed by that predicate alone.

## Testing

No live-DB or dev-server runs (user performs live testing). The logic worth a check is pure and
extracted so it can be checked without a database:

- `resolveDispositionTeam` — a team with rows resolves to itself; a team without rows resolves to
  shared; no team resolves to shared.
- The clone transform — given a flat shared-tree row set, the produced insert list preserves
  parent-child links, `sort_order` within each scope, and `children_input_type`, and never
  references a shared row's id as a parent.

Delivered as an `assert`-based `demo()` / `__main__` self-check on the migration script and its
JS counterpart, per repo convention. Manual verification steps for the user:

1. Header picker on Team Aditi → Admin Panel shows `· Team Aditi`; add an option; switch to Team
   Shahid → that option is absent.
2. Sign in as an agent of Team Shahid → dispose modal offers Team Shahid's tree only.
3. A Team Lead of Team Aditi can add/rename within Aditi; a crafted request naming Shahid's
   `teamId` still writes to Aditi (the id is derived, not read).
4. RTO and Escalation dispose modals unchanged.

## Out of scope

- Migrating existing NDR sheet rows whose `Outcome` text came from the old shared tree. Labels
  are free text in the sheet; renaming an option has never rewritten history and does not start
  here.
- A "copy tree from another team" admin action. Clone-on-create plus the migration covers the
  cases that exist; add it when a third team actually needs it.
- Per-team calling hours. Still shared per process, as the previous spec decided.
