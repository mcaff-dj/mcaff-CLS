# Per-Team Disposition Trees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every NDR team its own complete disposition tree, cloned from the shared tree when the team is created, with a Team Lead able to edit their own team's tree and nobody else's.

**Architecture:** One nullable `team_id` column on the existing `calling_process_dispositions` table (`NULL` = shared/fallback tree). The "whose tree is this" decision lives in a new pure module, `api/_lib/dispositionTrees.js`, so it is unit-testable without a database — the same pattern `api/_lib/callingTeams.js` already established. `api/_lib/db.js` and `api/admin/[action].js` defer to it; the frontend passes the team the existing NDR header picker already selects.

**Tech Stack:** Node (CommonJS) Lambda handlers under `api/`, `node --test` for JS unit tests, Next.js client components under `app/`, Python 3 + `pymysql` for the hand-run MySQL migration, MySQL 8 (`PEP_CLS`).

**Spec:** `docs/superpowers/specs/2026-08-28-per-team-dispositions-design.md`

## Global Constraints

- Table: `calling_process_dispositions`. New column: `team_id INT NULL`, FK to `calling_teams(id)` `ON DELETE CASCADE`, plus `KEY calling_process_dispositions_team_idx (process_key, team_id, sort_order)`.
- `team_id IS NULL` means **shared / fallback tree**, never "unassigned".
- `ensureSchema()` in `api/_lib/db.js` contains **no `ALTER TABLE`** and must not gain one. New columns arrive by a hand-run script in `scripts/`, applied **before** the `api/` deploy.
- A client-supplied team id is honored **only** for `session.isAdmin`. For everyone else the team is derived from `calling_agent_process.team_id` via `resolveCallerTeam`.
- Processes with fewer than 2 active teams (`rto`, `escalation`, `deliveryescalation`, and `ndr` before a split) must behave exactly as they do today: everything resolves to the shared tree.
- `scripts/auto_dispose_de_categories.py` inserts with no `team_id` and must keep working untouched (it targets `deliveryescalation`, not `ndr`).
- Do NOT run anything against the live database or a dev server, and do not deploy. The user performs all live testing.
- JS tests run with `npm test` (`node --test "api/_lib/**/*.test.js"`). Python tests are plain `assert`-based files run as `python scripts/test_<name>.py`.
- Commit messages: conventional prefix, and every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `api/_lib/dispositionTrees.js` (create) | Pure rules: which tree a caller resolves to, and the clone plan for copying a tree. No I/O. |
| `api/_lib/dispositionTrees.test.js` (create) | Unit tests for both pure functions. |
| `scripts/migrate_team_dispositions.py` (create) | Hand-run migration: adds the column + index, clones the shared NDR tree into each existing active team that has none. Dry-run by default. |
| `scripts/test_migrate_team_dispositions.py` (create) | Unit test for that script's pure clone-plan builder. |
| `api/_lib/db.js` (modify) | Team-scope the five disposition functions; clone the shared tree in `createCallingTeam`. |
| `api/admin/[action].js` (modify) | `handleDispositions`: derive/honor `teamId`, replace the full-admin-only lock, name the team in the audit log. |
| `app/_calling/CallingAdminPanel.js` (modify) | `useProcessDispositions(processKey, { teamId })`; card heading names the tree. |
| `app/ndr-calling/NdrCallingClient.js` (modify) | Pass the header picker's team to the dispositions hook. |
| `docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md` (modify) | Mark its "disposition tree stays per-process" decision superseded. |

---

### Task 1: Pure resolution + clone rules

**Files:**
- Create: `api/_lib/dispositionTrees.js`
- Test: `api/_lib/dispositionTrees.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `dispositionTeamFor({ callerTeamId = null, activeTeamCount = 0, explicitTeamId = null, isAdmin = false }) -> number | null` — the `team_id` whose tree applies; `null` means the shared tree.
  - `planTreeClone(rows) -> Array<{ tempKey: number, parentTempKey: number | null, label: string, description: string | null, sortOrder: number, childrenInputType: string }>` — `rows` is a flat list of `{ id, parentId, label, description, sortOrder, childrenInputType }`; the returned list is ordered parents-before-children so an inserter can map `tempKey -> new insert id` as it goes.

- [ ] **Step 1: Write the failing test**

Create `api/_lib/dispositionTrees.test.js`:

```js
// Pure-function tests for per-team disposition trees. No DB, no network - same shape as
// callingTeams.test.js. Run: node api/_lib/dispositionTrees.test.js
const assert = require('assert');
const { dispositionTeamFor, planTreeClone } = require('./dispositionTrees');

// ── dispositionTeamFor: null means the shared tree, a number means that team's own tree ──

// Fewer than two active teams: everyone resolves to the shared tree, exactly as before this
// feature. Covers rto/escalation/deliveryescalation and ndr before a split.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 0 }), null);
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 1, callerTeamId: 7 }), null);
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 1, explicitTeamId: 5, isAdmin: true }), null);

