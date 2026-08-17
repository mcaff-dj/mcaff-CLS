# Move agent_presence / agent_presence_log to MySQL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `agent_presence` (live per-agent status) and `agent_presence_log` (status
transition history) off Postgres/Supabase onto the app's existing MySQL RDS instance
(`PEP_CLS` schema), mirroring the `lead_assignments` → `CLS_RTO_calling` precedent.

**Architecture:** A standalone, idempotent schema script creates `agent_presence` and
converts `agent_presence_log.id` to `AUTO_INCREMENT` (matching how `CLS_RTO_calling`'s own
schema was prepared — never via `db.js`'s `ensureSchema()`). A one-time backfill script
copies existing Postgres data across. `db.js`'s three functions and both Python cron
scripts' `agent_presence` reads switch from `pgSql`/`psycopg` to MySQL. The old one-way
archival sync script and its CI step are deleted. Postgres tables are left in place,
untouched, per the spec's scope decision.

**Tech Stack:** Node (`mysql2/promise`, already in `api/_lib/db.js`), Python (`pymysql` via
`scripts/mysql_lib.py`, already used by both cron scripts for `CLS_RTO_calling`).

**Spec:** `docs/superpowers/specs/2026-08-17-agent-presence-to-mysql-design.md`

## Global Constraints

- Schema/backfill scripts: dry-run by default, `--apply` flag to write, every DDL step
  guarded by an `information_schema` check (skip if already applied) — exact pattern of
  `scripts/migrate_cls_rto_calling_schema.py` / `migrate_lead_assignments_to_cls_rto_calling.py`.
- All new/changed MySQL `DATETIME` writes use a JS `new Date()` / Python
  `datetime.now(timezone.utc).replace(tzinfo=None)` value — never SQL `NOW()` — matching the
  established naive-but-UTC convention already used by `CLS_RTO_calling.assigned_at`/`disposed_at`.
- `calling_business_hours`, `calling_agent_process`, `calling_process_dispositions`,
  `ndr_lead_assignments` are out of scope — stay on Postgres, untouched.
- No live DB command is run by the assistant during implementation — the user runs and
  verifies every script/deploy step against the real database themselves.

---

### Task 1: MySQL schema script for agent_presence / agent_presence_log

**Files:**
- Create: `scripts/migrate_agent_presence_schema.py`

**Interfaces:**
- Produces: MySQL `PEP_CLS.agent_presence` table (columns `email` PK, `name`, `status`,
  `updated_at`); `PEP_CLS.agent_presence_log.id` becomes `AUTO_INCREMENT`; new index
  `agent_presence_log_changed_at_idx (changed_at)`. Later tasks' `db.js`/Python code assumes
  all three exist.

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""Schema half of moving agent_presence/agent_presence_log off Postgres onto MySQL
PEP_CLS - the same role migrate_cls_rto_calling_schema.py played for CLS_RTO_calling.
Deliberately NOT wired into api/_lib/db.js's ensureSchema(): that function only bootstraps
PEP_CLS's original fresh-schema tables (users, permissions, audit_log,
report_tab_permissions). Every table that started elsewhere and moved onto MySQL
(CLS_RTO_calling) got its own one-off schema script instead - this follows the same
precedent.

Every step is guarded by an information_schema check first and prints its plan before
altering anything. Dry-run by default; --apply performs the DDL. Safe to re-run: an
already-applied step is detected and skipped.

Run this TWICE across the migration, not once:
  1. Before the backfill script (plain `--apply`) - creates the (empty) agent_presence
     table and the agent_presence_log.changed_at index. Safe anytime.
  2. Immediately after the LAST backfill run, before deploying the app/cron code that
     writes agent_presence_log directly (`--apply --convert-id`) - converts `id` to
     AUTO_INCREMENT. This is gated behind its OWN flag, separate from --apply, specifically
     so a first-run/early `--apply` can never accidentally perform it before the final
     backfill: doing it too early would let MySQL auto-assign an id a later backfill row
     could then collide with. --convert-id has no effect without --apply also present.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"

