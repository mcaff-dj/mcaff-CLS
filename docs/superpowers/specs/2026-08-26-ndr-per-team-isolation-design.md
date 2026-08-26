# NDR Calling — Per-Team Isolation — Design Spec

**Date:** 2026-08-26
**Status:** Awaiting user review of this spec, pending written-plan handoff

## Goal

Two team leaders work NDR Calling at the same time. Each has an entirely different team of
agents and an entirely different Google Sheet as their lead source. They share the same MySQL
schema (`PEP_CLS`). Neither TL — nor their agents — may see any metric, roster row, presence
figure, lead, or lead-volume timeline belonging to the other team. A full admin can create and
rename teams and set each team's sheet ID from the UI, without a deploy per team.

Additional requirement added during design: the **Upload CSV** button must append to the
uploading TL's own team sheet.

## Why "team" and not "process"

The Calling CRM already has an isolation unit: `process_key`. It scopes
`calling_agent_process` (roster, status, quota, per-agent filters, `is_process_admin`),
`calling_business_hours`, and `calling_process_dispositions`, with membership expressed as a
`report_tab_permissions` row. The obvious move is to make each team its own process
(`ndr-teamA`, `ndr-teamB`) and inherit all of that for free.

Rejected, for two reasons:

1. **Self-serve team creation would force the process registry to become dynamic.**
   `api/_lib/callingProcesses.json` is the documented single source of truth, consumed by
   `api/_lib/tabs.js:53` (so the admin Permissions UI can grant a process),
   `app/rto-crm/RtoCrmClient.js`'s process switcher, `app/HomeClient.js`'s sidebar, and
   `scripts/assign_leads.py`. Making processes DB-backed destabilises RTO and Escalation to
   deliver an NDR feature.
2. **It is the wrong unit.** Both teams run the same process: same sheet columns, same
   disposition tree, same calling window, same flow. They differ in *who* and *which sheet* —
   that is a team, not a process.

So: a team is a new dimension **inside** the existing `ndr` process. One new table, one new
column, and scoping applied at the points enumerated below.

## Scope decisions (confirmed with user)

| Decision | Choice |
| --- | --- |
| Existing ~10 NDR agents | User re-sorts them into teams manually after the column lands |
| Team B sheet | Supplied and verified: `1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg`, tab `Latest NDR ` (see Prerequisites) |
| Isolation reach | Everything on the NDR page — roster, Overview, Total Leads Disposed, Fresh Leads, Next to Assign, lead table, exports |
| Future teams | Self-serve: a full admin creates/renames teams and sets sheet IDs from the UI |
| Calling Hours + disposition tree | Stay per-process (shared by both NDR teams), and become **full-admin-only to edit** |
| Pre-existing security bugs found during design | Fixed as part of this project |

## Schema

### New table: `calling_teams`

```
id           INT AUTO_INCREMENT PRIMARY KEY
process_key  VARCHAR(64) NOT NULL          -- 'ndr' today; the column keeps this reusable
name         VARCHAR(120) NOT NULL
sheet_id     VARCHAR(128) NOT NULL
sheet_tab    VARCHAR(120) NOT NULL         -- 'Latest NDR ' today (trailing space significant)
active       BOOLEAN NOT NULL DEFAULT TRUE
created_at / created_by / updated_at / updated_by
UNIQUE KEY (process_key, name)
```

Added to `bootstrapSchema` in `api/_lib/db.js` (the DDL block at `:101-427`), so it self-applies
on the next cold start via `ensureSchema()` at `:92`. No manual step.

`sheet_tab` is stored per team rather than hardcoded because it is already a hardcoded const in
two places today (`api/ndr/upload.js:27`, `app/ndr-calling/NdrCallingClient.js:66`) and there is
no reason a second third-party sheet names its tab identically.

### New column: `calling_agent_process.team_id INT NULL`

**This has no automatic deploy path.** `CREATE TABLE IF NOT EXISTS` is inert against a live
table, and there is no `ALTER TABLE` anywhere in `api/` (verified by grep). The column arrives
via a hand-run Python migration following the established pattern in
`scripts/migrate_cls_rto_calling_schema.py:131-164` (introspect, plan, dry-run, `--apply`).

This asymmetry is the single most dangerous ordering fact in the project and drives the rollout
sequence: **api/ code that references `team_id` can deploy fully automatically, in about a
minute, while the column it needs does not exist.** A `SELECT ... team_id` against a
column-less table throws `ER_BAD_FIELD_ERROR` inside `getCallingProcessAgents`
(`api/_lib/db.js:2244`), which is on the hot path of `/api/admin/calling-agents`,
`/api/auth/presence`, `/api/auth/processPresence` **and `/api/escalation/agents`** — so a
forgotten migration breaks the RTO CRM roster and the Escalation desk, not just NDR.

`calling_agent_process`'s primary key is `(email, process_key)`, so `team_id` on that table
gives each agent exactly one NDR team. That is the correct cardinality for isolation.

### Deliberately NOT changed: `ndr_lead_assignments`

The table has no team column and its only uniqueness is a `UNIQUE KEY` on the generated
`live_awb_number` (`api/_lib/db.js:262-264`). It is tempting to make that key team-aware. This
spec leaves it alone, on evidence:

