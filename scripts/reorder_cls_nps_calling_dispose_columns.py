#!/usr/bin/env python3
"""One-off: moves CLS_NPS_calling.affected_products next to the other columns an agent fills in
when disposing a lead (disposition, agent_remarks, connected, attempt) - today it sits all the
way at the end of the table, separated from that group by ~25 survey-response columns, even
though it's written by the same disposeDetractorLead call (see api/_lib/db.js) that writes
disposition/agent_remarks/connected/attempt.

Reorders only - no data change, no type change. Idempotent (checked via information_schema
before altering). Dry-run by default; --apply performs the ALTER.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_NPS_calling"
MOVE_COLUMN = "affected_products"
AFTER_COLUMN = "attempt"


def _ordinal(cur, column):
    cur.execute(
        "SELECT ordinal_position FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    row = cur.fetchone()
    return row[0] if row else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the ALTER TABLE (default is a dry run).")
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
        move_pos = _ordinal(cur, MOVE_COLUMN)
        after_pos = _ordinal(cur, AFTER_COLUMN)
        if move_pos is None or after_pos is None:
            raise SystemExit(f"Column not found: {MOVE_COLUMN} or {AFTER_COLUMN}")
        if move_pos == after_pos + 1:
            print(f"{MOVE_COLUMN} is already right after {AFTER_COLUMN} - nothing to do.")
            return

        print(f"Current position: {MOVE_COLUMN} is column #{move_pos}, {AFTER_COLUMN} is column #{after_pos}")
        print(f"Plan: ALTER TABLE `{TABLE}` MODIFY COLUMN `{MOVE_COLUMN}` text AFTER `{AFTER_COLUMN}`")
        if args.apply:
            cur.execute(f"ALTER TABLE `{TABLE}` MODIFY COLUMN `{MOVE_COLUMN}` text AFTER `{AFTER_COLUMN}`")
            conn.commit()
            print("Reordered.")
        else:
            print("\nDry run - re-run with --apply to write.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
