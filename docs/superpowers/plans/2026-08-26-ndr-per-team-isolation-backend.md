# NDR Per-Team Isolation — Backend — Implementation Plan (Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give NDR Calling a server-enforced team dimension — a `calling_teams` registry, a
`team_id` on each agent, and team-scoped reads/writes across every NDR API route — so two team
leaders can work different sheets with different agents and neither can see or touch the other's
data.

**Architecture:** A team is a new dimension *inside* the existing `ndr` process, not a new
process. One new table (`calling_teams`), one new nullable column
(`calling_agent_process.team_id`), and one new pure module (`api/_lib/callingTeams.js`) holding
the scoping decisions so they are unit-testable without a database. Every route derives the
caller's team server-side from their own `calling_agent_process` row; the client never supplies a
team ID for scoping, with one exception (a full admin explicitly choosing which team to view or
upload to, authorised by `session.isAdmin`).

**Tech Stack:** Node 22 CommonJS on Lambda behind API Gateway (`api/`), MySQL 8 via `mysql2/promise`
against schema `PEP_CLS`, Google Sheets v4 via `google-auth-library` JWT, Python 3 + `mysql_lib`
for one-off migrations. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md`

**Scope:** Backend only — schema, DB layer, API routes, and the three pre-existing bugs the design
uncovered. The NDR frontend (`app/ndr-calling/`) and the Python assignment robot
(`scripts/assign_ndr_leads.py`) are Part 2, because until a second team row exists this plan
changes nothing anyone can see, which makes it independently shippable and reviewable.

## Global Constraints

- **Schema is `PEP_CLS`.** Every `sql` call already runs against it; never hardcode a schema
  prefix. A `1142` denial means the wrong schema, not a missing GRANT.
- **`ensureSchema()` can create tables, never alter them.** `CREATE TABLE IF NOT EXISTS` is inert
  against a live table, and there is no `ALTER TABLE` anywhere in `api/`. Any column change is a
  hand-run Python script.
- **`api/` and `app/` deploy separately** (Lambda via `.github/workflows/deploy.yml` on
  `paths: api/**`; Amplify on its own trigger). Both "app newer than api" and "api newer than app"
  are routine. Every new response field must be optional with a today-equivalent default, and the
  server must ignore unexpected request fields rather than rejecting them.
- **Absence semantics are opposite between two tables, one join apart.** No rows in
  `report_tab_permissions` for a `(user, card)` pair means *full access to every tab*
  (`api/_lib/db.js:134-135`). No row in `calling_agent_process` means *no team*. Never conflate them.
- **A full admin (`users.is_admin`) holds no `calling_agent_process` row and an empty `tabPerms`.**
  Both TLs must remain `is_process_admin`, never `is_admin` — `is_admin` bypasses every boundary in
  this plan.
- **Never trust a client-supplied team ID for scoping.** The sole exception is a full admin's
  explicit team choice, which is validated against `calling_teams` and authorised by
  `session.isAdmin`.
- **Tests are pure-function only, `assert`-based, no DB connection**, matching every existing
  `api/_lib/*.test.js`. Run with `node api/_lib/<name>.test.js`.
- **Commit style:** Conventional Commits (`fix(ndr):`, `feat(ndr):`), ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Live sheet IDs:** Team A `12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI`, Team B
  `1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg`. Both use tab `Latest NDR ` (trailing space is
  significant) and share an identical 28-column `A:AB` header.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `api/_lib/callingTeams.js` | **New.** Pure scoping logic: `teamScopeFor`, `filterRosterByTeam`, `isValidSheetId`, `normalizeTeamName`. No DB, no I/O — this is the testable core of the whole feature. |
| `api/_lib/callingTeams.test.js` | **New.** `assert`-based tests for the above. |
| `api/_lib/db.js` | `calling_teams` DDL; team CRUD; `resolveCallerTeam`; `teamId` threading into `getCallingProcessAgents` / `setCallingProcessAgent`; team-keyed cache slots. |
| `api/_lib/ndrCsvImport.js` | Header expectation fix (`Partner` → `Partner name`). |
| `api/admin/[action].js` | Team CRUD endpoints; team-scoping the three `calling-agents` methods; locking hours + dispositions to full admin. |
| `api/auth/[action].js` | Team-scoping `presence`, `processPresence`, `leadDates`; adding the missing `leadDates` permission gate. |
| `api/ndr/sheet.js` | Server-side sheet resolution; drop client `sid`; team-keyed read cache. |
| `api/ndr/upload.js` | Resolve the destination sheet from the uploader; cross-team duplicate rejection. |
| `api/ndr/lead-assignment.js` | Stop trusting a client-supplied assignee email. |
| `scripts/migrate_ndr_team_id.py` | **New.** Hand-run, dry-run-by-default migration adding `calling_agent_process.team_id`. |
| `package.json` | A `test` script, so the tests above actually run. |

---

## Task 1: Fix the NDR sheet header expectation

The design's verification found `NDR_EXPECTED_SHEET_HEADER.F` was `'Partner'` while both live
sheets say `'Partner name'`. `normalizeHeader` strips non-alphanumerics, so `partnername !==
partner`, `checkSheetLayout` returned an issue on every upload, and `api/ndr/upload.js:161-169`
turned that into an HTTP 500. **NDR CSV upload has never succeeded since it shipped in `71a84ea`.**
Independent of teams; ships first.

**Files:**
- Modify: `api/_lib/ndrCsvImport.js:46-61` (the `NDR_EXPECTED_SHEET_HEADER` literal)
- Test: `api/_lib/ndrCsvImport.test.js` (exists — add a case)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new. `NDR_IMPORT.expectedHeader.F === 'Partner name'`.

- [ ] **Step 1: Write the failing test**

Append to `api/_lib/ndrCsvImport.test.js`:

```js
// The real header row of both live NDR sheets, read from the Sheets API on 2026-08-26. Pinned
// here so a future edit to NDR_EXPECTED_SHEET_HEADER that drifts from the live sheet fails
// loudly instead of silently 500-ing every upload, which is exactly what shipped in 71a84ea.
const LIVE_NDR_HEADER_ROW = [
  'Order ID', 'Customer Name', 'Customer Email', 'Customer Mobile', 'AWB', 'Partner name',
  'Address ', 'Pincode', 'City', 'State', 'Order Value', 'Payment Mode', 'Status',
  'Is Buyer Response Received', 'Attempt Count', 'Latest NDR Date', 'Latest NDR Reason',
];

{
  const { checkSheetLayout } = require('./rtoCsvImport');
  const issues = checkSheetLayout(LIVE_NDR_HEADER_ROW, NDR_IMPORT.expectedHeader);
  assert.deepStrictEqual(issues, [], `expected no layout drift against the live header, got: ${issues.join('; ')}`);
  console.log('ok - NDR_EXPECTED_SHEET_HEADER matches the live sheet header row');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/ndrCsvImport.test.js`
Expected: FAIL — `AssertionError`, message contains `Column F is now "Partner name", expected "Partner"`.

- [ ] **Step 3: Write minimal implementation**

In `api/_lib/ndrCsvImport.js`, inside `NDR_EXPECTED_SHEET_HEADER`, replace `F: 'Partner',` with:

```js
  // 'Partner name', not 'Partner' - verified against the live header row of both NDR sheets
  // (2026-08-26). The original 'Partner' never matched, so checkSheetLayout failed every NDR
  // upload with "Sheet column layout has changed unexpectedly" from the day this shipped.
  F: 'Partner name',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/ndrCsvImport.test.js`
Expected: PASS — including the pre-existing cases in that file.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/ndrCsvImport.js api/_lib/ndrCsvImport.test.js
git commit -m "fix(ndr): correct sheet header expectation that broke every CSV upload"
```

---

## Task 2: Stop `claim` trusting a client-supplied agent email

`api/ndr/lead-assignment.js:40` reads
`claimNdrLead(awbNumber, (req.body || {}).email || session.email)` — the assignee is
client-supplied. The comment at `:46-47` claims the value is "stamped from the session, never
client-supplied, same as 'claim'", which is true of `dispose` at `:48` and false of `claim`. Any
NDR agent can attribute a claim to anyone, across teams once teams exist.

**Files:**
- Modify: `api/ndr/lead-assignment.js:38-42`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Behaviour change only.

- [ ] **Step 1: Read the current code to confirm the shape**

Run: `sed -n '36,52p' api/ndr/lead-assignment.js`
Expected: the `claim` branch passes `(req.body || {}).email || session.email`; the `dispose`
branch passes `session.email`.

- [ ] **Step 2: Make the claim path session-stamped**

Replace the `claim` branch body:

```js
    if (action === 'claim') {
      // Stamped from the session, never from the body: an agent may only ever claim a lead as
      // THEMSELVES. This previously honoured req.body.email, which let any NDR agent attribute
      // a claim to any other agent - across teams, once per-team isolation exists.
      await claimNdrLead(awbNumber, session.email);
      res.status(200).json({ ok: true });
      return;
    }
```

- [ ] **Step 3: Correct the now-accurate comment on the dispose branch**

The comment above `dispose` says "same as 'claim'" — that was aspirational. Make it factual:

```js
      // email: only used if no live row exists to update, in which case disposeNdrLead inserts
      // the cycle itself - stamped from the session, never client-supplied, same as 'claim'
      // above (which was fixed to match this).
```

- [ ] **Step 4: Verify no caller depended on sending an email**

Run: `grep -rn "lead-assignment" app/ --include=*.js`
Expected: the call sites in `app/ndr-calling/NdrCallingClient.js` may still send `email` in the
body. That is fine and must stay fine — the server now ignores it, which is exactly the
api-newer-than-app tolerance the Global Constraints require. Confirm no client reads a response
field that changes. There is none; the response is `{ ok: true }`.

- [ ] **Step 5: Commit**

```bash
git add api/ndr/lead-assignment.js
git commit -m "fix(ndr): stamp lead claims from the session, not the request body"
```

---

## Task 3: Add the missing permission gate to `/api/auth/leadDates`

`api/auth/[action].js:355-368` gates only on `session && session.email` — no `calling` card check,
no `ndr` tab check — then returns every live NDR AWB with its assignment and disposal timestamps,
unbounded. Any signed-in user of the entire site can enumerate NDR lead volumes and pacing.

**Files:**
- Modify: `api/auth/[action].js:355-368` (`handleLeadDates`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `handleLeadDates` keeps its `{ leadDates }` response shape.

- [ ] **Step 1: Read the current handler**

Run: `sed -n '355,370p' api/auth/[action].js`
Expected: exactly the un-gated shape described above.

- [ ] **Step 2: Add the card/tab gate**

Replace the body of `handleLeadDates` with:

```js
async function handleLeadDates(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  // This returns every live lead's assign/dispose timestamps, which is the whole desk's volume
  // and pacing - so it needs the same card+tab gate every other calling route uses. It
  // previously checked only "is signed in", which handed the entire NDR and RTO lead timeline
  // to any signed-in user of the site regardless of which cards they hold.
  const processKey = (req.query && req.query.process) === 'ndr' ? 'ndr' : 'rto';
  if (!(session.perms || []).includes('calling')) {
    res.status(403).json({ error: 'You do not have access to Calling.' });
    return;
  }
  const tabs = session.tabPerms && session.tabPerms.calling;
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(processKey)) {
    res.status(403).json({ error: 'You do not have access to that process.' });
    return;
  }
  const leadDates = processKey === 'ndr' ? await getAllNdrLeadDates() : await getAllLeadDates();
  res.status(200).json({ leadDates });
}
```

- [ ] **Step 3: Verify the callers still pass the gate**

Run: `grep -rn "leadDates" app/ --include=*.js | head`
Expected: `app/ndr-calling/NdrCallingClient.js` and `app/rto-crm/RtoCrmClient.js` call it while
already inside a page that requires the `calling` card, so every legitimate caller is unaffected.
Confirm the `?process=` value each one sends matches the tab it needs.

- [ ] **Step 4: Confirm no behaviour change for an entitled user**

Run: `node -e "require('./api/auth/[action].js'); console.log('module loads')"`
Expected: prints `module loads` — a syntax/require check only; there is no DB-free way to exercise
this handler in this repo, which is why the gate is written to mirror the identical, already-proven
check in `api/ndr/sheet.js:30-35`.

- [ ] **Step 5: Commit**

```bash
git add "api/auth/[action].js"
git commit -m "fix(calling): gate leadDates behind the calling card and process tab"
```

---

## Task 4: The pure scoping module

Everything team-related that can be decided without I/O lives here, because this repo's tests can
only exercise pure exported functions (`api/_lib/db.cache.test.js:3` says so outright). Putting
the scoping rules here is what makes the isolation testable at all.

**Files:**
- Create: `api/_lib/callingTeams.js`
- Test: `api/_lib/callingTeams.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, all used by Tasks 7–14:
  - `teamScopeFor({ callerTeamId, activeTeamCount, explicitTeamId, isAdmin }) -> number | null | undefined`
  - `filterRosterByTeam(rows, teamId) -> rows` where each row has a `teamId` property
  - `isValidSheetId(s) -> boolean`
  - `normalizeTeamName(s) -> string`
  - `teamCacheKey(base, teamId) -> string` (added in Task 13 Step 4)
  - `SHEET_ID_MAX`, `TEAM_NAME_MAX`

- [ ] **Step 1: Write the failing test**

Create `api/_lib/callingTeams.test.js`:

```js
// Pure-function tests for the NDR per-team scoping rules. No DB, no network - same shape as
// db.cache.test.js and db.redispose.test.js. Run: node api/_lib/callingTeams.test.js
const assert = require('assert');
const {
  teamScopeFor, filterRosterByTeam, isValidSheetId, normalizeTeamName,
} = require('./callingTeams');

// ── teamScopeFor: the single place the release-1 "one team means no scoping" rule lives ──
// undefined = apply no team filter at all; null = fail closed (return nothing); a number = that team.

// Before a second team exists, nothing is scoped - the desk behaves exactly as it did before
// this feature, which is what makes the migration and the api/ deploy order-independent.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 0 }), undefined);
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 1 }), undefined);
assert.strictEqual(teamScopeFor({ callerTeamId: 7, activeTeamCount: 1 }), undefined);

// Once two teams exist, a caller with a team is scoped to it...
assert.strictEqual(teamScopeFor({ callerTeamId: 7, activeTeamCount: 2 }), 7);
// ...and a caller WITHOUT one fails closed rather than seeing everything.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 2 }), null);

// A full admin's explicit choice wins, and is the ONLY way a client value reaches this.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 2, explicitTeamId: 3, isAdmin: true }), 3);
// The same field from a non-admin is ignored outright - not an error, just not honoured.
assert.strictEqual(teamScopeFor({ callerTeamId: 7, activeTeamCount: 2, explicitTeamId: 3, isAdmin: false }), 7);
// An admin who picks nothing sees everything, which is what the team selector's "All teams" is.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 2, isAdmin: true }), undefined);

// ── filterRosterByTeam ──
const ROSTER = [
  { email: 'a@x.com', teamId: 1 },
  { email: 'b@x.com', teamId: 2 },
  { email: 'c@x.com', teamId: null }, // invited but unassigned, or has no state row at all
];

// undefined means "no scoping requested" - returns the array untouched. This is what keeps
// api/escalation/[action].js and the RTO CRM working without passing a team at all.
assert.strictEqual(filterRosterByTeam(ROSTER, undefined), ROSTER);
// A real team returns only its own members...
assert.deepStrictEqual(filterRosterByTeam(ROSTER, 1).map(r => r.email), ['a@x.com']);
assert.deepStrictEqual(filterRosterByTeam(ROSTER, 2).map(r => r.email), ['b@x.com']);
// ...and never the unassigned rows, whose team_id is NULL.
assert.ok(!filterRosterByTeam(ROSTER, 1).some(r => r.teamId === null));
// null fails CLOSED. This is the single most likely implementation error - returning everything
// on a null team would hand one TL the other's whole roster.
assert.deepStrictEqual(filterRosterByTeam(ROSTER, null), []);

// ── isValidSheetId: shape-only guard on an admin-typed field that steers a service account ──
assert.strictEqual(isValidSheetId('1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg'), true);
assert.strictEqual(isValidSheetId('12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI'), true);
assert.strictEqual(isValidSheetId(''), false);
assert.strictEqual(isValidSheetId(null), false);
assert.strictEqual(isValidSheetId('short'), false);
// A pasted URL is a mistake worth catching, not silently storing as an id.
assert.strictEqual(isValidSheetId('https://docs.google.com/spreadsheets/d/1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg/edit'), false);
// Anything that could break out of a URL path segment must be rejected.
assert.strictEqual(isValidSheetId('abc/../../evil'), false);
assert.strictEqual(isValidSheetId('abc def ghi jkl mno pqr'), false);

// ── normalizeTeamName ──
assert.strictEqual(normalizeTeamName('  Team  A  '), 'Team A');
assert.strictEqual(normalizeTeamName('\tNorth\n'), 'North');
assert.strictEqual(normalizeTeamName(null), '');

console.log('ok - callingTeams pure scoping rules');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/callingTeams.test.js`
Expected: FAIL — `Error: Cannot find module './callingTeams'`.

- [ ] **Step 3: Write minimal implementation**

Create `api/_lib/callingTeams.js`:

```js
// Pure scoping rules for NDR Calling's per-team isolation - no DB, no network, no I/O, so the
// rules that decide who sees whose data are unit-testable in a repo whose tests cannot open a
// connection (see db.cache.test.js's own note). api/_lib/db.js and the routes under api/ndr,
// api/admin and api/auth all defer to these functions rather than reimplementing the checks,
// which is what keeps one route from quietly disagreeing with another.
//
// See docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md.

// Google Sheets file ids are URL-path segments for this app's Sheets calls, so the guard is
// deliberately a strict allowlist of the characters Google actually uses (alphanumeric, - and _)
// rather than a blocklist: a value containing '/' or '..' would otherwise re-target the service
// account's request path, and the account has Editor access. Length range covers the ids in use
// (44 chars) with room either side; anything outside it is a paste error, not an id.
const SHEET_ID_MAX = 128;
const TEAM_NAME_MAX = 120;
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,128}$/;

function isValidSheetId(s) {
  return typeof s === 'string' && SHEET_ID_RE.test(s);
}

function normalizeTeamName(s) {
  return (s == null ? '' : String(s)).trim().replace(/\s+/g, ' ').slice(0, TEAM_NAME_MAX);
}

// The ONE place the release-1 softening lives, so it is greppable and removable in a single edit.
//
// Returns:
//   undefined -> apply no team filter (single-team desk, or an admin viewing everything)
//   null      -> fail closed, return nothing (two teams exist and this caller belongs to none)
//   number    -> scope to exactly this team
//
// Why undefined rather than null while fewer than two teams exist: the team_id column arrives by
// a hand-run migration while the api/ code that reads it deploys automatically in about a minute
// (see the spec's rollout section). Failing closed in that window is not a safety property - it
// drops every existing agent off their own roster and, because the client learns isProcessAdmin
// by finding itself in that roster, silently costs the TL their Admin Panel. Behaving exactly
// like today until a second team is deliberately created makes the whole rollout
// order-independent, and the isolation switches on with a data change rather than a deploy.
function teamScopeFor({ callerTeamId = null, activeTeamCount = 0, explicitTeamId = null, isAdmin = false } = {}) {
  if (isAdmin && explicitTeamId != null) return explicitTeamId;
  if (activeTeamCount < 2) return undefined;
  if (isAdmin) return undefined; // an admin who picked no team sees every team
  return callerTeamId == null ? null : callerTeamId;
}

// Applied to the joined roster rows AFTER getCallingProcessAgents' two queries are combined in
// JS, because membership and per-process state come from different queries there.
function filterRosterByTeam(rows, teamId) {
  if (teamId === undefined) return rows;
  if (teamId === null) return [];
  return (rows || []).filter((r) => r && r.teamId === teamId);
}

module.exports = {
  teamScopeFor, filterRosterByTeam, isValidSheetId, normalizeTeamName,
  SHEET_ID_MAX, TEAM_NAME_MAX,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/callingTeams.test.js`
Expected: PASS — `ok - callingTeams pure scoping rules`.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/callingTeams.js api/_lib/callingTeams.test.js
git commit -m "feat(ndr): add pure team-scoping rules with tests"
```

---

## Task 5: Wire up `npm test` so the tests actually run

`package.json` has no `test` script and no workflow references any test file, so all 19
`api/_lib/*.test.js` are run by hand or not at all. Without this, Tasks 1 and 4 are documentation.
Folded in here rather than left to the end because every later task adds assertions.

**Files:**
- Modify: `package.json` (the `scripts` block)

**Interfaces:**
- Consumes: the test files from Tasks 1 and 4.
- Produces: `npm test` runs every `api/_lib/*.test.js` and exits non-zero if any fails. **Baseline
  is green** (19/19) — every later task expects a green suite.

- [ ] **Step 1: Read the current scripts block**

Run: `node -e "console.log(JSON.stringify(require('./package.json').scripts, null, 2))"`
Expected: `dev` and `build` only, confirming no `test` key to overwrite.

- [ ] **Step 2: Add the test script**

Add to `"scripts"` in `package.json`:

```json
    "test": "node --test \"api/_lib/**/*.test.js\""