- **The mirror's grain is already coarser than the sheet's, today, inside one team.**
  `api/_lib/ndrCsvImport.js:81-85` states it directly: one shipment gets a new row per failed
  delivery attempt, the sheet really does carry the same AWB on many rows (358 such AWBs on
  2026-08-25 per `scripts/test_assign_ndr_leads.py`), and the sheet's identity is therefore
  `(AWB Code, Attempt Count)` — `NDR_AWB_COLUMN='E'`, `NDR_ATTEMPT_COLUMN='O'`. The mirror keys
  on `awb_number` alone. Attempt 2 and attempt 3 of one shipment already cannot both hold a live
  mirror row. `scripts/assign_ndr_leads.py:248` deduping a batch to `{awb: email}` with
  last-agent-wins, and `test_assign_ndr_leads.py:199-209` asserting exactly that, are
  accommodations of this collision, not fixes for it.
- **A composite `(team_id, live_awb_number)` key would silently enforce nothing for legacy
  rows.** `api/_lib/db.js:250`'s own comment records that MySQL treats every NULL in a UNIQUE
  index as distinct — so until the backfill completes, every `team_id IS NULL` row is exempt.

Adding the team dimension without the attempt-count dimension would trade the one working
constraint for a partial one. Recorded here as a known limitation with a real consequence
(below), to be fixed as its own project.

**Known limitation.** If the same AWB appears on both teams' sheets, the browser and the cron
disagree about who owns the lead, in opposite directions:

- `claimNdrLead` (`api/_lib/db.js:1234`) uses `INSERT IGNORE` — team B's claim silently
  no-ops and reports success, so the lead looks permanently unassigned to team B.
- `disposeNdrLead` (`:1258`) matches on `awb_number` alone — team B's disposal then overwrites
  team A's live cycle's disposition and remarks.
- `scripts/assign_ndr_leads.py:273-279` catches the same integrity error and **steals** the row
  via `UPDATE ... SET email = %s`.

So the UI drops the write and the cron overwrites the owner, on the same collision. Any future
team predicate must be added to both paths together or they will disagree.

### Shared per-process state

`calling_business_hours` and `calling_process_dispositions` stay keyed on `process_key` only —
both NDR teams share one calling window and one disposition tree. Per the confirmed decision,
**editing either becomes full-admin-only** (today `api/admin/[action].js:257` and the five
disposition mutators gate on `isCallingProcessAdmin`, which both TLs will hold). This closes the
last write surface through which one TL could disrupt the other team's live shift: changing when
their leads are handed out, or renaming a disposition their agents pick from.

Note the disposition tree is additionally load-bearing for logic, not just labels:
`app/ndr-calling/NdrCallingClient.js:404` and `:411` branch on the literal strings
`'Have you got call from Partner'` and `'Mark RTO'`. Locking edits to full admin reduces the
chance of a rename silently breaking a metric.

## Access control

### Team resolution is server-side, without exception

The caller's team is derived on the server from `session.email` →
`calling_agent_process.team_id`. The client never supplies a team ID for read scoping.

This is not a defence-in-depth preference; a client-side team filter cannot work here at all:

- `app/ndr-calling/page.js` renders a dynamic `ssr:false` component. The page holds the **entire
  sheet and the entire roster in browser memory** and computes every metric locally
  (`NdrCallingClient.js:294-309`). A client-side filter leaves the other team's rows in the tab's
  heap, in React props, and in the Network panel.
- `/rto-crm?process=ndr` calls `useCallingSession('ndr')` at `app/rto-crm/RtoCrmClient.js:422`
  and only *then* redirects to `/ndr-calling` in a `useEffect` at `:400-403`. So
  `GET /api/admin/calling-agents?process=ndr` and `GET /api/auth/presence?process=ndr` are
  issued **from the RTO CRM page**, which has no NDR team context. Nothing inside
  `app/ndr-calling/` can be the resolution point even in principle. The same page also fires the
  destructive `DELETE /api/admin/calling-agents` at `:1145` with a process key taken from a URL
  parameter.

The one legitimate client-supplied team ID is a **full admin** explicitly switching which team
they are viewing. That path checks `session.isAdmin`, never `isCallingProcessAdmin`.

### Roster membership rule

`getCallingProcessAgents(processKey)` (`api/_lib/db.js:2216`) gains an optional `teamId`:

| `teamId` | Behaviour | Why |
| --- | --- | --- |
| `undefined` | No team filter; identical to today | Keeps the three other callers working untouched: `app/rto-crm/RtoCrmClient.js:422`, `app/escalation/EscalationClient.js:1004`, `api/escalation/[action].js:64` |
| a team ID | Returns only rows whose own `team_id` column matches | The team view |
| `null` (post-migration) | Returns nothing — fail closed | The caller has no team. See the release-1 exception below, which softens this for the first release only |

The subtlety worth stating explicitly: **`report_tab_permissions` and `calling_agent_process`
have opposite absence semantics, and they meet one join apart inside this function.**
`api/_lib/db.js:134-135` documents that no rows for a `(user, card)` pair means *full access to
every tab*. `calling_agent_process` must be the inverse — no row means *no team*. Conflating the
two is the most likely implementation error in the project.

