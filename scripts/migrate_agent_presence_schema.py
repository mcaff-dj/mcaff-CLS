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