```

The **quoted glob is required**. `node --test api/_lib/` (a bare directory) does not discover these
files — verified: it treats the directory as one test and dies with `MODULE_NOT_FOUND`. With the
glob quoted, Node does the expansion itself rather than the shell, so this works identically under
bash and cmd.exe. `--test-glob` is not available on this Node build. Exit codes verified: `1` when
any file fails, `0` when all pass.

This repo's tests are plain top-level `assert` scripts, not `node:test` suites — a throwing file is
a failing test, which is exactly how `--test` treats it. No framework, no config.

- [ ] **Step 3: Confirm the baseline is green**

Run: `npm test`
Expected: PASS — 19 tests, 19 pass, exit 0.

Two files used to fail here, and both were fixed before this plan began (see the commits ahead of
Task 1). Both were **stale tests, not code bugs** — worth knowing, because both had been red for
days without anyone noticing, which is precisely what this task exists to stop:

- `db.cache.test.js` asserted `CACHE_TTL_MS <= 120000`. `f123568` had deliberately widened the TTL
  from 30s to 300000ms to stop the NDR/RTO lead-date full-table reads blowing past Supabase's 5GB
  egress quota; the assertion was never moved. The bound is now pinned at the current value, so
  raising it again requires editing that line deliberately.
- `db.deliveryEscalation.test.js` asserted the pre-`4485e70` day-wise bucketing rule
  (`COALESCE(disposed_at, CURDATE())`, age as of today). `4485e70` deliberately redefined
  `'unresolved'` as exactly the Fresh tab's population and rewrote the explaining comment to match,
  which makes the age buckets measure real resolution time. It also pinned the old alphabetical
  `DE_DAYWISE_BUCKETS` order after `ee10e50` reordered them into ascending severity. Both
  assertions now match the documented intent, plus a new one that every bucket the CASE can emit
  appears in the display list.

- [ ] **Step 4: Verify the gate actually fails on a new failure**

A green baseline makes this a simple check:

```bash
node -e "require('fs').writeFileSync('api/_lib/__tmp.test.js','require(\"assert\").strictEqual(1,2);')"
npm test >/dev/null 2>&1; echo "exit with a broken test = $?"
rm -f api/_lib/__tmp.test.js
npm test >/dev/null 2>&1; echo "exit once removed = $?"
```
Expected: `exit with a broken test = 1`, then `exit once removed = 0`. Confirm the temp file is gone
with `git status --short api/_lib/`.

**From here on, every task's expectation is a green `npm test`.** Any red is something that task
just broke.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: run api/_lib tests via npm test"
```