Two consequences:

- **Both TLs get real `calling_agent_process` rows** with a `team_id`. Global admins hold no such
  row by convention (`api/_lib/db.js:2210-2211` records that admins vanishing from every roster
  was already a shipped bug once), so making team membership require a row is what stops
  `u.is_admin = 1` at `:2234` acting as a membership source — without touching the
  process-level query that fixed that bug.
- **`isProcessAdmin` and `teamId` become their own response fields.** Today
  `app/_calling/useCallingSession.js:133` learns `isProcessAdmin` by finding the caller inside
  the roster response. Filter the roster by team first and a TL whose own row is unassigned
  disappears from their own roster and silently loses the entire Admin Panel — no error, just
  missing UI.

### Release 1: an unresolved caller team means "no filter"

Two distinct things are called "null team" in this area, and the distinction matters:

- **the caller's resolved `teamId`** — the value the server derives from the requesting user's
  own `calling_agent_process` row, passed into `getCallingProcessAgents`;
- **a roster row's `team_id` column** — the stored membership of each agent the query returns.

The release-1 exception is about the **caller's resolved `teamId`** only. When it is null — the
requesting user has no team yet — the query applies *no filter*, so an unbackfilled database
behaves exactly as it does today: ten agents, one team, everything visible. Rows whose own
`team_id` column is null are simply unassigned, and are excluded from any team view once a real
`teamId` is being filtered on. Isolation switches on the moment `calling_teams` holds two rows
and callers start resolving to real teams.

This makes the migration, the backfill, and the api/ deploy order-independent — which matters
more than fail-closed purity, because before two teams exist fail-closed is not a safety
property, it is a self-inflicted outage: every existing agent reads `team_id NULL`, drops off
their own TL's roster, and via `useCallingSession.js:133` the TL loses the Admin Panel with no
error message. Fail-closed is correct, and is adopted, from the moment the second team exists.

### Writes are the wider hole

Read scoping alone leaves a worse problem open. `api/admin/[action].js:323` (POST) and `:363`
(DELETE) gate only on `isCallingProcessAdmin(session.email, 'ndr')` — which both TLs hold. Today
that means TL A can set TL B's agents' status, quota and per-agent filters, and can revoke their
`ndr` access outright by rewriting `report_tab_permissions` (`:373-382`). Both must be
team-scoped.

Two related traps:

- `setCallingProcessAgent` returns the **full roster** on the write path (`api/_lib/db.js:2354`),
  and `api/admin/[action].js:350` forwards it verbatim. A POST that changed one agent's status
  answers with everyone. Same class of bug as the one already fixed at
  `api/auth/[action].js:253-255`.
- The revoke path (`api/admin/[action].js:399`) deliberately clears `status` and
  `is_process_admin` so nothing privileged survives a revoke. A `COALESCE`'d `team_id` would
  **not** be cleared, so a revoked agent keeps their team membership and rejoins that team's
  roster the moment anyone re-invites them. `team_id` needs an explicit-unassign path, which
  plain `COALESCE` cannot express.

`setCallingProcessAgent`'s existing "unset means leave alone" `COALESCE` contract must also
guarantee that an agent flipping their own status through
`POST /api/auth/processPresence` (`api/auth/[action].js:466`) can never write their own
`team_id`.

### `sheet_id` writes are full-admin only

Self-serve sheet registration moves the trust boundary from a code constant to an admin-typed DB
field. The service account has **Editor** access, and `batchUpdate` ranges are entirely
client-chosen (`api/ndr/sheet.js:99-114`), so whoever can write `calling_teams.sheet_id` can
point the service account at any spreadsheet it can reach. Therefore: `sheet_id` writes check
`session.isAdmin` only, never `isCallingProcessAdmin`, and the value is shape-validated.

### Presence stays global; only the read is scoped

`agent_presence` and `agent_presence_log` are keyed on email alone (`api/_lib/db.js:554-561`)
and are global by design — a person has one desk. **Do not add a team column there**; it would
drift the moment someone works two processes. Scope the *read* instead: which emails a caller may
ask about.

The relevant read is `handlePresence`'s process-admin branch (`api/auth/[action].js:256-274`),
which returns live status, `updatedAt`, `loggedInMinutes`, `breakMinutes` and `busyMinutes` for
every member of `getCallingProcessAgents(processKey)`. It is process-scoped with no team
dimension, so today TL A would receive TL B's whole team's worked minutes.

### Escalation shortcut to avoid

`api/auth/[action].js:184-185` gives a `users.is_admin` account `CARD_KEYS` plus an **empty**
`tabPerms`, which this codebase reads as unrestricted everywhere; `/api/auth/presence:293` then
returns company-wide presence. If either TL is granted `users.is_admin` "so they can manage their
team," every boundary in this spec evaporates in one click. **TLs must stay
`is_process_admin`, never `is_admin`.** Worth stating in the runbook, not just the code.

### Three pre-existing bugs fixed here

Both are small diffs in files this project already touches, and both become named cross-team
leaks once teams exist.