// Two or more teams: a caller with a team gets their own team's tree.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, callerTeamId: 7 }), 7);
// A non-admin's explicit teamId is ignored outright - their own team still wins.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, callerTeamId: 7, explicitTeamId: 3 }), 7);
// A caller with no team falls back to the shared tree rather than seeing nothing.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, callerTeamId: null }), null);
// A full admin's explicit choice is honoured; omitting it means the shared tree.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, explicitTeamId: 3, isAdmin: true }), 3);
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, isAdmin: true }), null);
// teamId 0 is a real id, not "unset" - the check is `!= null`, not truthiness.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, explicitTeamId: 0, isAdmin: true }), 0);

// ── planTreeClone: parents before children, ids never leak into the plan ──

const SHARED = [
  { id: 10, parentId: null, label: 'Connected', description: 'got through', sortOrder: 0, childrenInputType: 'single' },
  { id: 12, parentId: 11, label: 'Reattempt', description: null, sortOrder: 0, childrenInputType: 'single' },
  { id: 11, parentId: null, label: 'Not Connected', description: null, sortOrder: 1, childrenInputType: 'multi' },
  { id: 13, parentId: 12, label: 'Wrong Address', description: null, sortOrder: 0, childrenInputType: 'text' },
];

const plan = planTreeClone(SHARED);
assert.strictEqual(plan.length, 4);
// Every child appears AFTER its parent, whatever order the input rows arrived in (sort_order is
// scoped per parent, so the SELECT gives no cross-level ordering guarantee).
const positionOf = (label) => plan.findIndex((p) => p.label === label);
assert.ok(positionOf('Not Connected') < positionOf('Reattempt'));
assert.ok(positionOf('Reattempt') < positionOf('Wrong Address'));
// Roots carry no parent; a child's parentTempKey points at its parent's tempKey, never at a
// shared row's real id - inserting by real id would attach the copy to the ORIGINAL tree.
assert.strictEqual(plan[positionOf('Connected')].parentTempKey, null);
assert.strictEqual(
  plan[positionOf('Wrong Address')].parentTempKey,
  plan[positionOf('Reattempt')].tempKey
);
// Every field that gives an option its meaning is carried over.
assert.deepStrictEqual(
  { ...plan[positionOf('Connected')], tempKey: 0, parentTempKey: null },
  { tempKey: 0, parentTempKey: null, label: 'Connected', description: 'got through', sortOrder: 0, childrenInputType: 'single' }
);
assert.strictEqual(plan[positionOf('Not Connected')].childrenInputType, 'multi');
assert.strictEqual(plan[positionOf('Reattempt')].sortOrder, 0);
assert.strictEqual(plan[positionOf('Not Connected')].sortOrder, 1);
// An empty shared tree plans nothing rather than throwing - a brand-new process has no rows.
assert.deepStrictEqual(planTreeClone([]), []);
// A row whose parent is absent from the input is dropped, not silently promoted to a root: a
// promoted child would appear as a new top-level outcome, which NDR's own metrics key off.
assert.deepStrictEqual(planTreeClone([{ id: 5, parentId: 99, label: 'Orphan', sortOrder: 0 }]), []);