CREATE_AGENT_PRESENCE_SQL = """
CREATE TABLE agent_presence (
    `email` VARCHAR(255) PRIMARY KEY,
    `name` VARCHAR(255),
    `status` VARCHAR(50) NOT NULL,
    `updated_at` DATETIME NOT NULL
)
"""


def _table_exists(cur, table):
    cur.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = %s AND table_name = %s",
        (SCHEMA, table),
    )
    return cur.fetchone() is not None


def _id_is_auto_increment(cur):
    cur.execute(
        "SELECT extra FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = 'agent_presence_log' AND column_name = 'id'",
        (SCHEMA,),
    )
    row = cur.fetchone()
    return row is not None and "auto_increment" in row[0]


def _index_exists(cur, table, index_name):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, table, index_name),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DDL (default is a dry run).")
    ap.add_argument("--convert-id", action="store_true",
                     help="Also convert agent_presence_log.id to AUTO_INCREMENT. Only pass this "
                          "AFTER the final backfill run - see module docstring. Ignored without --apply.")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        plan = []

        if _table_exists(cur, "agent_presence"):
            print("agent_presence already exists - skipping.")
        else:
            plan.append(("create agent_presence table", CREATE_AGENT_PRESENCE_SQL))

        if _table_exists(cur, "agent_presence_log") and _index_exists(
            cur, "agent_presence_log", "agent_presence_log_changed_at_idx"
        ):
            print("agent_presence_log_changed_at_idx already exists - skipping.")
        elif _table_exists(cur, "agent_presence_log"):
            plan.append((
                "add plain index on agent_presence_log.changed_at",
                "CREATE INDEX agent_presence_log_changed_at_idx ON agent_presence_log (changed_at)",
            ))
        else:
            print("agent_presence_log does not exist yet - create it (e.g. via the old "
                  "archival sync) before re-running this script.")

        if not args.convert_id:
            print("(--convert-id not passed - skipping the id AUTO_INCREMENT step; run it "
                  "again with --apply --convert-id after your final backfill.)")
        elif not _table_exists(cur, "agent_presence_log"):
            pass  # already reported above
        elif _id_is_auto_increment(cur):
            print("agent_presence_log.id already AUTO_INCREMENT - skipping.")
        else:
            plan.append((
                "convert agent_presence_log.id to AUTO_INCREMENT",
                "ALTER TABLE agent_presence_log MODIFY id INT AUTO_INCREMENT",
            ))

        if not plan:
            print("\nNothing to do.")
            return

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} step(s):")
        for label, stmt in plan:
            print(f"  - {label}\n      {stmt}")

        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return

        for label, stmt in plan:
            cur.execute(stmt)
            conn.commit()
            print(f"  done: {label}")
        print("\nSchema migration complete.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: You run it, dry-run first (no `--apply`)**

```
python scripts/migrate_agent_presence_schema.py
```

Expected: prints a plan with `create agent_presence table` and `add plain index on
agent_presence_log.changed_at` only. The id-conversion step never appears here regardless of
timing — it requires the explicit `--convert-id` flag, not just table state.

- [ ] **Step 3: You apply the table/index creation**

```
python scripts/migrate_agent_presence_schema.py --apply
```

Do **not** pass `--convert-id` yet — that happens in Task 6 Step 4, after the final backfill.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate_agent_presence_schema.py
git commit -m "feat: add MySQL schema script for agent_presence/agent_presence_log"
```

---

### Task 2: One-time backfill script

**Files:**
- Create: `scripts/migrate_agent_presence_to_mysql.py`

**Interfaces:**
- Consumes: `mysql_lib.get_credential()` (from `scripts/mysql_lib.py`) — same as Task 1.
- Produces: populated MySQL `agent_presence` and `agent_presence_log` tables. Task 4/5's
  cron script changes and Task 3's `db.js` changes assume this has been run at least once
  before their deploy.

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""One-time (repeatable) data move: Postgres agent_presence (full copy, upsert) and
agent_presence_log (new rows only, past MySQL's current high-water mark) into MySQL
PEP_CLS - the same role migrate_lead_assignments_to_cls_rto_calling.py played for
lead_assignments. This script replaces scripts/sync_agent_presence_log_to_mysql.py, which
only ever handled the log half one-way; this handles both, and is meant to be run more than
once (idempotent) - once early to warm up the MySQL copy, then one final time immediately
before the app cuts over to writing/reading MySQL directly, to shrink the gap to as close to
zero as achievable without a maintenance window.

Dry-run by default (prints counts); --apply performs the writes.
"""
import argparse
import os
import sys
from pathlib import Path

import psycopg
import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"

FETCH_PRESENCE_SQL = "SELECT email, name, status, updated_at FROM agent_presence"
UPSERT_PRESENCE_SQL = """
INSERT INTO agent_presence (email, name, status, updated_at) VALUES (%s, %s, %s, %s)
ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status), updated_at = VALUES(updated_at)
"""

FETCH_LOG_SQL = """
SELECT id, email, name, status, changed_at
FROM agent_presence_log
WHERE id > %s
ORDER BY id
"""
INSERT_LOG_SQL = """
INSERT IGNORE INTO agent_presence_log (id, email, name, status, changed_at)
VALUES (%s, %s, %s, %s, %s)
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    pg_conn_str = os.environ.get("POSTGRES_URL")
    if not pg_conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    mysql_conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        mysql_cur = mysql_conn.cursor()
        with psycopg.connect(pg_conn_str) as pg_conn:
            with pg_conn.cursor() as pg_cur:
                pg_cur.execute(FETCH_PRESENCE_SQL)
                presence_rows = pg_cur.fetchall()

                mysql_cur.execute("SELECT COALESCE(MAX(id), 0) FROM agent_presence_log")
                last_id = mysql_cur.fetchone()[0]
                pg_cur.execute(FETCH_LOG_SQL, (last_id,))
                log_rows = pg_cur.fetchall()

        print(f"agent_presence: {len(presence_rows)} row(s) to upsert.")
        print(f"agent_presence_log: {len(log_rows)} new row(s) past id {last_id}.")

        if not args.apply:
            print("\nDry run - re-run with --apply to write.")
            return

        mysql_cur.executemany(UPSERT_PRESENCE_SQL, presence_rows)
        mysql_cur.executemany(INSERT_LOG_SQL, log_rows)
        mysql_conn.commit()
        print(f"\nApplied: {len(presence_rows)} agent_presence row(s), {len(log_rows)} "
              f"agent_presence_log row(s).")
    finally:
        mysql_conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: You run it, dry-run first**

```
python scripts/migrate_agent_presence_to_mysql.py
```

Expected: prints row counts for both tables, no writes.

- [ ] **Step 3: You run it with `--apply`**

```
python scripts/migrate_agent_presence_to_mysql.py --apply
```

Expected: `Applied: N agent_presence row(s), M agent_presence_log row(s).` Safe to re-run
this step as many times as convenient before cutover (Task 3-5's deploy) — re-run it one
final time immediately before that deploy.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate_agent_presence_to_mysql.py
git commit -m "feat: add one-time Postgres -> MySQL backfill for agent_presence(_log)"
```

---

### Task 3: db.js write/read path cutover

**Files:**
- Modify: `api/_lib/db.js:621-646` (`upsertAgentPresence`, `getAllAgentPresence`)
- Modify: `api/_lib/db.js:703-808` (`getAgentPresenceLogSummary`)

**Interfaces:**
- Consumes: existing `sql` tagged template (MySQL, `api/_lib/db.js:205`), existing
  `ensureSchema()` (`api/_lib/db.js:224`), existing `dateBounds`, `istMinutesSinceMidnight`,
  `istDayKey` helpers (unchanged).
- Produces: `upsertAgentPresence(email, name, status)`, `getAllAgentPresence()`,
  `getAgentPresenceLogSummary(dateFrom, dateTo)` — same signatures and return shapes as
  today; only their storage backend changes. No caller outside this file needs to change.

No new automated test for this task: this codebase does not unit-test functions that issue
live SQL against the app's own database (see `api/_lib/db.cache.test.js`,
`db.retry.test.js`, `db.refundExport.test.js` — all pure/offline, no pool mocking exists for
`sql`/`pgSql`). Verification is manual, by the user, per Task 6's step.