1. **`/api/auth/leadDates` has no permission gate at all.** `api/auth/[action].js:360-365` checks
   only `session && session.email` — no `calling` card check, no `ndr` tab check — and returns
   every live NDR AWB with its assignment and disposal timestamps, unbounded
   (`getAllNdrLeadDates`, `api/_lib/db.js:2763`). Any signed-in user of the whole site can
   already enumerate NDR lead volumes and pacing. Fix: add the card/tab gate **and** team
   scoping, and re-key its `cachedRead('calling:ndrLeadDates')` slot per team — a single global
   cache key would otherwise serve the first team's AWB set to the other for the full 5-minute
   TTL, intermittently.
2. **`claim` accepts a client-supplied assignee email.**
   `api/ndr/lead-assignment.js:40` is
   `claimNdrLead(awbNumber, (req.body || {}).email || session.email)`, while the comment at
   `:46-47` asserts the value is "stamped from the session, never client-supplied, same as
   'claim'" — true of `dispose` at `:48`, false of `claim`. Any NDR agent can attribute a claim
   to any other agent's email, across teams once teams exist. Fix: stamp from the session, and
   correct the comment.

3. **`NDR_EXPECTED_SHEET_HEADER.F` never matched the live sheet**, so every NDR CSV upload has
   returned HTTP 500 since the feature shipped. See "Both sheets share one header" under
   Prerequisites for the evidence. Fixed: `'Partner'` → `'Partner name'` in
   `api/_lib/ndrCsvImport.js`.

Per the confirmed decision these ship as part of this project. They should be separate commits
from the feature work so they can be reviewed on their own merits.

## Sheet plumbing, and Upload CSV

### Drop the client-supplied `sid` entirely

`api/ndr/sheet.js:70` reads `sid` from the request and compares it to one const
(`NDR_SHEET_ID`, `:16`), then executes against the const regardless (`:90`, `:108`). The file's
own comment (`:13-15`) states why the check exists: so a permitted-but-malicious request cannot
repurpose the service account's access against an unrelated sheet.

The natural way to extend this — widen the allow-list to "any registered team sheet" — silently
destroys that property. The service account is an Editor and `batchUpdate` ranges are fully
client-chosen, so a union allow-list hands one TL arbitrary **write** access to the other team's
sheet.

