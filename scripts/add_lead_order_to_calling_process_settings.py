#!/usr/bin/env python3
"""One-off: adds calling_process_settings.lead_order (VARCHAR(10)) - admin-editable pick
between 'oldest' (default: getNextDetractorLead's existing oldest-unclaimed-first behavior)
and 'newest' (most recently submitted unclaimed lead first). NULL = unset, caller falls back
to 'oldest', same NULL-means-unset contract default_quota already uses on this table.

Idempotent - skipped if the column already exists. Dry-run by default; --apply to write.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_process_settings"
COLUMN = "lead_order"
COLUMN_DDL = "VARCHAR(10)"


def _column_exists(cur):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, COLUMN),
    )
    return cur.fetchone() is not None


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
        if _column_exists(cur):
            print(f"{TABLE}.{COLUMN} already exists - skipping.")
            return
        print(f"Plan: ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` {COLUMN_DDL}")
        if args.apply:
            cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` {COLUMN_DDL}")
            conn.commit()
            print("column added.")
        else:
            print("Dry run - re-run with --apply to write.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