- [ ] **Step 1: Replace `upsertAgentPresence`**

Replace `api/_lib/db.js:621-635`:

```js
async function upsertAgentPresence(email, name, status) {
  await ensureSchema();
  const { rows: prevRows } = await sql`SELECT status FROM agent_presence WHERE email = ${email}`;
  const prevStatus = prevRows[0]?.status;
  const now = new Date();
  await sql`
    INSERT INTO agent_presence (email, name, status, updated_at)
    VALUES (${email}, ${name}, ${status}, ${now})
    ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status), updated_at = VALUES(updated_at)
  `;
  // Only log an actual transition (including an agent's very first report), not every
  // periodic heartbeat re-sending the same status - see agent_presence_log's comment.
  if (prevStatus !== status) {
    await sql`INSERT INTO agent_presence_log (email, name, status, changed_at) VALUES (${email}, ${name}, ${status}, ${now})`;
  }
}
```

- [ ] **Step 2: Replace `getAllAgentPresence`**

Replace `api/_lib/db.js:640-646`:

```js
async function getAllAgentPresence() {
  await ensureSchema();
  const { rows } = await sql`SELECT email, name, status, updated_at FROM agent_presence`;
  const out = {};
  for (const r of rows) out[r.email.toLowerCase()] = { status: r.status, updatedAt: r.updated_at };
  return out;
}
```

