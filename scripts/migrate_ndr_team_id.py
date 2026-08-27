#!/usr/bin/env python3
"""Adds PEP_CLS.calling_agent_process.team_id - the per-agent team membership behind NDR
Calling's two-team isolation (see docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md).

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER
TABLE anywhere in api/. So a new TABLE ships itself with the Lambda deploy (see
calling_teams in api/_lib/db.js) while a new COLUMN cannot - and api/ code that selects
team_id deploys automatically in about a minute. Running this BEFORE that deploy is not
optional: a missing column throws ER_BAD_FIELD_ERROR inside getCallingProcessAgents, which
serves the RTO CRM roster and the Escalation desk as well as NDR.

NULL means "not assigned to a team". That is the INVERSE of report_tab_permissions'
convention, where absence of rows means UNRESTRICTED access - here, absence (NULL) means
UNASSIGNED, not unrestricted. This is deliberate; see the spec. Existing rows stay NULL, and
reads behave exactly as they do today until a second ACTIVE row exists in calling_teams, so
applying this early is safe and reversible.

Dry-run by default; --apply performs the DDL. Safe to re-run: an already-applied step is
detected and skipped, matching this repo's other one-off MySQL schema scripts (see
migrate_cls_rto_calling_schema.py).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_agent_process"


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

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} step(s):")
        for label, stmt in plan:
            print(f"  - {label}\n      {stmt}")

        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return 0

        for label, stmt in plan:
            cur.execute(stmt)
            conn.commit()
            print(f"  done: {label}")

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