---

## Task 6: `calling_teams` table

**Files:**
- Modify: `api/_lib/db.js` — add DDL inside `bootstrapSchema` (the block at `:101-427`), placed
  immediately after the `calling_agent_process` statement that ends at `:336` so the calling
  tables stay together.

**Interfaces:**
- Consumes: nothing.
- Produces: table `calling_teams`, relied on by Tasks 7–14.

- [ ] **Step 1: Read the neighbouring DDL to match style**

Run: `sed -n '302,340p' api/_lib/db.js`
Expected: the `calling_agent_process` `CREATE TABLE IF NOT EXISTS` and its comment block, which
this new statement sits directly after.

- [ ] **Step 2: Add the DDL**

Insert after the `calling_agent_process` `await sql\`...\`;` block:

```js
  // One row per team within a calling process. Teams are a dimension INSIDE a process, not
  // processes of their own: two NDR teams share the process's disposition tree, calling hours
  // and permission tab, and differ only in WHO is on them and WHICH sheet they work. See
  // docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md for why this is not
  // modelled as two process keys.
  //
  // sheet_id / sheet_tab: the team's own Google Sheet. Stored per team rather than hardcoded
  // because the two live NDR sheets are different files that happen to share a tab name
  // ('Latest NDR ', trailing space significant) - nothing guarantees a third would.
  // Writes to sheet_id are full-admin only (never is_process_admin): the service account has
  // Editor access, so whoever sets this steers it at an arbitrary spreadsheet.
  //
  // active: soft-delete. Deactivating a team is the intended way to reverse a rollout, since
  // isolation switches on at two ACTIVE teams - so this must never be a hard DELETE, which
  // would orphan the team_id on every calling_agent_process row pointing at it.
  await sql`
    CREATE TABLE IF NOT EXISTS calling_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      process_key VARCHAR(64) NOT NULL,
      name VARCHAR(120) NOT NULL,
      sheet_id VARCHAR(128) NOT NULL,
      sheet_tab VARCHAR(120) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(320),
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(320),
      UNIQUE KEY calling_teams_process_name_key (process_key, name),
      KEY calling_teams_process_active_idx (process_key, active)
    )
  `;
```

- [ ] **Step 3: Verify the file still parses and the statement is syntactically valid MySQL**

Run: `node -e "require('./api/_lib/db.js'); console.log('db.js loads')"`
Expected: prints `db.js loads`. (Requiring the module does not connect — the pool is created
lazily inside `getPool()`.)

- [ ] **Step 4: Verify the DDL text is well-formed**