- [ ] **Step 3: Replace `getAgentPresenceLogSummary`'s two queries**

In `api/_lib/db.js:703-731`, replace:

```js
async function getAgentPresenceLogSummary(dateFrom, dateTo) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const now = new Date();
  const rangeEnd = to && to.getTime() < now.getTime() ? to : now;

  let priorRows = [];
  if (from) {
    ({ rows: priorRows } = await sql`
      SELECT email, status FROM (
        SELECT email, status,
               ROW_NUMBER() OVER (PARTITION BY email ORDER BY changed_at DESC) AS rn
        FROM agent_presence_log
        WHERE changed_at < ${from}
      ) t WHERE rn = 1
    `);
  }
  const { rows: rangeRows } = await sql`
    SELECT email, status, changed_at
    FROM agent_presence_log
    WHERE (${from} IS NULL OR changed_at >= ${from}) AND changed_at <= ${rangeEnd}
    ORDER BY email ASC, changed_at ASC
  `;
```

Everything from the `// synthetic: true marks...` comment (`db.js:733`) through the end of
the function (`db.js:808`) is unchanged — it's plain JS over the returned rows, backend-agnostic.

- [ ] **Step 4: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat: cut db.js agent_presence/agent_presence_log reads+writes over to MySQL"
```

---

### Task 4: assign_leads.py — split fetch_online_agents across MySQL + Postgres

**Files:**
- Modify: `scripts/assign_leads.py:558-642` (`fetch_online_agents`)
- Modify: `scripts/test_assign_leads_pg_conn.py` (add new test cases)

**Interfaces:**
- Consumes: `mysql_lib.query(sql, params=None, database=None)` (already imported in this
  file as `mysql_lib`, `scripts/assign_leads.py:93`); `STALE_MINUTES` (already defined,
  `scripts/assign_leads.py:106`); `_pg_cursor(conn_str, conn)` (unchanged,
  `scripts/assign_leads.py:415`).
- Produces: `fetch_online_agents(process_key=None, conn=None)` — same 5-tuple return shape
  as today `(present, quotas, prepaid_targets, specializations, reassign_payment_modes)`.
  Callers (`main()`) are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test_assign_leads_pg_conn.py` (after the existing `import assign_leads`
line, before the existing `test_shared_conn_not_closed_by_pg_cursor` function — this file has
no pytest fixtures, tests are plain functions run by the `if __name__` block at the bottom,
so credential/module patching is done inline with plain assignment + try/finally, matching
this file's existing style):

```python
def test_fetch_online_agents_fails_open_without_mysql_creds():
    import os
    old = {k: os.environ.pop(k, None) for k in
           ("MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE")}
    try:
        result = assign_leads.fetch_online_agents()
        assert result == ([], {}, {}, {}, {}), \
            "missing MySQL creds must fail open, not raise"
    finally:
        for k, v in old.items():
            if v is not None:
                os.environ[k] = v


def test_fetch_online_agents_reads_mysql_not_postgres():
    calls = []
    orig_get_cred = assign_leads.mysql_lib.get_credential
    orig_query = assign_leads.mysql_lib.query
    assign_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }
    assign_leads.mysql_lib.query = lambda sql, params=None, database=None: (
        calls.append((sql, params)) or [("a@x.com",), ("b@x.com",)]
    )
    try:
        present, quotas, prepaid, specs, modes = assign_leads.fetch_online_agents()
        assert present == ["a@x.com", "b@x.com"]
        assert quotas == {} and prepaid == {} and specs == {} and modes == {}
        assert len(calls) == 1
        assert "agent_presence" in calls[0][0]
    finally:
        assign_leads.mysql_lib.get_credential = orig_get_cred
        assign_leads.mysql_lib.query = orig_query
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python scripts/test_assign_leads_pg_conn.py`
Expected: `test_fetch_online_agents_fails_open_without_mysql_creds` and
`test_fetch_online_agents_reads_mysql_not_postgres` fail — `fetch_online_agents` doesn't yet
check MySQL creds or call `mysql_lib.query` for `agent_presence`, it still queries Postgres.

- [ ] **Step 3: Rewrite `fetch_online_agents`**

Replace `scripts/assign_leads.py:592-642` (the function body from `conn_str = ...` onward,
keeping the existing docstring at `558-591` as-is except updating its `agent_presence` bullet
to say MySQL instead of Postgres):

```python
    cred = mysql_lib.get_credential()
    if cred is None:
        print("MYSQL_* credentials not configured - cannot determine online agents.")
        return [], {}, {}, {}, {}
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=STALE_MINUTES)
    rows = mysql_lib.query(
        "SELECT email FROM agent_presence WHERE status = %s AND updated_at >= %s ORDER BY email",
        ("Online", cutoff),
    )
    present = [row[0].lower() for row in (rows or [])]

    if not process_key:
        return present, {}, {}, {}, {}

    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str and conn is None:
        print("POSTGRES_URL not configured - using global presence only.")
        return present, {}, {}, {}, {}
    try:
        with _pg_cursor(conn_str, conn) as cur:
            cur.execute(
                "SELECT email, status, max_quota, prepaid_pct, priority_rto_reasons, "
                "reassign_payment_mode FROM calling_agent_process WHERE process_key = %s",
                (process_key,),
            )
            per_process = cur.fetchall()
    except Exception as e:
        print(f"  (calling_agent_process unavailable: {e} - using global presence)")
        if conn is not None:
            conn.rollback()
        return present, {}, {}, {}, {}

    if not per_process:
        print(f"  no per-process availability set for '{process_key}' - using global presence")
        return present, {}, {}, {}, {}

    online_for_process = {e.lower() for e, status, _, _, _, _ in per_process if status == "Online"}
    quotas = {e.lower(): q for e, _, q, _, _, _ in per_process if q is not None}
    prepaid_targets = {e.lower(): pct for e, _, _, pct, _, _ in per_process if pct is not None}
    specializations = {}
    for e, _, _, _, reasons, _ in per_process:
        parsed = [r.strip().lower() for r in (reasons or "").split(",") if r.strip()]
        if parsed:
            specializations[e.lower()] = parsed
    reassign_payment_modes = {e.lower(): mode for e, _, _, _, _, mode in per_process if mode}
    eligible = sorted(online_for_process & set(present))
    if online_for_process and not eligible:
        print(f"  {len(online_for_process)} agent(s) marked Online for '{process_key}', but none are "
              f"heartbeat-fresh (within {STALE_MINUTES}m) - nobody is actually at their desk.")
    return eligible, quotas, prepaid_targets, specializations, reassign_payment_modes
```

- [ ] **Step 4: Add `timedelta, timezone` to the datetime import**

`scripts/assign_leads.py:84` already imports `from datetime import datetime, timedelta,
timezone` — confirm this line already covers all three names used above (it does; no change
needed here, this step is just verification).

- [ ] **Step 5: Run tests to verify they pass**

Run: `python scripts/test_assign_leads_pg_conn.py`
Expected: all tests pass, including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add scripts/assign_leads.py scripts/test_assign_leads_pg_conn.py
git commit -m "feat: read agent_presence from MySQL in assign_leads.py"
```

---

### Task 5: assign_ndr_leads.py — same split for fetch_online_ndr_agents

**Files:**
- Modify: `scripts/assign_ndr_leads.py:1-30` (imports)
- Modify: `scripts/assign_ndr_leads.py:116-183` (`fetch_online_ndr_agents`)
- Create: `scripts/test_assign_ndr_leads.py`

**Interfaces:**
- Consumes: same `mysql_lib.query`/`get_credential` as Task 4, `STALE_MINUTES` (already
  defined at `scripts/assign_ndr_leads.py:49`), `PROCESS_KEY` (already defined at line 29).
- Produces: `fetch_online_ndr_agents()` — same 6-tuple return shape as today.

- [ ] **Step 1: Update imports**

Replace `scripts/assign_ndr_leads.py:22-27`:

```python
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test_assign_ndr_leads.py`:

```python
"""Self-check for assign_ndr_leads.py's fetch_online_ndr_agents MySQL/Postgres split -
mirrors scripts/test_assign_leads_pg_conn.py's coverage of the same pattern in
assign_leads.py. No real database involved.

Run directly: python scripts/test_assign_ndr_leads.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assign_ndr_leads  # noqa: E402


def test_fetch_online_ndr_agents_fails_open_without_mysql_creds():
    import os
    old = {k: os.environ.pop(k, None) for k in
           ("MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE")}
    try:
        result = assign_ndr_leads.fetch_online_ndr_agents()
        assert result == ([], {}, {}, {}, {}, {}), \
            "missing MySQL creds must fail open, not raise"
    finally:
        for k, v in old.items():
            if v is not None:
                os.environ[k] = v


def test_fetch_online_ndr_agents_reads_mysql_not_postgres():
    calls = []
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }
    assign_ndr_leads.mysql_lib.query = lambda sql, params=None, database=None: (
        calls.append((sql, params)) or [("a@x.com",)]
    )
    try:
        present, quotas, attempt_f, reason_f, mode_f, brand_f = assign_ndr_leads.fetch_online_ndr_agents()
        assert present == ["a@x.com"]
        assert quotas == {} and attempt_f == {} and reason_f == {} and mode_f == {} and brand_f == {}
        assert len(calls) == 1
        assert "agent_presence" in calls[0][0]
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python scripts/test_assign_ndr_leads.py`
Expected: FAIL — `fetch_online_ndr_agents` doesn't check MySQL creds or call `mysql_lib.query` yet.

- [ ] **Step 4: Rewrite `fetch_online_ndr_agents`**

Replace `scripts/assign_ndr_leads.py:116-159` (docstring at `116-128` stays, update its
`agent_presence` reference from Postgres to MySQL; body from `conn_str = ...` onward):

```python
    cred = mysql_lib.get_credential()
    if cred is None:
        print("MYSQL_* credentials not configured - cannot determine online agents.")
        return [], {}, {}, {}, {}, {}
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=STALE_MINUTES)
    rows = mysql_lib.query(
        "SELECT email FROM agent_presence WHERE status = %s AND updated_at >= %s ORDER BY email",
        ("Online", cutoff),
    )
    present = {row[0].lower() for row in (rows or [])}

    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        print("POSTGRES_URL not configured - using global presence only.")
        return sorted(present), {}, {}, {}, {}, {}
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    "SELECT email, status, max_quota, attempt_count_filter, ndr_reason_filter, "
                    "ndr_payment_mode_filter, ndr_brand_filter "
                    "FROM calling_agent_process WHERE process_key = %s",
                    (PROCESS_KEY,),
                )
                per_process = cur.fetchall()
            except Exception as e:
                print(f"  (calling_agent_process unavailable: {e} - using global presence)")
                return sorted(present), {}, {}, {}, {}, {}
```

Everything from `if not per_process:` (`scripts/assign_ndr_leads.py:157`) through the end of
the function (`scripts/assign_ndr_leads.py:183`) is unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `python scripts/test_assign_ndr_leads.py`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/assign_ndr_leads.py scripts/test_assign_ndr_leads.py
git commit -m "feat: read agent_presence from MySQL in assign_ndr_leads.py"
```

---

### Task 6: Cutover sequencing checklist + retirement

**Files:**
- Delete: `scripts/sync_agent_presence_log_to_mysql.py`
- Delete: `.github/workflows/sync-lead-assignments.yml` (after Step 1 below — see reasoning
  in that step)
- Modify: `.github/workflows/deploy-cron-lambdas.yml:23` (remove the deleted script's path
  trigger line)

**Interfaces:** None — this task deletes dead code and updates CI config, no runtime interfaces change.

- [ ] **Step 1: Decide the fate of `sync-lead-assignments.yml`**

Read `.github/workflows/sync-lead-assignments.yml`. Its only real step is "Sync new agent
presence log rows" (running the script being deleted); its own comment (lines 33-36) already
notes that `lead_assignments`' sync step was removed from this same file for an identical
reason (moved off Postgres) and the file was kept around anyway at the time. Once this step
is also removed, the workflow has zero remaining work (just checkout/setup/install with
nothing to run) — delete the whole file rather than leave an empty shell that a manual
"Run workflow" button does nothing useful for.

```bash
git rm .github/workflows/sync-lead-assignments.yml scripts/sync_agent_presence_log_to_mysql.py
```

- [ ] **Step 2: Remove the deleted script from `deploy-cron-lambdas.yml`'s path triggers**

In `.github/workflows/deploy-cron-lambdas.yml`, delete line 23:

```yaml
      - 'scripts/sync_agent_presence_log_to_mysql.py'
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-cron-lambdas.yml
git commit -m "chore: retire the Postgres -> MySQL agent_presence_log archival sync"
```

- [ ] **Step 4: Full cutover checklist (you run this, in order)**

This restates the spec's Sequencing section as an execution checklist:

1. Task 1 already ran once (`agent_presence` + `changed_at` index created).
2. Task 2's backfill script, `--apply`, at least once.
3. Re-run Task 2's backfill script `--apply` one more time, immediately before step 4.
4. Run Task 1's script with the id-conversion flag:
   `python scripts/migrate_agent_presence_schema.py --apply --convert-id` — dry-run it first
   without `--apply` to confirm the plan contains exactly one step (`convert
   agent_presence_log.id to AUTO_INCREMENT`) before applying.
5. Deploy Task 3 (Lambda `api/` bundle) and Task 4/5 (cron scripts) together.
6. Verify: roster page shows correct live agent status; RTO CRM Overview tab's per-agent
   login/break-time numbers for a known past date range match what they showed before
   cutover; both `assign_leads.py` and `assign_ndr_leads.py` (run manually or via their next
   scheduled invocation) report the expected set of online agents in their console output.
7. Once verified, Task 6 Steps 1-3 above retire the old sync job.

No step in this task is run by the assistant — every command here is for the user to execute
against the real database and deployed app.