Instead: **resolve the one sheet the caller is entitled to, server-side, and ignore any `sid` the
client sends.** This preserves the original threat model more strongly than the current check
(the client's value is never consulted at all), and it is what makes an api-newer-than-app deploy
safe — a server that *validated* `sid` against the resolved sheet would 400 `Unknown sheet` for
the new team while the old client still sends the incumbent ID.

### Fix the read cache key

`api/ndr/sheet.js:88` keys the 20-second read cache on `values:${range}` — the spreadsheet ID is
not part of the key. Both sheets name their tab `'Latest NDR '`, so identical range strings
collide inside a warm Lambda container and one team is served the other's rows, with a 200 and no
audit trail. The key must include the resolved sheet ID.

This is the sharpest trap on the whole surface: it survives a perfectly correct permission check,
appears only on warm containers inside a 20-second window, and is therefore close to
untestable by hand.

Note `:119` clears the entire cache on any successful write (`_readCache.clear()`), which is
process-global. Correctness-safe, merely wasteful, once keys are team-distinct.

### Upload CSV writes to the caller's own team sheet

`api/ndr/upload.js:26` hardcodes the sheet ID and `:27` the tab; every call interpolates the
const at `:45`. Both become the server-resolved team values, so a TL can only ever append to
their own team's sheet, by construction. The gate at `:52` already requires
`isAdmin || isCallingProcessAdmin(email, 'ndr')`; the team resolution is added alongside it.

**Header-layout constraint.** Before appending, upload reads `A1:Q1` and runs
`checkSheetLayout` against `NDR_EXPECTED_SHEET_HEADER` — 14 columns pinned by letter with their
live header text (`api/_lib/ndrCsvImport.js:46-66`) — and refuses the append on drift
(`api/ndr/upload.js:161-169`). A second team's sheet must match that layout.

Therefore: **validate the header row at team-registration time**, when an admin saves a
`sheet_id`. A mismatched sheet is then rejected at the moment it is added, with a clear message,
rather than failing later on a TL's upload. Note the *read* path has no equivalent check, so a
sheet with one extra inserted column would silently misalign every column the page reads — which
makes registration-time validation the only place this can be caught.

### Prerequisite that no code can remove

A newly registered sheet must be shared with `GOOGLE_SHEETS_CLIENT_EMAIL` out of band, or every
request 403s from Google. "No deploy per new team" is achievable; "no manual step per new team"
is not. This belongs in the admin UI's help text.

## Page behaviour (`app/ndr-calling/`)

### Sheet identity becomes a runtime value

`NDR_SHEET_ID` and `NDR_SHEET_TAB` are module-scope consts (`NdrCallingClient.js:65-66`) read by
module-scope async functions — `fetchNdrSheetValues` (`:68`), `fetchNdrSheet` (`:97`),
`writeNdrCells` (`:190`) — which are called from inside the component (`:322`, `:367`, `:426`).
Those three functions take the sheet identity as a parameter, or the `sid` is dropped entirely
(preferred, per above) and only the tab name is threaded through.

Related ordering trap: `useCallingSession` is called at the very top of the component (`:221`)
and its `getDateBounds` argument is already a getter closure (`:229`) to dodge a temporal-dead-zone
error on state declared sixty lines lower. A `teamId` cannot reach the hook as a plain value read
from later state — the hook should **learn** the team from the roster response it already makes.

### Third access state: invited but unassigned

`hasAccess` (`:1234`) distinguishes only "has access" from "does not". There is no state for
"invited to NDR but `team_id IS NULL`", and such a user currently passes the access check and
gets a fully rendered page where every count is zero, every table is empty, and nothing explains
why. Given `team_id` is nullable and the user is re-sorting agents by hand, **this hits every
existing agent on day one until an admin assigns them.** It needs its own panel, reusing the
existing no-access block's styling.

### Team selector

For full admins only (they alone may view any team), slotted into the existing header/tab
structure and reusing `CustomSelect` from `app/_calling/ui.js`. A TL or agent sees their own
team's name as static text, not a selector.

Under an app-newer-than-api deploy the selector must render **nothing** when `teams` is
`undefined` — not an empty dropdown, which reads as "you have no teams".

### Labels that silently change meaning

The `'Team Total'` row label (`:1484`) and the Overview subtitle `'across all N team members'`
(`:1326`) keep the same words while their meaning narrows from process to team. Anyone comparing
a pre-change CSV to a post-change one sees an unexplained drop with nothing to justify it. Put
the team name in that label, in the CSV filenames (`:1128`, `:1145`), and in the page title
(`:1240`).

### `ndrPredicted` must move in lockstep with the cron

`:520` is a hand-written port of `scripts/assign_ndr_leads.py`'s round-robin, and the file's own
comment at `:112-118` already records that a duplicated filter rule is "exactly how a filter rule
silently drifts from what the cron actually does". Making the cron per-team without making this
port per-team in the identical way produces a "Next to Assign" tab that is confidently,
plausibly wrong — the worst failure mode for a prediction panel.

### Two existing weaknesses this design inherits

- **First-paint identity on a shared browser.** `googleUser` is seeded from localStorage with a
  hardcoded fallback identity (`useCallingSession.js:51-52`) and `userRole` from
  `'rto_active_role'` defaulting to `'Admin'` (`:55-58`). On a shared machine, agent B's first
  frames render as agent A with role Admin until `/api/auth/me` resolves. Because the server never
  sends the other team's rows, this is a mis-render, not a data leak — but it is worth noting that
  the mis-render will now briefly show a team name that isn't theirs.
- **Agent identity matched by substring.** `ndrIsAssignedTo` (`:986`) and `ndrInMyScope` (`:446`)
  match agents against the sheet's free-text Agent Name column by bidirectional substring,
  because legacy rows carry bare first names. Two teams each having a `Priya` will
  cross-attribute leads *within the sheet's own display*, regardless of how cleanly the roster is
  partitioned. Out of scope here; the durable fix is writing emails, not names, into that column.

## Robot (`scripts/assign_ndr_leads.py`)

### A loop over teams is necessary but not sufficient

The query that must change regardless is the roster read at `:166-171`, which filters on
`process_key` only. Running the loop without adding a team predicate produces the worst possible
outcome: team B's agents assigned leads from team A's sheet, their emails written into team A's
sheet, and both TLs seeing the other team's work.

### Close both fail-open paths *before* the column exists

Every failure path in `fetch_online_ndr_agents` (`:160-175`) falls back to **global**
`agent_presence` with no per-process filters, and the `if not per_process` branch at `:177-179`
does the same on an empty result. Under two teams, either fallback means handing one team's whole
sheet to every online agent in the company, ignoring quotas and filters — triggered by nothing
more than a transient DB error.

Worse, an empty per-process result becomes the **normal** state for a freshly created team that
has no agents yet. Both branches must fail closed (assign nothing) *before* `team_id` exists,
because a missing column hits the same `except` at `:173-175`.

The unassigned-agent policy must be explicit rather than emergent: `team_id IS NULL` plus an
equality predicate silently excludes them from every team (correct); no predicate silently
includes them in whichever team runs first (definitely wrong). Assert the chosen behaviour in
`test_assign_ndr_leads.py`.

### Per-team failure isolation and ordering

- **Per-team `try/except` with one aggregated raise at the end.** The `raise RuntimeError` at
  `:406-411` is deliberately fatal so the invocation goes red. Unguarded inside a loop, a
  failure on team A means team B is never processed at all — and because the failure is in the
  *mirror*, after team A's sheet write already succeeded, the run looks catastrophic while team B
  is merely starved.
- **Preserve write ordering per team:** sheet write before mirror write when assigning
  (`:387-390`), sheet write before mirror retire when reclaiming
  (`reclaim_stranded_ndr_leads.py:144-147`). Each team's mirror batch in its **own** transaction
  — never one transaction spanning two teams, where one team's un-retired row would abort the
  other's whole batch.
- **Commit between teams.** `mysql_lib`'s process-lifetime connection with autocommit off
  (`mysql_lib.py:51-108`) means a single-process loop reads every team's roster from the MVCC
  snapshot of the *first* SELECT. Unnoticeable today with one pair of reads; under a loop, team B
  silently sees a stale Online set and agents who came online mid-run get nothing for the cycle.
- **Partial sheet-write failure is already lossy.** `set_sheet_values_batch` has no retry and the
  write is chunked 300 at a time (`:387-388`); a failure on chunk 2 leaves chunk 1 assigned on the
  sheet with nothing mirrored, because `record_new_assignments` at `:390` never runs. Re-running
  self-heals the sheet but not the mirror. Pre-existing; the per-team loop must not widen it.

### Concurrency and runtime budget

`mcaff-cls-assign-ndr-leads` is the **only** cron Lambda with no reserved concurrency (the other
three have it — `lambda/deploy_infra.sh:116`, `:174`, `:268`), on a `rate(5 minutes)` schedule
with the flexible window off (`:390-396`), at a 120-second timeout (`:126`). A per-team loop makes
each run several times longer, so overlapping invocations become likely — and two concurrent runs
read the same unassigned pool. **Add reserved concurrency = 1.**

Note also that `assign_ndr_leads.py` has **no business-hours gate at all** (contrast
`assign_leads.py:918-924`). If per-process calling hours are expected to gate NDR
auto-assignment, that is new behaviour requiring a new Lambda-side read — out of scope here, but
worth knowing the shared "Calling Hours" card currently does not gate the NDR robot.

### Column map for a sheet the team does not own

`:5-10` and `:34-36` record that this is someone else's existing sheet, with its column map as a
module constant. Two teams means two independently maintained third-party sheets: if team B's
sheet has one extra inserted column, this script writes agent emails into the wrong column and
reads brand from the wrong one, with no error. Validate each team's header row per run, or at
minimum at registration (see Upload CSV above).

### Manual scripts must require `--team`

`reclaim_stranded_ndr_leads.py` and both NDR backfills are manual, `--apply`-gated scripts with a
hardcoded sheet ID and no team argument. Once two teams exist, running any of them "as
documented" operates the wrong sheet against a whole-table query. They should **refuse to run
without an explicit `--team`** rather than defaulting, and the reclaim script's roster print
(`:103`) should not list the other team's agents.

### Invocation plumbing

`api/_lib/lambdaTrigger.js:29-46` already accepts and JSON-stringifies an optional payload, so
the API side is plumbed; only `lambda/assign_ndr_leads/handler.py:22` ignores `event`. Going
Online fires exactly one NDR assignment Lambda (`api/auth/[action].js:19`, `:471`), so that
trigger either fans out to every active team or carries the caller's team.

Deploy caveat: `.github/workflows/deploy-cron-lambdas.yml` fires on a `paths:` allowlist and
`lambda/build.sh:58-62` copies exactly three files. **An import of a new helper module that is not
added to both lists is an ImportError on every invoke, with CI green.**

## Confirmed clean — do not spend scope here

Verified during design; these surface no NDR data and need no change:

- `/calling-overview` reads only `CLS_RTO_calling` (all five queries) and is gated on tab
  `overview`.
- `/api/report/raw` has no `calling` tab. Refund Export reads `refund_all_brands` with no agent
  attribution. `log-export` is write-only. `handleAudit` is full-admin-only.
- `api/_lib/tabs.js` and `api/_lib/callingProcesses.json` need **no change** — teams are not
  processes under this approach, so the process registry, the Permissions UI and the sidebar are
  untouched.
- No Slack integration exists anywhere in the repo, and the only outbound mail is the admin
  invite at `api/admin/[action].js:92`. There is no notification path to leak through, and no
  existing NDR digest to retrofit.

## Out of scope, known

- **`app/deepdive`'s Agent-wise analysis** (`AgentShiftTab.js:64`) shows per-agent name,
  login/logout, break/offline/busy and a per-agent heatmap for everyone in the Drive
  status-log export — a different pipeline, a different card (`deepdive`), no team concept
  anywhere in it. A TL who also holds `deepdive` would see the other team's agents there.
  Mitigation for now: do not grant TLs the `deepdive` card.
- `ndr_lead_assignments` grain (see Schema).
- Substring agent-name matching (see Page behaviour).
- Per-team calling hours.

## Rollout order

`api/` (Lambda, `.github/workflows/deploy.yml`, `paths: api/**`) and `app/` (Amplify, its own
GitHub-triggered build) deploy on **separate triggers with different durations**. One commit
touching both starts two independent builds, so *app newer than api* and *api newer than app* are
both routine mid-deploy states, not accidents. Every new client field must therefore be optional
with a today-equivalent default.

1. **Hand-run the migration**: `ADD COLUMN team_id`, then backfill, then verify. Nothing reads it
   yet.
2. **api/**: `calling_teams` DDL (self-applying), team CRUD, `team_id NULL = no filter` reads,
   server-side sheet resolution, cache-key fix, write scoping, the two security fixes.
3. **app/**: team selector, third access state, runtime sheet identity, labels — all optional
   fields, defaulting to today's behaviour.
4. **Python**: close the fail-opens, add the team predicate, reserved concurrency, `--team` on the
   manual scripts.
5. **Flip to fail-closed by creating the second team.** This is the only step that changes what
   anyone sees, and it is a data change, not a deploy — so it is instantly reversible by
   deactivating the team.

Failure mode per wrong order, for the record: migration after api/ deploy 500s every
roster-reading endpoint across three processes; read filter before backfill drops all ten agents
off their own roster and costs the TL the Admin Panel; api/ newer than app/ is safe **only**
because the server ignores `sid` rather than validating it.

## Testing

**Nothing in this repo runs automatically.** `package.json` has no `test` script, and a grep over
`.github/workflows/` for `.test.js`, `test_`, or `npm test` returns zero hits. All 19
`api/_lib/*.test.js` and all 13 `scripts/test_*.py` are run by hand. So the smallest *effective*
set includes one line of wiring.

**Shape constraint.** Every existing `api/_lib/*.test.js` tests only pure exported functions with
no DB connection (`db.cache.test.js:3` says so outright). There is no fixture, no mock pool, and
no way in this codebase to assert on a WHERE clause from JS. That dictates the design: **the team
filter must be a pure exported function that the SQL path also uses**, or it is untestable here.

1. **`api/_lib/db.callingTeams.test.js`** (new, `assert`-based, no DB) over one new pure export —
   `filterRosterByTeam(joinedRows, { teamId, isAdmin })`, applied after the two-query join at
   `api/_lib/db.js:2251-2272`. Five cases: a team-A member is returned for `teamId: A` and absent
   for `teamId: B`; a member with no `calling_agent_process` row (the default-Offline case at
   `:2259`) is absent for any non-null `teamId`; an unassigned row is absent for a TL;
   **`teamId: null` returns `[]`, not everything** — the fail-closed assertion, which catches the
   single most likely implementation error; and `teamId: undefined` returns everything unchanged,
   which is what keeps `api/escalation/[action].js:64` working.
2. **Extend `scripts/test_assign_ndr_leads.py`** rather than adding a file — it is the only
   executable guard on the Python boundary and it breaks anyway (`:75` asserts *exactly two*
   queries, `:61-63` pins a 7-column tuple). Add one positive isolation case in the existing
   `_fake_query` recorder style: the recorded `calling_agent_process` SQL contains a `team_id`
   predicate, the team ID is in `params`, and a returned team-B row does not appear in the
   eligible list. Then **flip the two fail-open tests (`:89-108`, and the `:177-179` empty-result
   branch) to assert empty, not global** — those two assertions are worth more than the isolation
   one, because that branch turns a transient DB error into a company-wide lead dump.
3. **One assertion in `db.cache.test.js`** that a team-keyed cache prefix is
   delimiter-terminated: `invalidateCache('calling:ndrLeadDates:1')` must not evict
   `calling:ndrLeadDates:10:`. `invalidateCache` is `startsWith`-based and already exported and
   already under test (`:39-43`) — two lines in a file that exists.
4. **The wiring**: a `"test"` script running `api/_lib/*.test.js`. Without it, 1–3 are
   documentation.

**Deliberately not included:** any HTTP-level or end-to-end test of `/api/admin/calling-agents`
or `/api/auth/presence`. There is no harness, building one is a bigger project than this feature,
and the checks above pin the two predicates (JS roster filter, Python roster query) that every
one of those routes funnels through. The route-level guarantee comes from a reviewable grep:
every `isCallingProcessAdmin` call site (`api/admin/[action].js:257`, `:323`, `:363`, `:411`,
`:438`, `:459`, `:482`; `api/ndr/upload.js:54`) must pair with a team resolution.

**Cheapest end-to-end check, needing no new instrumentation:** the five tab-badge integers
(`NdrCallingClient.js:1226-1230`) are visible without opening any tab and are each fed by a
different tap — three sheet-scoped, one roster, one prediction. If all five are correct for both
TLs, all the taps are scoped. If one is wrong, it names which tap leaked. Verify the time-of-day
heatmap by row count rather than by eye, because its whole-table relative colour scale
(`:1184-1190`) means one surviving foreign row corrupts the shading of every cell.

## Prerequisites — verified 2026-08-26

Checked live against the Sheets API (read-only) rather than assumed.

| # | Prerequisite | Status |
| --- | --- | --- |
| 1 | Team B sheet ID | **Done** — `1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg`, workbook titled "NDR Calling", tab gid `807446909` |
| 2 | Shared with `GOOGLE_SHEETS_CLIENT_EMAIL` | **Done** — read access verified directly; Editor granted by the user on 2026-08-26 |
| 3 | Header row matches | **Done** — identical to Team A's sheet across all 28 columns (see below) |
| 4 | Agent→team assignment | User assigns agents by hand after the column lands |

### Team B's tab is also named `'Latest NDR '`

Confirmed: gid `807446909` is titled `Latest NDR ` — the same name, trailing space included, as
Team A's tab. This makes the read-cache collision described under "Fix the read cache key" a
**demonstrated** fact rather than a hypothetical: both teams will request byte-identical range
strings like `'Latest NDR '!A2:Q1000000`, which collide on the `values:${range}` cache key inside
any warm Lambda container. The cache key fix is mandatory, not defensive.

Team B's workbook carries seven other tabs (`After call: Reorder/Reattempt`,
`Datewise-NDRComparison`, `Sheet8`, `Sheet9`, `Sheet1`, `Sheet4`, `Sheet2`). Only `Latest NDR ` is
in scope, which is why `calling_teams.sheet_tab` is stored per team rather than assumed.

### Both sheets share one header — and it never matched the code

The two headers are identical across all 17 columns (`A:Q`):

```
A Order ID          B Customer Name    C Customer Email   D Customer Mobile
E AWB               F Partner name     G "Address "       H Pincode
I City              J State            K Order Value      L Payment Mode
M Status            N Is Buyer Response Received          O Attempt Count
P Latest NDR Date   Q Latest NDR Reason
```

That is the good news for this project: registering Team B's sheet requires no layout work, and
the registration-time header check proposed above will pass it.

**It also exposed a live pre-existing bug.** `NDR_EXPECTED_SHEET_HEADER.F` was `'Partner'`, while
both live sheets say `'Partner name'`. `normalizeHeader` strips non-alphanumerics, so
`partnername !== partner`, and `checkSheetLayout` therefore returned an issue on **every** NDR
upload — which `api/ndr/upload.js:161-169` turns into an HTTP 500, "Sheet column layout has
changed unexpectedly - refusing to append". The wrong expectation shipped in the same commit as
the feature (`71a84ea`), so **NDR CSV upload has never once succeeded.** Verified by running the
real `checkSheetLayout` against the real header row.

Fixed as part of this project (one line, `api/_lib/ndrCsvImport.js`), which brings the count of
pre-existing bugs found during design to three. Note the file's own comment at `:43-44`
anticipated precisely this: "a wrong expectation here surfaces as a refusal that names the real
text rather than as bad data" — the design worked, nobody had read the refusal.

`G` is `"Address "` with a trailing space in both sheets; that one is harmless because
`normalizeHeader` strips it.

### No routing column exists — the destination cannot be inferred from the data

Read the full header row of both sheets (`A:BB`). Both carry exactly 28 columns and are identical
to each other:

```
A..Q  as above (the upload window)
R Calling Date      S Agent Name       T Connected        U Outcome
V Did you receive any call from the delivery agent?
W Final_status      X Unique           Y,Z,AA (blank)     AB Remarks
```

**Neither sheet has a team, region, or routing column.** Nothing in an uploaded CSV — and nothing
in the sheet it lands in — identifies which team a lead belongs to. The destination is therefore
never inferable from content; it is decided entirely by who is uploading (see "How the upload
destination is decided" below). Recorded here so nobody later tries to derive it from a column.

Also worth noting for the team-registration header check: `S Agent Name` is the column the cron
and the claim-on-open path write to (`scripts/assign_ndr_leads.py`'s column constants), and it
already exists in Team B's sheet — so no per-team setup is needed for assignment writes either.

## How the upload destination is decided

| Uploader | Destination | Mechanism |
| --- | --- | --- |
| TL (`is_process_admin` for `ndr`) | Their own team's sheet | Derived server-side from their own `calling_agent_process.team_id`. No choice is offered and no client-supplied value is consulted, so a TL cannot target the other team's sheet at all |
| Full admin (`users.is_admin`) | Must be chosen explicitly | Admins hold no `calling_agent_process` row by convention, so there is nothing to derive. The team ID arrives in the request body, authorised by `session.isAdmin` and validated against `calling_teams` |
| TL whose `team_id IS NULL` | Refused, HTTP 400 | "You are not assigned to a team." Never a fallback to the incumbent sheet |
| Ordinary agent | Refused | Already blocked by the existing gate at `api/ndr/upload.js:52` |

**A missing team ID from an admin is a 400, never a default.** No "first team", no "the legacy
sheet". A silent default writes hundreds of leads into the wrong team's live sheet, and the only
remedy is deleting rows by hand from a sheet someone else is actively working.

The modal names the destination team and sheet above the Upload button, and the response reports
which team and sheet the rows actually landed in.

### Cross-team duplicate rejection

`readExistingKeySet` (`api/ndr/upload.js:80`) currently reads columns `E` (AWB) and `O` (Attempt
Count) from **the target sheet only**, keyed on `(AWB, Attempt Count)` via `dedupKey`. Left as-is,
the same `(AWB, Attempt)` pair could be uploaded into both teams' sheets and pass dedup in each,
because neither read sees the other sheet.

That is not a cosmetic duplicate. It lands both teams a live lead with the same AWB, which
triggers exactly the mirror corruption documented under "Deliberately NOT changed:
`ndr_lead_assignments`" — team B's claim silently `INSERT IGNORE`s to nothing while team B's
disposal overwrites team A's live cycle, and the cron *steals* the row outright.

**Decision: upload also reads the AWB and Attempt columns of every other active team's sheet and
rejects matching rows**, reported as their own count and reason ("already in <team name>'s sheet"),
alongside the existing duplicate/missing-AWB/unreadable-AWB buckets. Cost is one extra two-column
`batchGet` per other team, behind the same 20-second read cache.

This is the only available guard, since the real fix — putting attempt count into the mirror's
uniqueness — is deliberately out of scope. Chosen on the author's judgement after the question was
raised with the user and left open; cheap to reverse to target-sheet-only dedup if the extra read
proves unwelcome.