Run: `node -e "
const s=require('fs').readFileSync('api/_lib/db.js','utf8');
const m=s.match(/CREATE TABLE IF NOT EXISTS calling_teams[\s\S]*?\)\n  \`/);
if(!m) throw new Error('calling_teams DDL not found');
const bal=[...m[0]].reduce((n,c)=>n+(c==='('?1:c===')'?-1:0),0);
console.log('parens balanced:', bal===0);
"`
Expected: `parens balanced: true`.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(ndr): add calling_teams table"
```

---

## Task 7: The `team_id` migration script

`ensureSchema` cannot add a column. This is the hand-run half of the schema, and per the spec it
must be applied and verified **before** any code that selects `team_id` reaches production —
otherwise `getCallingProcessAgents` throws `ER_BAD_FIELD_ERROR` on the hot path of the RTO CRM
roster, the Escalation desk, and NDR alike.

**Files:**
- Create: `scripts/migrate_ndr_team_id.py`

**Interfaces:**
- Consumes: `scripts/mysql_lib.py` (`get_conn` / `query`, matching
  `scripts/migrate_cls_rto_calling_schema.py`).
- Produces: column `calling_agent_process.team_id INT NULL` plus an index. No code depends on the
  script itself; Tasks 8+ depend on the column existing.

- [ ] **Step 1: Read the established migration pattern**

Run: `sed -n '40,80p' scripts/migrate_cls_rto_calling_schema.py` and
`sed -n '165,200p' scripts/migrate_cls_rto_calling_schema.py`
Expected: `argparse` with `--apply`, an `information_schema`-guarded plan built before any DDL
runs, the plan printed, and dry-run as the default. Match this exactly.

- [ ] **Step 2: Write the script**

Create `scripts/migrate_ndr_team_id.py`:

```python
#!/usr/bin/env python3
"""Adds PEP_CLS.calling_agent_process.team_id - the per-agent team membership behind NDR
Calling's two-team isolation (see docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md).

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER
TABLE anywhere in api/. So a new TABLE ships itself with the Lambda deploy while a new COLUMN
cannot - and api/ code that selects team_id deploys automatically in about a minute. Running
this BEFORE that deploy is not optional: a missing column throws ER_BAD_FIELD_ERROR inside
getCallingProcessAgents, which serves the RTO CRM roster and the Escalation desk as well as NDR.

NULL means "not assigned to a team". That is the inverse of report_tab_permissions' convention
(absence = unrestricted) and is deliberate; see the spec. Existing rows stay NULL, and reads
behave exactly as they do today until a second ACTIVE row exists in calling_teams, so applying
this early is safe and reversible.

Dry-run by default; --apply performs the DDL. Safe to re-run: an already-applied step is
detected and skipped, matching this repo's other one-off MySQL schema scripts.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib as lib  # noqa: E402

TABLE = "calling_agent_process"
SCHEMA = "PEP_CLS"


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def _index_exists(cur, index):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, TABLE, index),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL (default: dry run)")
    args = ap.parse_args()

    conn = lib.get_conn()
    try:
        cur = conn.cursor()
        plan = []

        if _column_exists(cur, "team_id"):
            print("team_id already present - skipping.")
        else:
            plan.append((
                "add team_id column",
                f"ALTER TABLE `{TABLE}` ADD COLUMN `team_id` INT NULL",
            ))

        if _index_exists(cur, "calling_agent_process_team_idx"):
            print("calling_agent_process_team_idx already present - skipping.")
        else:
            plan.append((
                "add (process_key, team_id) index",
                f"ALTER TABLE `{TABLE}` "
                "ADD KEY `calling_agent_process_team_idx` (`process_key`, `team_id`)",
            ))

        if not plan:
            print("\nNothing to do - schema already migrated.")
            return 0

        print("\nPlanned changes:")
        for label, stmt in plan:
            print(f"  - {label}\n      {stmt}")

        if not args.apply:
            print("\nDry run. Re-run with --apply to perform these changes.")
            return 0

        for label, stmt in plan:
            print(f"\nApplying: {label}")
            cur.execute(stmt)
        conn.commit()

        # Report the resulting state so the operator can confirm before deploying api/.
        cur.execute(
            f"SELECT COUNT(*) AS total, SUM(team_id IS NULL) AS unassigned FROM `{TABLE}` "
            "WHERE process_key = 'ndr'"
        )
        total, unassigned = cur.fetchone()
        print(f"\nDone. ndr rows: {total}, unassigned (team_id IS NULL): {unassigned}")
        print("Reads stay unscoped until calling_teams holds two ACTIVE rows.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Verify it parses and its help renders**

Run: `python -c "import ast,sys; ast.parse(open('scripts/migrate_ndr_team_id.py').read()); print('parses')"`
Expected: prints `parses`.

- [ ] **Step 4: Confirm dry-run is the default in the argument surface**

Run: `grep -n "add_argument\|args.apply" scripts/migrate_ndr_team_id.py`
Expected: a single `--apply` flag with `action="store_true"`, and the `if not args.apply: return`
guard before any `cur.execute(stmt)`. Do **not** run the script against the live database — the
operator runs it (dry run first, then `--apply`) as its own deliberate step.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate_ndr_team_id.py
git commit -m "feat(ndr): add migration for calling_agent_process.team_id"
```

---

## Task 8: Team CRUD and caller-team resolution in the DB layer

**Files:**
- Modify: `api/_lib/db.js` — add after `getAdministeredProcesses` (ends `:2382`), before the
  disposition section that starts at `:2384`.

**Interfaces:**
- Consumes: `api/_lib/callingTeams.js` (`isValidSheetId`, `normalizeTeamName`) from Task 4;
  the `calling_teams` table from Task 6; the `team_id` column from Task 7.
- Produces:
  - `listCallingTeams(processKey, { includeInactive = false }) -> [{ id, processKey, name, sheetId, sheetTab, active }]`
  - `getCallingTeam(id) -> team | null`
  - `createCallingTeam(processKey, { name, sheetId, sheetTab }, byEmail) -> team`
  - `updateCallingTeam(id, { name?, sheetId?, sheetTab?, active? }, byEmail) -> team`
  - `resolveCallerTeam(email, processKey) -> { callerTeamId, activeTeamCount }`

- [ ] **Step 1: Add the CRUD and resolver functions**

```js
// ── Per-team registry (calling_teams) ────────────────────────────────────────────────────
// A team is a dimension inside a process; see the table's own comment in bootstrapSchema.

const { isValidSheetId, normalizeTeamName } = require('./callingTeams');

function mapTeamRow(r) {
  return {
    id: r.id,
    processKey: r.process_key,
    name: r.name,
    sheetId: r.sheet_id,
    sheetTab: r.sheet_tab,
    active: !!r.active,
  };
}

async function listCallingTeams(processKey, { includeInactive = false } = {}) {
  await ensureSchema();
  if (!processKey) return [];
  const { rows } = includeInactive
    ? await sql`SELECT * FROM calling_teams WHERE process_key = ${processKey} ORDER BY name ASC`
    : await sql`SELECT * FROM calling_teams WHERE process_key = ${processKey} AND active = true ORDER BY name ASC`;
  return rows.map(mapTeamRow);
}

async function getCallingTeam(id) {
  await ensureSchema();
  const teamId = parseInt(id, 10);
  if (!Number.isFinite(teamId)) return null;
  const { rows } = await sql`SELECT * FROM calling_teams WHERE id = ${teamId} LIMIT 1`;
  return rows.length ? mapTeamRow(rows[0]) : null;
}

// sheetId is validated here as well as at the route, because this is the last line before a
// value an admin typed becomes the URL path of a request made with an Editor-scoped service
// account credential.
function assertTeamFields({ name, sheetId, sheetTab }) {
  const cleanName = normalizeTeamName(name);
  if (!cleanName) throw new Error('Team name is required');
  if (!isValidSheetId(sheetId)) {
    throw new Error('sheetId must be a Google Sheets file id (letters, digits, - and _ only) - not a full URL');
  }
  const cleanTab = (sheetTab == null ? '' : String(sheetTab));
  // NOT trimmed: the live NDR tab is literally named 'Latest NDR ' with a trailing space, and
  // trimming it would produce a range string Sheets cannot resolve.
  if (!cleanTab) throw new Error('sheetTab is required');
  return { cleanName, cleanTab };
}

async function createCallingTeam(processKey, { name, sheetId, sheetTab }, byEmail) {
  await ensureSchema();
  if (!processKey) throw new Error('processKey is required');
  const { cleanName, cleanTab } = assertTeamFields({ name, sheetId, sheetTab });
  const { insertId } = await sql`
    INSERT INTO calling_teams (process_key, name, sheet_id, sheet_tab, created_by, updated_by)
    VALUES (${processKey}, ${cleanName}, ${sheetId}, ${cleanTab}, ${byEmail || null}, ${byEmail || null})
  `;
  invalidateCache(`calling:teams:${processKey}`);
  return getCallingTeam(insertId);
}

async function updateCallingTeam(id, { name, sheetId, sheetTab, active }, byEmail) {
  await ensureSchema();
  const existing = await getCallingTeam(id);
  if (!existing) throw new Error('No such team');
  const next = {
    name: name === undefined ? existing.name : name,
    sheetId: sheetId === undefined ? existing.sheetId : sheetId,
    sheetTab: sheetTab === undefined ? existing.sheetTab : sheetTab,
  };
  const { cleanName, cleanTab } = assertTeamFields(next);
  const nextActive = active === undefined ? existing.active : !!active;
  await sql`
    UPDATE calling_teams
       SET name = ${cleanName}, sheet_id = ${next.sheetId}, sheet_tab = ${cleanTab},
           active = ${nextActive}, updated_at = NOW(), updated_by = ${byEmail || null}
     WHERE id = ${existing.id}
  `;
  invalidateCache(`calling:teams:${existing.processKey}`);
  return getCallingTeam(existing.id);
}

// The caller's own team, plus how many ACTIVE teams the process has - both inputs to
// teamScopeFor(). Returns callerTeamId null for anyone with no calling_agent_process row, which
// includes every full admin by convention (see getCallingProcessAgents' own note).
//
// Deliberately NOT cached: a stale answer here is a stale ANSWER TO "whose data may I see",
// and readCache is per-warm-container with a 5-minute TTL, so an agent moved between teams
// could keep reading the old team for minutes. The two SELECTs are indexed point reads.
async function resolveCallerTeam(email, processKey) {
  await ensureSchema();
  if (!email || !processKey) return { callerTeamId: null, activeTeamCount: 0 };
  const [{ rows: mine }, { rows: counted }] = await Promise.all([
    sql`
      SELECT team_id FROM calling_agent_process
      WHERE LOWER(email) = ${String(email).toLowerCase()} AND process_key = ${processKey}
      LIMIT 1
    `,
    sql`SELECT COUNT(*) AS n FROM calling_teams WHERE process_key = ${processKey} AND active = true`,
  ]);
  return {
    callerTeamId: mine.length && mine[0].team_id != null ? mine[0].team_id : null,
    activeTeamCount: Number((counted[0] && counted[0].n) || 0),
  };
}
```

- [ ] **Step 2: Export the new functions**

Add `listCallingTeams`, `getCallingTeam`, `createCallingTeam`, `updateCallingTeam`,
`resolveCallerTeam` to `db.js`'s `module.exports`.

Run: `node -e "
const db=require('./api/_lib/db.js');
['listCallingTeams','getCallingTeam','createCallingTeam','updateCallingTeam','resolveCallerTeam']
  .forEach(n=>{ if(typeof db[n]!=='function') throw new Error('missing export: '+n); });
console.log('all team functions exported');
"`
Expected: prints `all team functions exported`.

- [ ] **Step 3: Verify the validation rejects a pasted URL without touching a DB**

`assertTeamFields` is reached before any query, so its guard is exercisable directly:

```bash
node -e "
const { isValidSheetId } = require('./api/_lib/callingTeams');
const url='https://docs.google.com/spreadsheets/d/1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg/edit';
if (isValidSheetId(url)) throw new Error('a full URL must not validate as a sheet id');
if (!isValidSheetId('1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg')) throw new Error('the real id must validate');
console.log('sheet id validation holds at the db boundary');
"
```
Expected: prints `sheet id validation holds at the db boundary`.

- [ ] **Step 4: Confirm the cache prefix is delimiter-terminated**

`invalidateCache` is `startsWith`-based, so `calling:teams:ndr` must not be a prefix of another
live key. Run: `grep -n "calling:teams\|invalidateCache('calling" api/_lib/db.js`
Expected: the only `calling:teams:` keys are the ones added here, each ending in a full process
key. Confirm no other cache key begins with `calling:teams`.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(ndr): add calling_teams CRUD and caller-team resolution"
```

---

## Task 9: Thread `teamId` through the roster read and write

**Files:**
- Modify: `api/_lib/db.js:2216-2275` (`getCallingProcessAgents`) and `:2277-2355`
  (`setCallingProcessAgent`)

**Interfaces:**
- Consumes: `filterRosterByTeam` (Task 4); the `team_id` column (Task 7).
- Produces:
  - `getCallingProcessAgents(processKey, teamId)` — `teamId` optional; `undefined` behaves exactly
    as today. Each returned row gains a `teamId` field.
  - `setCallingProcessAgent(processKey, email, { ..., teamId }, updatedBy)` — `teamId` accepts a
    number to assign, `null` to explicitly unassign, and `undefined` to leave untouched.

- [ ] **Step 1: Add `team_id` to the state query and the mapped row**

In `getCallingProcessAgents`, add `team_id` to the second query's `SELECT` list and expose it on
each returned row. The membership query is left completely alone — filtering happens in JS, after
the join, because membership and state come from different queries:

```js
    sql`
      SELECT email, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons,
             reassign_payment_mode, attempt_count_filter, ndr_reason_filter, ndr_payment_mode_filter,
             ndr_brand_filter, team_id, updated_at, updated_by
      FROM calling_agent_process WHERE process_key = ${processKey}
    `,
```

and in the `members.map(...)` result object, alongside `isProcessAdmin`:

```js
      // null means "no team", which for a team-scoped view means excluded - the inverse of the
      // report_tab_permissions convention where absence means unrestricted. See the spec.
      teamId: s && s.team_id != null ? s.team_id : null,
```

- [ ] **Step 2: Apply the filter and change the signature**

Change the declaration to `async function getCallingProcessAgents(processKey, teamId) {`, and
return through the pure filter instead of returning the mapped array directly:

```js
  const mapped = members.map((m) => { /* ...unchanged... */ });
  // teamId === undefined leaves this untouched, which is what keeps api/escalation/[action].js,
  // app/rto-crm/RtoCrmClient.js and app/escalation/EscalationClient.js working without change.
  return filterRosterByTeam(mapped, teamId);
```

Add `const { filterRosterByTeam } = require('./callingTeams');` near the other `_lib` requires.

- [ ] **Step 3: Give `setCallingProcessAgent` an explicit-unassign path for `team_id`**

The existing `COALESCE(${x}, col)` contract cannot express "set this to NULL", but the revoke path
must be able to clear a team — otherwise a revoked agent silently keeps membership and rejoins
that team's roster on re-invite. Use a sentinel flag so `undefined` (untouched) and `null`
(explicitly clear) are distinguishable:

```js
  // team_id needs three states, which COALESCE alone cannot express: undefined = leave alone,
  // a number = assign, null = explicitly unassign. The revoke path in api/admin/[action].js
  // depends on the third one; without it a revoked agent keeps their team membership and
  // rejoins that team's roster and metrics the moment anyone re-invites them.
  const touchTeam = teamId !== undefined;
  let teamValue = null;
  if (touchTeam && teamId !== null) {
    teamValue = parseInt(teamId, 10);
    if (!Number.isFinite(teamValue) || teamValue <= 0) throw new Error('teamId must be a positive whole number or null');
  }
```

Add `team_id` to the `INSERT` column list and values (`${touchTeam ? teamValue : null}`), and to
the `ON DUPLICATE KEY UPDATE` list:

```js
      team_id = IF(${touchTeam}, ${teamValue}, team_id),
```

Destructure `teamId` in the options parameter alongside `ndrBrandFilter`.

- [ ] **Step 4: Verify both call shapes still work and the filter is wired**

```bash
node -e "
const src=require('fs').readFileSync('api/_lib/db.js','utf8');
if(!/function getCallingProcessAgents\(processKey, teamId\)/.test(src)) throw new Error('signature not updated');
if(!/return filterRosterByTeam\(mapped, teamId\)/.test(src)) throw new Error('filter not applied');
if(!/team_id = IF\(/.test(src)) throw new Error('explicit-unassign path missing');
if(!/team_id, updated_at, updated_by/.test(src)) throw new Error('team_id not selected');
require('./api/_lib/db.js');
console.log('roster read/write threading looks right');
"
```
Expected: prints `roster read/write threading looks right`.

Then run `npm test` — Expected: PASS (19+ tests, exit 0), confirming `filterRosterByTeam`'s
contract is unchanged by its new caller and nothing else regressed.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(ndr): scope the calling roster by team"
```

---

## Task 10: Team CRUD endpoints

**Files:**
- Modify: `api/admin/[action].js` — add a `handleCallingTeams` function and register it in the
  action switch alongside `calling-agents`.

**Interfaces:**
- Consumes: `listCallingTeams`, `createCallingTeam`, `updateCallingTeam` (Task 8).
- Produces: `GET/POST/PUT /api/admin/calling-teams`. `GET` is readable by a process admin;
  `POST`/`PUT` are **full-admin only**.

- [ ] **Step 1: Find the action registration to match**

Run: `grep -n "calling-agents\|'business-hours'\|case '" api/admin/[action].js | head -20`
Expected: the dispatch table mapping action names to handlers. Register `calling-teams` the same
way.

- [ ] **Step 2: Add the handler**

```js
// GET    ?process=<key>       -> that process's teams (active only unless ?includeInactive=1)
// POST   { processKey, name, sheetId, sheetTab }        -> create   (FULL ADMIN ONLY)
// PUT    { id, name?, sheetId?, sheetTab?, active? }    -> update   (FULL ADMIN ONLY)
//
// Why writes are full-admin only and never isCallingProcessAdmin: both NDR team leads hold
// process-admin, and sheet_id decides which spreadsheet an Editor-scoped service account is
// pointed at. A process admin who could write it could redirect the credential at any sheet it
// can reach, or repoint the other team's sheet at their own. Reads are open to a process admin
// so a TL's own page can show its team name.
async function handleCallingTeams(req, res, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const known = CALLING_PROCESSES.processes.map((p) => p.key);

  if (req.method === 'GET') {
    const processKey = (req.query && req.query.process) || '';
    if (!known.includes(processKey)) {
      res.status(400).json({ error: `process must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    const includeInactive = session.isAdmin && !!(req.query && req.query.includeInactive);
    res.status(200).json({ teams: await listCallingTeams(processKey, { includeInactive }) });
    return;
  }

  if (!session.isAdmin) {
    res.status(403).json({ error: 'Only a full admin can create or change a team' });
    return;
  }

  const body = parseBody(req);

  if (req.method === 'POST') {
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    try {
      const team = await createCallingTeam(
        body.processKey,
        { name: body.name, sheetId: body.sheetId, sheetTab: body.sheetTab },
        session.email,
      );
      await logEvent(session.uid, session.email, 'calling', 'team-create',
        `${body.processKey}: ${team.name} -> ${team.sheetId}`, ip);
      res.status(200).json({ team });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not create team' });
    }
    return;
  }

  if (req.method === 'PUT') {
    try {
      const team = await updateCallingTeam(
        body.id,
        { name: body.name, sheetId: body.sheetId, sheetTab: body.sheetTab, active: body.active },
        session.email,
      );
      await logEvent(session.uid, session.email, 'calling', 'team-update',
        `${team.processKey}: ${team.name} active=${team.active} -> ${team.sheetId}`, ip);
      res.status(200).json({ team });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not update team' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
```

Import `listCallingTeams`, `createCallingTeam`, `updateCallingTeam` from `../_lib/db` at the top of
the file, and register `handleCallingTeams` for the `calling-teams` action.

- [ ] **Step 3: Verify the route is reachable and the guard ordering is right**

```bash
node -e "
const src=require('fs').readFileSync('api/admin/[action].js','utf8');
if(!/calling-teams/.test(src)) throw new Error('action not registered');
const h=src.slice(src.indexOf('async function handleCallingTeams'));
const getIdx=h.indexOf(\"req.method === 'GET'\"), adminIdx=h.indexOf('!session.isAdmin');
if(!(getIdx>-1 && adminIdx>getIdx)) throw new Error('the full-admin gate must sit AFTER the GET branch, or a TL cannot read its own team name');
require('./api/admin/[action].js');
console.log('calling-teams registered, admin gate correctly placed after GET');
"
```
Expected: prints the confirmation line.

- [ ] **Step 4: Confirm no write path can be reached by a process admin**

Run: `sed -n "/async function handleCallingTeams/,/^}/p" api/admin/[action].js | grep -n "isCallingProcessAdmin\|isAdmin"`
Expected: `isCallingProcessAdmin` appears **only** inside the `GET` branch; every path past the
`GET` return checks `session.isAdmin`. There must be no `isCallingProcessAdmin` after the gate.

- [ ] **Step 5: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "feat(ndr): add admin-only calling-teams CRUD endpoints"
```

---

## Task 11: Lock shared per-process settings to full admin

Per the confirmed scope decision, Calling Hours and the disposition tree stay shared between both
NDR teams — so neither TL may edit them, or one TL could change when the other team's leads are
handed out, or rename a disposition the other team's agents pick from (and
`app/ndr-calling/NdrCallingClient.js:404,411` branch on those literal labels).

**Files:**
- Modify: `api/admin/[action].js` — `handleBusinessHours` (`:248`) and the five disposition
  mutators inside `handleDispositions` (`:428`)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `GET` stays open to a process admin; every mutation becomes
  full-admin only.

- [ ] **Step 1: Enumerate every current gate**

Run: `grep -n "isCallingProcessAdmin" api/admin/[action].js`
Expected: call sites at roughly `:257`, `:323`, `:363`, `:411`, `:438`, `:459`, `:482`. Note which
belong to business hours and dispositions — those are the ones this task changes. The
`calling-agents` ones are Task 12's.

- [ ] **Step 2: Restrict the business-hours mutation**

In `handleBusinessHours`, leave the `GET` branch as-is and gate the write:

```js
  // Calling hours are per-PROCESS and shared by every team on that process, so a process admin
  // editing them would change when the OTHER team's leads are handed out. Reads stay open to a
  // process admin (their page shows the window); writes are full-admin only.
  if (req.method !== 'GET' && !session.isAdmin) {
    res.status(403).json({ error: 'Only a full admin can change calling hours' });
    return;
  }
```

- [ ] **Step 3: Restrict the disposition mutations**

In `handleDispositions`, after the `GET` branch and before any add/edit/reorder/delete work:

```js
  // The disposition tree is per-PROCESS and shared by every team, and NDR's calling flow
  // branches on specific literal labels (see NdrCallingClient.js's saveNdrDisposition), so a
  // rename by one team's lead can break the other team's metrics. Writes are full-admin only.
  if (req.method !== 'GET' && !session.isAdmin) {
    res.status(403).json({ error: 'Only a full admin can change the disposition list' });
    return;
  }
```

- [ ] **Step 4: Verify only reads remain open to a process admin**

```bash
node -e "
const src=require('fs').readFileSync('api/admin/[action].js','utf8');
for (const fn of ['handleBusinessHours','handleDispositions']) {
  const body=src.slice(src.indexOf('async function '+fn));
  const end=body.indexOf('\nasync function ', 1);
  const seg=end>-1?body.slice(0,end):body;
  if(!/req\.method !== 'GET' && !session\.isAdmin/.test(seg)) throw new Error('missing full-admin write gate in '+fn);
}
require('./api/admin/[action].js');
console.log('hours and dispositions are read-only for a process admin');
"
```
Expected: prints the confirmation line.

- [ ] **Step 5: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "feat(ndr): restrict shared calling hours and dispositions to full admins"
```

---

## Task 12: Team-scope the three `calling-agents` methods

`handleCallingAgents` gates all three methods on `isCallingProcessAdmin(email, 'ndr')`, which both
TLs hold. Today that lets TL A read TL B's whole roster (emails, quotas, per-agent filters), set
their agents' status and quota, and revoke their NDR access outright. Reads *and* writes must be
scoped, and the write path must stop answering with the whole roster.

**Files:**
- Modify: `api/admin/[action].js:313-418` (`handleCallingAgents`)

**Interfaces:**
- Consumes: `resolveCallerTeam` (Task 8), `teamScopeFor` (Task 4),
  `getCallingProcessAgents(processKey, teamId)` (Task 9), `setCallingProcessAgent`'s `teamId`
  option (Task 9).
- Produces: `GET` response gains an optional `teamId` and `teams` field; `POST` response's
  `agents` becomes team-scoped. Both additive — an older client ignores them.

- [ ] **Step 1: Add a shared scope helper at the top of the handler**

```js
// The caller's team, resolved server-side from their own calling_agent_process row - never from
// the request, because /rto-crm?process=ndr reaches this same endpoint from a page with no NDR
// team context at all (see RtoCrmClient.js:400-422). A full admin may pass an explicit teamId to
// view or act on one team; teamScopeFor ignores that field for everyone else.
async function scopeFor(session, processKey, explicitTeamId) {
  const { callerTeamId, activeTeamCount } = await resolveCallerTeam(session.email, processKey);
  return {
    teamId: teamScopeFor({
      callerTeamId,
      activeTeamCount,
      explicitTeamId: explicitTeamId == null ? null : parseInt(explicitTeamId, 10),
      isAdmin: session.isAdmin,
    }),
    callerTeamId,
    activeTeamCount,
  };
}
```

- [ ] **Step 2: Scope the GET branch**

Replace the final `res.status(200).json({ statuses: CALLING_STATUSES, agents: await getCallingProcessAgents(processKey) });` with:

```js
  const { teamId, callerTeamId } = await scopeFor(session, processKey, req.query && req.query.teamId);
  res.status(200).json({
    statuses: CALLING_STATUSES,
    agents: await getCallingProcessAgents(processKey, teamId),
    // Returned as their own fields rather than left for the client to infer. app/_calling/
    // useCallingSession.js:133 currently learns isProcessAdmin by finding the caller inside the
    // roster - which breaks the moment the roster is team-filtered and the caller is unassigned
    // (the TL silently loses the whole Admin Panel with no error). Sending these explicitly is
    // what lets the client stop inferring.
    teamId: callerTeamId,
    isProcessAdmin: session.isAdmin || await isCallingProcessAdmin(session.email, processKey),
    teams: await listCallingTeams(processKey),
  });
```

- [ ] **Step 3: Scope the POST branch**

After the existing process-admin and `isProcessAdmin`-escalation checks, add a membership check
and scope the response:

```js
    const { teamId } = await scopeFor(session, processKey, body.teamId);
    // A process admin may only touch an agent on their OWN team. Checked by looking the target
    // up within the caller's scope rather than by trusting anything in the body.
    if (!session.isAdmin) {
      const scoped = await getCallingProcessAgents(body.processKey, teamId);
      const target = (body.email || '').trim().toLowerCase();
      if (!scoped.some((a) => a.email.toLowerCase() === target)) {
        res.status(403).json({ error: 'That agent is not on your team' });
        return;
      }
    }
    // Only a full admin may move someone between teams - the same reasoning as isProcessAdmin
    // above: a process admin who could set team_id could pull the other team's agents onto
    // their own roster, or push their own agents away to hide them.
    if (body.teamId !== undefined && !session.isAdmin) {
      res.status(403).json({ error: 'Only a full admin can change an agent\'s team' });
      return;
    }
```

Pass `teamId: body.teamId` through to `setCallingProcessAgent`'s options object, and change the
success response to `res.status(200).json({ statuses: CALLING_STATUSES, agents: await getCallingProcessAgents(body.processKey, teamId) })`
so a write that changed one agent no longer answers with every agent on the process.

- [ ] **Step 4: Scope the DELETE branch and clear `team_id` on revoke**

Add the same non-admin membership check as Step 3 before the revoke work, then extend the existing
best-effort state clear so team membership does not survive a revoke:

```js
    try {
      // team_id: null explicitly UNASSIGNS (see setCallingProcessAgent's three-state contract).
      // Without it a revoked agent keeps their team membership and silently rejoins that team's
      // roster and metrics the moment anyone re-invites them.
      await setCallingProcessAgent(body.processKey, email, { status: 'Offline', isProcessAdmin: false, teamId: null }, session.email);
    } catch (e) { /* best-effort - the access revocation above is what actually matters */ }
```

- [ ] **Step 5: Verify every method is scoped and the write no longer leaks the roster**

```bash
node -e "
const src=require('fs').readFileSync('api/admin/[action].js','utf8');
const h=src.slice(src.indexOf('async function handleCallingAgents'));
const seg=h.slice(0, h.indexOf('\nasync function ',1));
const calls=[...seg.matchAll(/getCallingProcessAgents\(([^)]*)\)/g)].map(m=>m[1]);
if(!calls.length) throw new Error('no roster reads found');
for(const c of calls) if(!/teamId/.test(c)) throw new Error('unscoped roster read: getCallingProcessAgents('+c+')');
if(!/teamId: null/.test(seg)) throw new Error('revoke does not clear team_id');
if(!/not on your team/.test(seg)) throw new Error('missing cross-team write guard');
require('./api/admin/[action].js');
console.log('all '+calls.length+' roster reads scoped; revoke clears team; write guard present');
"
```
Expected: prints the confirmation with a non-zero count.

- [ ] **Step 6: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "feat(ndr): team-scope calling-agents reads, writes and revokes"
```

---

## Task 13: Team-scope presence and lead dates

**Files:**
- Modify: `api/auth/[action].js` — `handlePresence`'s process-admin branch (`:256-274`),
  `handleProcessPresence` (`:426-465`), `handleLeadDates` (Task 3's version)
- Modify: `api/_lib/db.js` — `getAllNdrLeadDates`'s cache key (`:2763`)

**Interfaces:**
- Consumes: `resolveCallerTeam`, `teamScopeFor`, `getCallingProcessAgents(processKey, teamId)`.
- Produces: `getAllNdrLeadDates(teamAwbFilter)` — optional `Set` of AWBs to restrict to;
  `undefined` keeps today's behaviour.

- [ ] **Step 1: Scope the presence process-admin branch**

In `handlePresence`, the process-admin branch builds its response from
`getCallingProcessAgents(processKey)`. Scope that one call:

```js
      if (processKey && await isCallingProcessAdmin(session.email, processKey)) {
        // Scoped to the caller's own team: this branch returns live status plus logged-in,
        // break and busy minutes for every roster member, which is precisely the "metrics of
        // another team" the isolation exists to prevent. agent_presence itself stays global and
        // un-teamed by design (a person has one desk); only WHICH emails may be asked about is
        // scoped.
        const { callerTeamId, activeTeamCount } = await resolveCallerTeam(session.email, processKey);
        const teamId = teamScopeFor({ callerTeamId, activeTeamCount, isAdmin: false });
        const [roster, allAgents, presenceSummary] = await Promise.all([
          getCallingProcessAgents(processKey, teamId), getAllAgentPresence(), getAgentPresenceLogSummary(dateFrom, dateTo),
        ]);
```

The rest of the branch is unchanged — it already iterates `roster`.

- [ ] **Step 2: Keep `handleProcessPresence` correct without widening it**

`handleProcessPresence` GET returns only the caller's own row but computes it by loading the whole
roster and `.find()`ing itself. Once the roster is team-filtered, an unassigned caller would find
nothing and silently read as having no row. Pass `undefined` deliberately, with the reason:

```js
  // Deliberately UNSCOPED: this endpoint returns only the caller's own row, and it finds that
  // row by searching the roster for its own email. A team filter here would make an unassigned
  // caller (or a full admin, who holds no state row at all) vanish from their own lookup and
  // read as "no row" - which the client renders as Offline with a default quota. Self-only is
  // already the narrowest possible scope, so there is nothing for a team filter to protect.
  const me = (await getCallingProcessAgents(processKey, undefined)).find((a) => a.email === session.email);
```

- [ ] **Step 3: Scope lead dates and re-key its cache**

In `db.js`, give `getAllNdrLeadDates` an optional AWB restriction and — critically — put the team
into the cache key. The existing single global key would otherwise serve the first team's AWB set
to the other for the whole 5-minute TTL, intermittently:

```js
// awbFilter: a Set of AWBs to restrict the result to, or undefined for every live lead. The
// cache key carries a caller-supplied tag because this is cachedRead - a single global key would
// serve one team's entire AWB set to the other team for the full TTL. The tag is
// delimiter-terminated so invalidateCache's startsWith matching cannot evict a sibling
// (':1' must not be a prefix of ':10').
async function getAllNdrLeadDates(awbFilter, cacheTag = 'all') {
  await ensureSchema();
  return cachedRead(`calling:ndrLeadDates:${cacheTag}:`, async () => {
    const { rows } = await sql`
      SELECT awb_number, assigned_at, disposed_at FROM ndr_lead_assignments
      WHERE reassigned_away_at IS NULL
    `;
    const out = {};
    for (const r of rows) {
      if (awbFilter && !awbFilter.has(String(r.awb_number))) continue;
      out[r.awb_number] = { assignedAt: r.assigned_at, disposedAt: r.disposed_at };
    }
    return out;
  });
}
```

In `handleLeadDates`, pass the caller's team as the cache tag so each team gets its own slot:

```js
  // ndr_lead_assignments has no team column (see the spec's "Deliberately NOT changed" section),
  // so a lead's team is only knowable via the sheet it came from. Until that changes, the team
  // is carried in the CACHE KEY so the two teams never share a cached payload, and the
  // per-team AWB restriction is applied by the caller that knows its own sheet.
  const { callerTeamId } = await resolveCallerTeam(session.email, processKey);
  const leadDates = processKey === 'ndr'
    ? await getAllNdrLeadDates(undefined, session.isAdmin ? 'admin' : `t${callerTeamId ?? 'none'}`)
    : await getAllLeadDates();
```

- [ ] **Step 4: Add the cache-prefix assertion — to `callingTeams.test.js`, not `db.cache.test.js`**

The obvious home for this is `db.cache.test.js`, but **that file already throws at line 56** (the
`CACHE_TTL_MS` baseline failure from Task 5 Step 3). Anything appended after a top-level throw in a
plain assert script never executes, so an assertion added there would silently never run — the
worst kind of test. Put it in the passing file instead, where it also fits: the delimiter rule is a
team-scoping rule.

Add a `teamCacheKey` helper to `api/_lib/callingTeams.js` so the rule is enforced in code rather
than merely asserted about string literals:

```js
// Cache keys for per-team slots. Terminated with ':' because invalidateCache matches on
// startsWith - an un-terminated 'calling:ndrLeadDates:1' is also a prefix of ':10' and ':11', so
// evicting team 1 would silently evict teams 10 and 11 too. That shows up as random staleness on
// someone else's desk, which is close to undebuggable.
function teamCacheKey(base, teamId) {
  return `${base}:${teamId == null ? 'none' : teamId}:`;
}
```

Export it, and append to `api/_lib/callingTeams.test.js`:

```js
// ── teamCacheKey: delimiter termination is load-bearing, not cosmetic ──
const { teamCacheKey } = require('./callingTeams');
assert.strictEqual(teamCacheKey('calling:ndrLeadDates', 1), 'calling:ndrLeadDates:1:');
assert.strictEqual(teamCacheKey('calling:ndrLeadDates', null), 'calling:ndrLeadDates:none:');
// The whole point: team 1's key must not prefix-match team 10's, or invalidating one evicts the
// other. invalidateCache in db.js is startsWith-based, so this is the property it relies on.
assert.ok(!teamCacheKey('calling:ndrLeadDates', 10).startsWith(teamCacheKey('calling:ndrLeadDates', 1)),
  'team 1 key must not be a prefix of team 10 key');
assert.ok(teamCacheKey('calling:ndrLeadDates', 1).startsWith(teamCacheKey('calling:ndrLeadDates', 1)),
  'a key must still match itself');
console.log('ok - team cache keys are delimiter-terminated');
```

Then use `teamCacheKey` in `db.js` for the `getAllNdrLeadDates` slot rather than building the string
inline, so the tested helper is the one actually in the path.

- [ ] **Step 5: Verify and run the suite**

```bash
node -e "
const auth=require('fs').readFileSync('api/auth/[action].js','utf8');
if(!/getCallingProcessAgents\(processKey, teamId\)/.test(auth)) throw new Error('presence branch not scoped');
if(!/getCallingProcessAgents\(processKey, undefined\)/.test(auth)) throw new Error('processPresence should pass undefined deliberately');
const db=require('fs').readFileSync('api/_lib/db.js','utf8');
if(!/calling:ndrLeadDates:\\\$\{cacheTag\}:/.test(db)) throw new Error('ndrLeadDates cache key not team-tagged');
console.log('presence and leadDates scoping wired');
"
node api/_lib/callingTeams.test.js
npm test
```
Expected: the confirmation line, then `ok - team cache keys are delimiter-terminated` from the
`callingTeams` suite, then a fully green `npm test` (exit 0).

- [ ] **Step 6: Commit**

```bash
git add "api/auth/[action].js" api/_lib/db.js api/_lib/db.cache.test.js
git commit -m "feat(ndr): team-scope presence reads and lead-date cache slots"
```

---

## Task 14: Resolve the sheet server-side in the sheet proxy

`api/ndr/sheet.js` compares a client-supplied `sid` against one const and then queries the const
regardless, and its 20-second read cache is keyed on range alone. Both live tabs are named
`Latest NDR `, so identical range strings would collide inside a warm container and serve one
team's rows to the other — a leak that survives a perfectly correct permission check.

**Files:**
- Modify: `api/ndr/sheet.js` — `NDR_SHEET_ID` (`:16`), `cachedRead` key (`:88`), both fetch URLs
  (`:90`, `:108`), the `sid` check (`:70-73`)

**Interfaces:**
- Consumes: `resolveCallerTeam`, `getCallingTeam`, `listCallingTeams`, `teamScopeFor`.
- Produces: no request-shape change. `sid` is ignored if sent. Response shape unchanged.

- [ ] **Step 1: Replace the `sid` check with server-side resolution**

Delete the `NDR_SHEET_ID` const and the `sid !== NDR_SHEET_ID` rejection, and resolve instead:

```js
// The sheet this caller is entitled to, resolved from their own team row. The client's `sid` is
// IGNORED rather than validated, for two reasons. Security: this file's original comment
// explains the check existed so a permitted-but-malicious request could not repurpose the
// service account (which holds Editor access) against another spreadsheet - never consulting
// the client's value is a stronger form of that guarantee than comparing it. Deploy safety:
// api/ and app/ ship separately, so an api/ newer than app/ still receives the old hardcoded
// sid; ignoring it keeps that request working instead of 400-ing "Unknown sheet".
async function resolveSheetFor(session) {
  const { callerTeamId, activeTeamCount } = await resolveCallerTeam(session.email, TAB_KEY);
  if (callerTeamId != null) {
    const team = await getCallingTeam(callerTeamId);
    if (team && team.active) return team;
  }
  // No team row: either the desk has not been split yet, or the caller is a full admin (who
  // holds no calling_agent_process row by convention). With one team there is no ambiguity;
  // with two or more there is, and guessing would serve the wrong team's leads.
  const teams = await listCallingTeams(TAB_KEY);
  if (teams.length === 1) return teams[0];
  if (activeTeamCount >= 2) return null;
  return null;
}
```

Then in the handler, after `checkAccess`:

```js
  const team = await resolveSheetFor(session);
  if (!team) {
    res.status(403).json({ error: 'You are not assigned to an NDR team yet. Ask an admin to assign you.' });
    return;
  }
```

- [ ] **Step 2: Put the sheet id into the cache key and both URLs**

```js
      // The spreadsheet id is part of the key, not just the range. Both NDR sheets name their
      // tab 'Latest NDR ' (trailing space included), so two teams request byte-identical range
      // strings - keyed on range alone they collide inside a warm Lambda container and one team
      // is served the other's rows, with a 200 and no audit trail.
      const { status, data } = await cachedRead(`values:${team.sheetId}:${range}`, async () => {
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${team.sheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { status: r.status, data: await r.json() };
      });
```

and the `batchUpdate` URL likewise uses `${team.sheetId}`.

- [ ] **Step 3: Confirm no hardcoded sheet id survives**

```bash
node -e "
const src=require('fs').readFileSync('api/ndr/sheet.js','utf8');
if(/12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI/.test(src)) throw new Error('hardcoded sheet id still present');
if(!/values:\\\$\{team\.sheetId\}:\\\$\{range\}/.test(src)) throw new Error('cache key missing the sheet id');
if(/sid !== /.test(src)) throw new Error('client sid is still being validated - it must be ignored');
const urls=[...src.matchAll(/spreadsheets\/\\\$\{([^}]+)\}/g)].map(m=>m[1]);
for(const u of urls) if(u!=='team.sheetId') throw new Error('a Sheets URL still interpolates '+u);
console.log('sheet proxy resolves server-side; '+urls.length+' URLs use the resolved team sheet');
"
```
Expected: prints the confirmation with a count of 2.

- [ ] **Step 4: Verify the module loads**

Run: `node -e "require('./api/ndr/sheet.js'); console.log('sheet.js loads')"`
Expected: prints `sheet.js loads`.

- [ ] **Step 5: Commit**

```bash
git add api/ndr/sheet.js
git commit -m "feat(ndr): resolve the sheet server-side and key its cache per sheet"
```

---

## Task 15: Route the CSV upload to the uploader's own team sheet

Nothing in a CSV identifies a team, and neither sheet has a routing column, so the destination
comes from *who uploads*: derived for a TL, explicitly chosen by a full admin, never defaulted.
Plus cross-team duplicate rejection, because the same `(AWB, Attempt)` in both sheets corrupts the
shared mirror.

**Files:**
- Modify: `api/ndr/upload.js` — `NDR_SHEET_ID`/`SHEET_TAB` (`:26-27`), `sheetsRequest` (`:44-50`),
  `readExistingKeySet` (`:80-100`), the handler body (`:102+`)

**Interfaces:**
- Consumes: `resolveCallerTeam`, `getCallingTeam`, `listCallingTeams` (Task 8);
  `NDR_IMPORT`, `dedupKey`, `checkSheetLayout` (existing).
- Produces: response gains `team: { id, name }` and `duplicateInOtherTeam`. Both additive.

- [ ] **Step 1: Resolve the destination team, refusing to guess**

Replace the module consts with a resolver, and call it right after the existing access gate:

```js
// Which sheet an upload lands in is decided by WHO is uploading - never by anything in the CSV
// (no column in either sheet identifies a team) and never by an unvalidated request field.
//
//   TL (is_process_admin)  -> their own team, from their calling_agent_process row
//   full admin             -> must name a team explicitly; a missing one is a 400, never a
//                             default. Silently defaulting writes hundreds of leads into the
//                             wrong team's live sheet, and the only remedy is deleting rows by
//                             hand from a sheet someone else is actively working.
async function resolveUploadTarget(session, body) {
  const teams = await listCallingTeams(TAB_KEY);
  if (session.isAdmin) {
    if (body.teamId == null) {
      if (teams.length === 1) return { team: teams[0] };
      return { error: 'Pick which team to upload to.', teams: teams.map((t) => ({ id: t.id, name: t.name })) };
    }
    const picked = teams.find((t) => t.id === parseInt(body.teamId, 10));
    return picked ? { team: picked } : { error: 'No such active team' };
  }
  const { callerTeamId } = await resolveCallerTeam(session.email, TAB_KEY);
  if (callerTeamId != null) {
    const mine = teams.find((t) => t.id === callerTeamId);
    if (mine) return { team: mine };
  }
  if (teams.length === 1) return { team: teams[0] };
  return { error: 'You are not assigned to an NDR team yet. Ask an admin to assign you.' };
}
```

In the handler, after the `checkAccess` block:

```js
  const target = await resolveUploadTarget(session, req.body || {});
  if (target.error) {
    res.status(400).json({ error: target.error, teams: target.teams });
    return;
  }
  const { team } = target;
```

Then make `sheetsRequest` take the sheet id (`sheetsRequest(client, team.sheetId, method, path, body)`)
and replace every `SHEET_TAB` with `team.sheetTab`.

- [ ] **Step 2: Read dedup keys from the target sheet and every other active team's sheet**

```js
// Existing (AWB, Attempt) keys for ONE sheet.
async function readKeySetForSheet(client, sheetId, sheetTab) {
  const ranges = [`'${sheetTab}'!${NDR_AWB_COLUMN}2:${NDR_AWB_COLUMN}`, `'${sheetTab}'!${NDR_ATTEMPT_COLUMN}2:${NDR_ATTEMPT_COLUMN}`]
    .map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const data = await sheetsRequest(client, sheetId, 'GET', `/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
  const [awbRange, attemptRange] = data.valueRanges || [];
  const awbRows = (awbRange && awbRange.values) || [];
  const attemptRows = (attemptRange && attemptRange.values) || [];
  const keys = new Set();
  awbRows.forEach((row, i) => {
    const awb = normalizeAwb((row && row[0]) || '');
    if (!awb) return;
    const attemptRow = attemptRows[i];
    const attempt = (attemptRow && attemptRow[0]) !== undefined ? attemptRow[0] : '';
    keys.add(dedupKey(awb, { 'Attempt Count': attempt }, NDR_IMPORT.dedupExtraCsvHeaders));
  });
  return keys;
}

// Why the OTHER teams' sheets are read too: ndr_lead_assignments has no team column and its
// only uniqueness is a UNIQUE key on the live AWB (api/_lib/db.js:262-264). A lead sitting live
// in two teams' sheets therefore corrupts the shared mirror - the second team's claim silently
// INSERT IGNOREs to nothing while its disposal overwrites the first team's cycle, and the cron
// steals the row outright. Rejecting the duplicate at upload is the only guard available while
// the mirror's grain stays coarser than the sheet's (see the spec).
async function readForeignKeySets(client, teams, targetId) {
  const others = teams.filter((t) => t.id !== targetId);
  const sets = await Promise.all(others.map((t) => readKeySetForSheet(client, t.sheetId, t.sheetTab)));
  return others.map((t, i) => ({ team: t, keys: sets[i] }));
}
```

- [ ] **Step 3: Split foreign duplicates out of the plan**

`buildRowPlan` already buckets in-file and in-sheet duplicates. Run it against the target sheet's
keys as today, then move any surviving row whose key exists in another team's set into its own
bucket, so it is reported rather than appended:

```js
    const existingKeySet = await readKeySetForSheet(client, team.sheetId, team.sheetTab);
    const plan = buildRowPlan({ csvRows, existingKeySet, config: NDR_IMPORT });

    const foreign = await readForeignKeySets(client, teams, team.id);
    const foreignHits = [];
    const keep = [];
    for (const row of plan.validRows) {
      const hit = foreign.find((f) => f.keys.has(row.dedupKey));
      if (hit) foreignHits.push({ line: row.line, reason: `already in ${hit.team.name}'s sheet` });
      else keep.push(row);
    }
    plan.validRows = keep;
```

If `buildRowPlan`'s rows do not already carry `dedupKey` and `line`, add them there — check with
`grep -n "dedupKey\|line" api/_lib/rtoCsvImport.js` and extend the object it builds rather than
recomputing the key here, so the two paths cannot disagree about what a key is.

- [ ] **Step 4: Report the destination and the new bucket**

Include the destination and the foreign-duplicate count in the response so the uploader can see
where rows landed:

```js
    res.status(200).json({
      team: { id: team.id, name: team.name },
      total: plan.total,
      appended,
      duplicateInSheet: plan.duplicateInSheet,
      duplicateInFile: plan.duplicateInFile,
      duplicateInOtherTeam: foreignHits.length,
      missingAwb: plan.missingAwb,
      errors: [...(plan.errors || []), ...foreignHits].slice(0, 50),
    });
```

Match the existing response's other field names exactly — read them first with
`grep -n "res.status(200).json" -A 12 api/ndr/upload.js` and keep every one, adding only `team` and
`duplicateInOtherTeam`, so the current modal keeps rendering.

- [ ] **Step 5: Verify no hardcoded sheet survives and the guard rails hold**

```bash
node -e "
const src=require('fs').readFileSync('api/ndr/upload.js','utf8');
if(/12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI/.test(src)) throw new Error('hardcoded sheet id still present');
if(/const SHEET_TAB *=/.test(src)) throw new Error('hardcoded sheet tab still present');
if(!/Pick which team to upload to/.test(src)) throw new Error('admin must be forced to choose a team');
if(!/already in \\\$\{hit\.team\.name\}/.test(src)) throw new Error('cross-team duplicate rejection missing');
require('./api/ndr/upload.js');
console.log('upload routes to the resolved team sheet and rejects cross-team duplicates');
"
npm test
```
Expected: the confirmation line, then a fully green `npm test` (exit 0).

- [ ] **Step 6: Commit**

```bash
git add api/ndr/upload.js
git commit -m "feat(ndr): route CSV upload to the uploader's own team sheet"
```

---

## Self-Review

**Spec coverage.** Walked each spec section against the tasks:

| Spec section | Task |
| --- | --- |
| `calling_teams` table | 6 |
| `team_id` column + migration | 7 |
| `ndr_lead_assignments` left alone | — (explicit non-goal; Task 15 adds the compensating guard) |
| Shared hours/dispositions locked to admin | 11 |
| Team resolution server-side | 8 (`resolveCallerTeam`), used in 12–15 |
| Roster membership rule + `isProcessAdmin` as own field | 4, 9, 12 |
| Release-1 `NULL` = no filter | 4 (`teamScopeFor`, single place) |
| Writes are the wider hole | 12 |
| `sheet_id` full-admin only | 10 |
| Presence global, read scoped | 13 |
| Pre-existing bug: leadDates gate | 3 |
| Pre-existing bug: claim email | 2 |
| Pre-existing bug: header expectation | 1 |
| Drop client `sid` | 14 |
| Cache key fix | 14 (sheet), 13 (leadDates) |
| Upload to own team sheet + registration header check | 15 |
| Cross-team duplicate rejection | 15 |
| Testing: pure fn, cache prefix, npm wiring | 4, 13, 5 |
| Frontend behaviour, `ndrPredicted`, robot, reserved concurrency | **Part 2** — out of scope here, by design |

Two spec items deliberately deferred to Part 2 and called out so they are not lost: the
**registration-time header check** against a newly entered `sheet_id` (Task 10 validates the id's
*shape*; validating the sheet's *header* needs a Sheets call from the admin route, which is
cleaner to add alongside the admin UI that surfaces the error), and the **third access state** in
the client for an invited-but-unassigned agent. Task 14 and Task 15 already return the 403/400
those states render.

**Placeholder scan.** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step has
real code; every verification step has a runnable command and an expected result.

**Type consistency.** `teamScopeFor` returns `number | null | undefined` and
`filterRosterByTeam(rows, teamId)` consumes exactly those three states — Task 4 defines them, Tasks
9, 12 and 13 use them with that meaning. `getCallingProcessAgents(processKey, teamId)` has one
signature everywhere. `setCallingProcessAgent`'s `teamId` is three-state (`undefined`/number/`null`)
and Task 12's revoke passes `null` for the documented clear. `resolveCallerTeam` returns
`{ callerTeamId, activeTeamCount }` in Task 8 and is destructured with those names in 12–15.
`listCallingTeams` rows are camelCase (`sheetId`, `sheetTab`) via `mapTeamRow`, and Tasks 14–15 read
`team.sheetId` / `team.sheetTab` accordingly.

**One risk flagged for the executor.** Task 15 Step 3 assumes `buildRowPlan`'s rows carry
`dedupKey` and `line`. The step says to check and extend `api/_lib/rtoCsvImport.js` rather than
recompute — do that check before writing the loop, because recomputing the key locally is exactly
how the two dedup paths would drift.