console.log('dispositionTrees.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/dispositionTrees.test.js`
Expected: FAIL — `Cannot find module './dispositionTrees'`

- [ ] **Step 3: Write minimal implementation**

Create `api/_lib/dispositionTrees.js`:

```js
// Pure rules for per-team disposition trees - no DB, no network, so the decision of WHOSE tree a
// caller edits is unit-testable in a repo whose tests cannot open a connection (same reasoning as
// callingTeams.js, and the same reason both routes and db.js defer here instead of each
// reimplementing the check).
//
// See docs/superpowers/specs/2026-08-28-per-team-dispositions-design.md.

// Returns the team_id whose tree applies, or null for the SHARED tree (team_id IS NULL). null is
// never "denied" here - a caller with no team reads the shared list rather than an empty picker
// they cannot dispose from. Write-side refusals are the route's job, not this function's.
//
// activeTeamCount < 2 short-circuits FIRST, unconditionally: a process with no split has only a
// shared tree, so honouring an explicit teamId there would scope reads to a tree that does not
// exist and hand back an empty list. Same ordering rule (and the same bug avoided) as
// teamScopeFor in callingTeams.js.
function dispositionTeamFor({ callerTeamId = null, activeTeamCount = 0, explicitTeamId = null, isAdmin = false } = {}) {
  if (activeTeamCount < 2) return null;
  if (isAdmin) return explicitTeamId != null ? explicitTeamId : null;
  return callerTeamId == null ? null : callerTeamId;
}

// Flat rows -> an insert plan for copying a whole tree under a new owner, ordered so every parent
// is inserted before its children. Real ids are deliberately replaced by tempKeys: inserting a
// copy with the ORIGINAL parent_id would hang the new rows off the source tree, which is the one
// way this clone can silently corrupt the tree it copied from.
//
// Breadth-first from the roots, not a sort of the input: sort_order is scoped per parent, so the
// SELECT that produced these rows guarantees no ordering between levels (a child can arrive
// before its parent - see getProcessDispositions' own two-pass note). A row whose parent is not
// in the input is dropped rather than promoted to a root, since a stray root reads as a brand-new
// top-level outcome to everything that keys off top-level labels.
function planTreeClone(rows) {
  const byParent = new Map(); // parentId (or null) -> child rows, in sort order
  (rows || []).forEach((r) => {
    const key = r.parentId == null ? null : r.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  });
  byParent.forEach((list) => list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id));

  const plan = [];
  const tempKeyById = new Map();
  const queue = [...(byParent.get(null) || [])];
  while (queue.length) {
    const row = queue.shift();
    const tempKey = plan.length;
    tempKeyById.set(row.id, tempKey);
    plan.push({
      tempKey,
      parentTempKey: row.parentId == null ? null : tempKeyById.get(row.parentId),
      label: row.label,
      description: row.description == null ? null : row.description,
      sortOrder: row.sortOrder || 0,
      childrenInputType: row.childrenInputType || 'single',
    });
    queue.push(...(byParent.get(row.id) || []));
  }
  return plan;
}

module.exports = { dispositionTeamFor, planTreeClone };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/dispositionTrees.test.js`
Expected: PASS — prints `dispositionTrees.test.js: all assertions passed`

Then run the whole JS suite to confirm nothing else broke: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/_lib/dispositionTrees.js api/_lib/dispositionTrees.test.js
git commit -m "feat(calling): pure rules for per-team disposition trees

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration script

Written and committed **before** the api/ changes, because it must be applied to the database before that code deploys: `ensureSchema()` has no `ALTER TABLE`, and `api/` selecting a missing column throws `ER_BAD_FIELD_ERROR` inside `getProcessDispositions`, which serves the Escalation dispose modal too.

**Files:**
- Create: `scripts/migrate_team_dispositions.py`
- Test: `scripts/test_migrate_team_dispositions.py`
- Read first (do not modify): `scripts/migrate_ndr_team_id.py` — copy its argparse/dry-run/`information_schema` idioms verbatim.

**Interfaces:**
- Consumes: `scripts/mysql_lib.get_credential`.
- Produces: `plan_tree_clone(rows) -> list[tuple[int, int | None, str, str | None, int, str]]` — `rows` are `(id, parent_id, label, description, sort_order, children_input_type)` tuples; the return is `(temp_key, parent_temp_key, label, description, sort_order, children_input_type)`, parents first. Same contract as Task 1's `planTreeClone`, kept separate because this script cannot import JS.

- [ ] **Step 1: Write the failing test**

Create `scripts/test_migrate_team_dispositions.py`:

```python
#!/usr/bin/env python3
"""Unit test for the clone-plan builder in migrate_team_dispositions.py. No DB - the plan is a
pure transform, which is the only part of that script worth testing without a connection."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from migrate_team_dispositions import plan_tree_clone

# (id, parent_id, label, description, sort_order, children_input_type), deliberately with a child
# BEFORE its parent - sort_order is scoped per parent, so the SELECT gives no cross-level order.
SHARED = [
    (10, None, "Connected", "got through", 0, "single"),
    (12, 11, "Reattempt", None, 0, "single"),
    (11, None, "Not Connected", None, 1, "multi"),
    (13, 12, "Wrong Address", None, 0, "text"),
]

plan = plan_tree_clone(SHARED)
assert len(plan) == 4, plan
labels = [p[2] for p in plan]
assert labels.index("Not Connected") < labels.index("Reattempt"), labels
assert labels.index("Reattempt") < labels.index("Wrong Address"), labels

by_label = {p[2]: p for p in plan}
# Roots carry no parent; a child points at its parent's temp key, never a source row's real id.
assert by_label["Connected"][1] is None
assert by_label["Wrong Address"][1] == by_label["Reattempt"][0]
assert by_label["Connected"][3] == "got through"
assert by_label["Not Connected"][4] == 1
assert by_label["Not Connected"][5] == "multi"
assert by_label["Wrong Address"][5] == "text"

# Empty tree plans nothing; an orphan row is dropped, never promoted to a top-level outcome.
assert plan_tree_clone([]) == []
assert plan_tree_clone([(5, 99, "Orphan", None, 0, "single")]) == []

print("test_migrate_team_dispositions.py: all assertions passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_migrate_team_dispositions.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'migrate_team_dispositions'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/migrate_team_dispositions.py`:

```python
#!/usr/bin/env python3
"""Adds PEP_CLS.calling_process_dispositions.team_id and clones today's shared NDR disposition
tree into every existing active NDR team (see
docs/superpowers/specs/2026-08-28-per-team-dispositions-design.md).

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER TABLE
anywhere in api/ - so a new TABLE ships itself with the Lambda deploy while a new COLUMN cannot.
Running this BEFORE that deploy is not optional: api/ code selecting a missing column throws
ER_BAD_FIELD_ERROR inside getProcessDispositions, which serves the Escalation desk's dispose
modal as well as NDR's.

team_id NULL means SHARED (the fallback tree every process uses today), not "unassigned". Existing
rows stay NULL and every process with fewer than two active teams keeps reading them, so applying
this early is safe and reversible: DROP COLUMN team_id restores exactly today's behaviour, and
cloned rows carry created_by = 'migration' so a partial run can be removed by that alone.

Cloning is per team and skipped for any team that already has rows of its own, which is what makes
the whole script safe to re-run.

Dry-run by default; --apply performs the DDL and the inserts.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_process_dispositions"
TEAMS_TABLE = "calling_teams"
PROCESS_KEY = "ndr"
CLONE_CREATED_BY = "migration"
INDEX_NAME = "calling_process_dispositions_team_idx"


def plan_tree_clone(rows):
    """Flat (id, parent_id, label, description, sort_order, children_input_type) rows -> an insert
    plan, parents before children, with real ids replaced by temp keys. Inserting a copy with the
    ORIGINAL parent_id would hang the new rows off the source tree - the one way this clone could
    corrupt the tree it copied from. Breadth-first from the roots rather than a sort of the input,
    because sort_order is scoped per parent and gives no ordering between levels. An orphan (parent
    absent from rows) is dropped, not promoted to a root: a stray root reads as a brand-new
    top-level outcome to everything that keys off top-level labels."""
    by_parent = {}
    for row in rows or []:
        by_parent.setdefault(row[1], []).append(row)
    for children in by_parent.values():
        children.sort(key=lambda r: (r[4] or 0, r[0]))

    plan = []
    temp_key_by_id = {}
    queue = list(by_parent.get(None, []))
    while queue:
        row = queue.pop(0)
        temp_key = len(plan)
        temp_key_by_id[row[0]] = temp_key
        plan.append((
            temp_key,
            None if row[1] is None else temp_key_by_id[row[1]],
            row[2],
            row[3],
            row[4] or 0,
            row[5] or "single",
        ))
        queue.extend(by_parent.get(row[0], []))
    return plan


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


def _shared_tree(cur):
    cur.execute(
        "SELECT id, parent_id, label, description, sort_order, children_input_type "
        f"FROM {TABLE} WHERE process_key = %s AND team_id IS NULL "
        "ORDER BY sort_order ASC, id ASC",
        (PROCESS_KEY,),
    )
    return list(cur.fetchall())


def _teams_needing_clone(cur):
    cur.execute(
        f"SELECT t.id, t.name FROM {TEAMS_TABLE} t "
        f"WHERE t.process_key = %s AND t.active = TRUE "
        f"  AND NOT EXISTS (SELECT 1 FROM {TABLE} d WHERE d.team_id = t.id) "
        "ORDER BY t.id",
        (PROCESS_KEY,),
    )
    return list(cur.fetchall())


def _clone_into(cur, team_id, plan):
    """Inserts the plan one row at a time, mapping temp keys to the real ids MySQL just assigned.
    One statement per row rather than executemany, because a child's parent_id is not known until
    its parent's INSERT has returned lastrowid."""
    real_id_by_temp_key = {}
    for temp_key, parent_temp_key, label, description, sort_order, input_type in plan:
        cur.execute(
            f"INSERT INTO {TABLE} "
            "(process_key, team_id, parent_id, label, description, sort_order, children_input_type, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                PROCESS_KEY,
                team_id,
                None if parent_temp_key is None else real_id_by_temp_key[parent_temp_key],
                label,
                description,
                sort_order,
                input_type,
                CLONE_CREATED_BY,
            ),
        )
        real_id_by_temp_key[temp_key] = cur.lastrowid


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL and inserts (default: dry run)")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql

    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=int(cred.get("port", 3306)), autocommit=False,
    )
    try:
        with conn.cursor() as cur:
            # Step 1: the column and its index.
            if _column_exists(cur, "team_id"):
                print("  column team_id: already present")
            elif args.apply:
                cur.execute(
                    f"ALTER TABLE {TABLE} ADD COLUMN team_id INT NULL, "
                    f"ADD CONSTRAINT {TABLE}_team_fk FOREIGN KEY (team_id) "
                    f"REFERENCES {TEAMS_TABLE}(id) ON DELETE CASCADE"
                )
                print("  column team_id: added")
            else:
                print("  column team_id: would add (with FK to calling_teams, ON DELETE CASCADE)")

            if _column_exists(cur, "team_id"):
                if _index_exists(cur, INDEX_NAME):
                    print(f"  index {INDEX_NAME}: already present")
                elif args.apply:
                    cur.execute(f"CREATE INDEX {INDEX_NAME} ON {TABLE} (process_key, team_id, sort_order)")
                    print(f"  index {INDEX_NAME}: added")
                else:
                    print(f"  index {INDEX_NAME}: would add")
            else:
                print(f"  index {INDEX_NAME}: skipped on dry run (column does not exist yet)")

            # Step 2: clone the shared tree into every active team that has none. Skipped entirely
            # on a dry run before the column exists, since both queries below select team_id.
            if not _column_exists(cur, "team_id"):
                print("  clone: skipped on dry run (re-run after --apply to see per-team detail)")
                conn.rollback()
                return

            shared = _shared_tree(cur)
            plan = plan_tree_clone(shared)
            teams = _teams_needing_clone(cur)
            if not plan:
                print(f"  clone: shared '{PROCESS_KEY}' tree is empty - nothing to copy")
            elif not teams:
                print("  clone: every active team already has its own tree - nothing to do")
            for team_id, name in teams:
                if not plan:
                    break
                if args.apply:
                    _clone_into(cur, team_id, plan)
                    print(f"  clone: copied {len(plan)} option(s) into team #{team_id} ({name})")
                else:
                    print(f"  clone: would copy {len(plan)} option(s) into team #{team_id} ({name})")

        if args.apply:
            conn.commit()
            print("committed")
        else:
            conn.rollback()
            print("dry run - nothing written (re-run with --apply)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_migrate_team_dispositions.py`
Expected: PASS — prints `test_migrate_team_dispositions.py: all assertions passed`

Do **not** run `migrate_team_dispositions.py` itself, with or without `--apply` — it opens a live connection. The user runs it.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate_team_dispositions.py scripts/test_migrate_team_dispositions.py
git commit -m "feat(calling): migration for per-team disposition trees

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Team-scope the DB layer

**Files:**
- Modify: `api/_lib/db.js` — `getProcessDispositions` (~2653), `addProcessDisposition` (~2685), `updateProcessDisposition` (~2714), `deleteProcessDisposition` (~2740), `reorderProcessDispositions` (~2755), `createCallingTeam` (~2587), the `calling_process_dispositions` `CREATE TABLE` comment (~303), and the `module.exports` list.

**Interfaces:**
- Consumes: `dispositionTeamFor`, `planTreeClone` from Task 1.
- Produces:
  - `getProcessDispositions(processKey, teamId = null)` — unchanged return shape (array of roots with nested `children`).
  - `addProcessDisposition(processKey, label, description, createdBy, parentId, teamId = null)`
  - `updateProcessDisposition(processKey, id, { label, description, childrenInputType }, teamId = null)`
  - `deleteProcessDisposition(processKey, id, teamId = null)`
  - `reorderProcessDispositions(processKey, parentId, orderedIds, teamId = null)`
  - `createCallingTeam(processKey, { name, sheetId, sheetTab }, byEmail)` — unchanged signature; now also clones.

`teamId` is the LAST parameter on every function so existing call sites that omit it keep compiling and keep meaning "shared tree".

- [ ] **Step 1: Read the current implementations**

Run: `sed -n '2645,2790p' api/_lib/db.js` and `sed -n '2585,2600p' api/_lib/db.js`
Note the tagged-template `sql` helper and that `getPool()`/`conn.execute` is used only by `reorderProcessDispositions`.

- [ ] **Step 2: Add the team scope to `getProcessDispositions`**

Replace the function body's query and signature with:

```js
// teamId null = the shared tree (team_id IS NULL), which is what every process without a split
// has always used. A teamId whose tree is EMPTY falls back to that shared tree rather than
// returning [] - an agent handed an empty picker cannot dispose a call at all, so a team created
// before its clone ran (or whose clone failed) must not take its agents off the phones. See the
// spec's resolution rules.
async function getProcessDispositions(processKey, teamId = null) {
  await ensureSchema();
  if (!processKey) return [];
  const fetchRows = async (team) => (await sql`
    SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
    WHERE process_key = ${processKey} AND ${team == null ? sql`team_id IS NULL` : sql`team_id = ${team}`}
    ORDER BY sort_order ASC, id ASC
  `).rows;
  let rows = await fetchRows(teamId);
  if (!rows.length && teamId != null) rows = await fetchRows(null);
  // ... existing two-pass byId/roots build, unchanged ...
}
```

If the `sql` tagged-template helper in this file does not support nested fragments (check its implementation near the top of `db.js` before writing this), use two separate literal queries instead — do not build SQL by string concatenation:

```js
  const fetchRows = async (team) => (team == null
    ? (await sql`
        SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
        WHERE process_key = ${processKey} AND team_id IS NULL
        ORDER BY sort_order ASC, id ASC`).rows
    : (await sql`
        SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
        WHERE process_key = ${processKey} AND team_id = ${team}
        ORDER BY sort_order ASC, id ASC`).rows);
```

- [ ] **Step 3: Add the team scope to the four write functions**

For each, thread `teamId` through every statement and every `getProcessDispositions` return call. The two rules that matter:

```js
// addProcessDisposition: the parent must live in the SAME tree. Without the team_id term a Team
// Lead could pass the other team's parent id and graft a child onto their tree.
  if (parent) {
    const { rows: parentRows } = teamId == null
      ? await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id IS NULL`
      : await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id = ${teamId}`;
    if (!parentRows.length) throw new Error('Parent option not found for this process');
  }
```

- `sort_order` MAX lookups: add the same `team_id IS NULL` / `team_id = ${teamId}` term, so a new option lands at the end of its OWN tree.
- `INSERT`: add the `team_id` column with value `teamId ?? null`.
- `updateProcessDisposition` / `deleteProcessDisposition`: add the team term to both the existence `SELECT` and the `UPDATE`/`DELETE` `WHERE`, so an id from another team's tree simply does not match and the existing `'Disposition not found for this process'` error covers it.
- `reorderProcessDispositions`: the two `conn.execute` statements gain `AND team_id IS NULL` or `AND team_id = ?` (with `teamId` appended to the params array) — mirroring the existing `parent_id` safety-net term, which the function's own comment already explains.
- Every `return getProcessDispositions(processKey)` becomes `return getProcessDispositions(processKey, teamId)`.

- [ ] **Step 4: Clone the shared tree in `createCallingTeam`**

```js
async function createCallingTeam(processKey, { name, sheetId, sheetTab }, byEmail) {
  await ensureSchema();
  if (!processKey) throw new Error('processKey is required');
  const { cleanName, cleanTab } = assertTeamFields({ name, sheetId, sheetTab });
  const { insertId } = await sql`
    INSERT INTO calling_teams (process_key, name, sheet_id, sheet_tab, created_by, updated_by)
    VALUES (${processKey}, ${cleanName}, ${sheetId}, ${cleanTab}, ${byEmail || null}, ${byEmail || null})
  `;
  // A new team starts with a copy of the process's shared tree, so its lead edits a real list
  // instead of building one from scratch before their agents can dispose anything. Deliberately
  // NOT fatal to team creation: a clone that fails leaves an empty tree, and
  // getProcessDispositions falls back to the shared list for exactly that case - the team still
  // works, and the admin can re-run scripts/migrate_team_dispositions.py to fill it in.
  try {
    const { rows } = await sql`
      SELECT id, parent_id, label, description, sort_order, children_input_type
      FROM calling_process_dispositions
      WHERE process_key = ${processKey} AND team_id IS NULL
      ORDER BY sort_order ASC, id ASC
    `;
    const plan = planTreeClone(rows.map((r) => ({
      id: r.id, parentId: r.parent_id, label: r.label, description: r.description,
      sortOrder: r.sort_order, childrenInputType: r.children_input_type,
    })));
    const realIdByTempKey = new Map();
    for (const p of plan) {
      // One INSERT per row, not a batch: a child's parent_id is unknown until its parent's insert
      // has returned an id.
      const { insertId: newId } = await sql`
        INSERT INTO calling_process_dispositions
          (process_key, team_id, parent_id, label, description, sort_order, children_input_type, created_by)
        VALUES (${processKey}, ${insertId}, ${p.parentTempKey == null ? null : realIdByTempKey.get(p.parentTempKey)},
                ${p.label}, ${p.description}, ${p.sortOrder}, ${p.childrenInputType}, ${byEmail || null})
      `;
      realIdByTempKey.set(p.tempKey, newId);
    }
  } catch (e) {
    console.error('createCallingTeam: disposition clone failed for team', insertId, e);
  }
  return getCallingTeam(insertId, processKey);
}
```

- [ ] **Step 5: Update the schema comment and exports**

In the `CREATE TABLE IF NOT EXISTS calling_process_dispositions` block (~line 303), append to the existing comment:

```js
  // team_id (added by scripts/migrate_team_dispositions.py, NOT here - this bootstrap has no
  // ALTER TABLE and CREATE TABLE IF NOT EXISTS is inert against the existing table) scopes a row
  // to one calling_teams row; NULL means the SHARED tree every process without a team split uses.
```

Add `planTreeClone`/`dispositionTeamFor` to the file's requires at the top:

```js
const { planTreeClone } = require('./dispositionTrees');
```

- [ ] **Step 6: Verify nothing regressed**

Run: `npm test`
Expected: PASS (the existing suites, including `callingTeams.test.js`, are unaffected)

Run: `node -e "require('./api/_lib/db.js')"`
Expected: no output, exit 0 — catches a syntax error or a bad require path without touching the database.

- [ ] **Step 7: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(calling): scope disposition reads and writes to a team

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Route — derive the team, replace the lock

**Files:**
- Modify: `api/admin/[action].js` — `handleDispositions` (574-673)

**Interfaces:**
- Consumes: `dispositionTeamFor` (Task 1); `getProcessDispositions`/`addProcessDisposition`/`updateProcessDisposition`/`deleteProcessDisposition`/`reorderProcessDispositions` with their new trailing `teamId` (Task 3); `resolveCallerTeam`, `listCallingTeams`, `coerceTeamId` (already imported or importable in this file).

- [ ] **Step 1: Add the import**

`api/_lib/callingTeams` is already required here for `teamScopeFor, coerceTeamId`. Add the new module beside it:

```js
const { dispositionTeamFor } = require('../_lib/dispositionTrees');
```

- [ ] **Step 2: Replace the write gate with the derived-team rule**

Replace the whole `if (req.method !== 'GET') { ... }` block (591-604) with:

```js
  // Which tree this request touches. A client-supplied teamId is honoured ONLY for a full admin
  // (same trust model as api/ndr/sheet.js): a Team Lead's team is DERIVED from their own
  // calling_agent_process row, so naming the other team's id in the body changes nothing.
  const dispProcessKey = req.method === 'GET' ? ((req.query && req.query.process) || '') : body.processKey;
  const { callerTeamId, activeTeamCount } = dispProcessKey
    ? await resolveCallerTeam(session.email, dispProcessKey)
    : { callerTeamId: null, activeTeamCount: 0 };
  const dispTeamId = dispositionTeamFor({
    callerTeamId,
    activeTeamCount,
    explicitTeamId: coerceTeamId(req.method === 'GET' ? (req.query && req.query.teamId) : body.teamId),
    isAdmin: !!session.isAdmin,
  });

  if (req.method !== 'GET') {
    const isProcessAdmin = session.isAdmin || (body.processKey && await isCallingProcessAdmin(session.email, body.processKey));
    if (!isProcessAdmin) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    // The old rule here was full-admin-only whenever a process had 2+ active teams, because the
    // tree was shared and one lead's rename could break the other team's agents mid-call. Trees
    // are per-team now, so a lead editing their OWN tree is safe - but a process admin with no
    // team of their own on a split desk has no tree that is theirs, and must not fall through to
    // editing the shared one that both teams still fall back to.
    if (!session.isAdmin && activeTeamCount >= 2 && dispTeamId == null) {
      res.status(403).json({ error: 'You are not assigned to a team, so there is no disposition list of yours to edit.' });
      return;
    }
  }
```

- [ ] **Step 3: Thread `dispTeamId` into every call and the audit line**

- POST: `await addProcessDisposition(body.processKey, body.label, body.description, session.email, body.parentId, dispTeamId)`
- PUT: `await reorderProcessDispositions(body.processKey, body.parentId, body.orderedIds, dispTeamId)` and `await updateProcessDisposition(body.processKey, body.id, { label: body.label, description: body.description, childrenInputType: body.childrenInputType }, dispTeamId)`
- DELETE: `await deleteProcessDisposition(body.processKey, body.id, dispTeamId)`
- GET (the tail of the function): `res.status(200).json({ dispositions: await getProcessDispositions(processKey, dispTeamId) })`
- Each `logEvent` message gains the tree it changed, so the audit trail can tell two teams apart:

```js
      const treeLabel = dispTeamId == null ? 'shared' : `team #${dispTeamId}`;
      await logEvent(session.uid, session.email, 'calling', 'disposition-add',
        `${body.processKey} (${treeLabel}): added "${body.label}"${body.parentId ? ` (child of #${body.parentId})` : ''}`, ip);
```

Apply the same `(${treeLabel})` insertion to the `disposition-edit` and `disposition-delete` messages.

- [ ] **Step 4: Verify**

Run: `node -e "require('./api/admin/[action].js')"`
Expected: no output, exit 0.

Run: `npm test`
Expected: PASS.

Do not start a dev server or call the route — the user tests live.

- [ ] **Step 5: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "feat(calling): let a team lead edit their own disposition tree

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend — hook, card heading, NDR wiring

**Files:**
- Modify: `app/_calling/CallingAdminPanel.js` — `useProcessDispositions` (442-474 and its four mutation functions through ~620), `ProcessDispositionsCard` (771-790)
- Modify: `app/ndr-calling/NdrCallingClient.js` — the `useProcessDispositions` call (~238) and the `ProcessDispositionsCard` render (~1640)

**Interfaces:**
- Consumes: the route from Task 4 (`?teamId=` on GET, `teamId` in the JSON body on POST/PUT/DELETE).
- Produces: `useProcessDispositions(processKey, { googleUser, showToast, teamId })` — same return shape as today, plus `teamId` echoed back for the card's heading.

- [ ] **Step 1: Accept and send `teamId` in the hook**

```js
export function useProcessDispositions(processKey, { googleUser, showToast, teamId = null } = {}) {
```

`loadDispositions` gains the query param and the dependency:

```js
  const loadDispositions = useCallback(async (key, team) => {
    if (!key) return;
    setProcessDispositions(null);
    setDispositionsError('');
    try {
      // teamId is honoured server-side only for a full admin - an agent or team lead gets their
      // own team's tree regardless of what is sent here, so this is a UI affordance, not a
      // permission.
      const teamQuery = team != null ? `&teamId=${encodeURIComponent(team)}` : '';
      const r = await fetch(`/api/admin/dispositions?process=${encodeURIComponent(key)}${teamQuery}`);
      ...
```

Load effect:

```js
  useEffect(() => {
    if (googleUser?.email) loadDispositions(processKey, teamId);
  }, [googleUser, processKey, teamId, loadDispositions]);
```

Each mutation's body gains the same field, spread conditionally so a teamless process sends exactly what it sends today:

```js
        body: JSON.stringify({ processKey, label, description: draft.description.trim(), parentId: parentId || undefined, ...(teamId != null ? { teamId } : {}) }),
```

Apply that to `addDisposition`, `saveDispositionEdit`, `deleteDisposition`, and `moveDisposition`. Add `teamId` to the hook's returned object so the card can label itself.

- [ ] **Step 2: Name the tree in the card heading**

In `ProcessDispositionsCard`, destructure `teamId` and accept an optional `teamName`:

```js
export function ProcessDispositionsCard({ processLabel, disp, allowInputTypeControl = false, teamName = '' }) {
  const { processDispositions, dispositionsError, savingDisposition, newDispLabel, setNewDispLabel, newDispDesc, setNewDispDesc, addDisposition, teamId } = disp;
```

and in the `<h2>`:

```jsx
            <h2 className="text-lg font-bold text-zinc-100">
              Disposition List{processLabel ? ` — ${processLabel}` : ''}
              {/* Which tree this card edits. Without it an admin switching teams cannot tell
                  whose list they just changed - the one thing per-team trees make possible to
                  get wrong. */}
              {teamId != null && <span className="text-zinc-400 font-medium"> · {teamName || `Team #${teamId}`}</span>}
              {teamId == null && teamName === '' && <span className="text-zinc-500 font-medium"> · Shared (fallback)</span>}
            </h2>
```

- [ ] **Step 3: Wire the NDR page's existing team picker**

In `NdrCallingClient.js`, the dispositions hook must receive the header picker's team. `ndrSheetTeam` is declared AFTER the `disp` line today, so move the `useProcessDispositions` call to just below `ndrSheetTeam`'s `useMemo` (there is no dependency the other way — `teamsHook` does not read `disp`):

```js
  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast, teamId: ndrSheetTeam?.id ?? null });
```

And at the render site:

```jsx
                  <ProcessDispositionsCard processLabel="NDR Calling" disp={disp} allowInputTypeControl teamName={ndrSheetTeam?.name || ''} />
```

Check the existing render line first (`grep -n "ProcessDispositionsCard" app/ndr-calling/NdrCallingClient.js`) and preserve whatever props it already passes.

- [ ] **Step 4: Verify no other caller broke**

Run: `grep -rn "useProcessDispositions\|ProcessDispositionsCard" app --include=*.js | grep -v node_modules`
Expected: the escalation and RTO call sites (if any) pass no `teamId` and no `teamName` — both default, so they keep today's behaviour. Confirm each one visually; change none of them.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/_calling/CallingAdminPanel.js app/ndr-calling/NdrCallingClient.js
git commit -m "feat(ndr): admin panel edits the picked team's disposition tree

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Supersede the old decision in the previous spec

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md`

- [ ] **Step 1: Update the scope table row**

Find the row `| Calling Hours + disposition tree | Stay per-process (shared by both NDR teams), and become **full-admin-only to edit** |` and replace it with:

```markdown
| Calling Hours | Stays per-process (shared by both NDR teams) |
| Disposition tree | **Superseded 2026-08-28** — now per-team, and a team lead edits their own. See `2026-08-28-per-team-dispositions-design.md` |
```

- [ ] **Step 2: Verify**

Run: `grep -n "Superseded 2026-08-28" docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md
git commit -m "docs(ndr): mark the shared-disposition-tree decision superseded

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Rollout (user-performed, in this order)

1. `python scripts/migrate_team_dispositions.py` — dry run, read the output.
2. `python scripts/migrate_team_dispositions.py --apply` — adds the column/index and clones the shared NDR tree into Team Aditi and Team Shahid.
3. Deploy `api/` (Lambda), then `app/` (Amplify).
4. Verify:
   - Header picker on Team Aditi → Admin Panel card reads `· Team Aditi`; add an option; switch to Team Shahid → that option is absent.
   - An agent of Team Shahid sees Team Shahid's tree in the dispose modal.
   - A Team Lead of Team Aditi can add/rename inside Aditi's tree; a request naming Shahid's `teamId` still lands in Aditi's.
   - RTO and Escalation dispose modals and admin cards unchanged.

Rollback: `ALTER TABLE calling_process_dispositions DROP COLUMN team_id;` restores the shared tree for everyone. Migration-cloned rows are identifiable by `created_by = 'migration'`.
