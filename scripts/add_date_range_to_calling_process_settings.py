#!/usr/bin/env python3
"""One-off: adds calling_process_settings.date_from/date_to (DATE, DATE) - admin-editable
recency window a detractor lead's submitted_date must fall within to be eligible for
auto-assignment (Admin Panel's "Lead Date Range" card). Both NULL (the default) means "use
this process's own built-in fallback window" - see resolveDetractorRecencyBounds in
api/_lib/detractorMerge.js. Same shape as add_lead_order_to_calling_process_settings.py.

Idempotent - skips whichever column already exists. Dry-run by default; --apply to write.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_process_settings"
COLUMNS = [("date_from", "DATE"), ("date_to", "DATE")]


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the ALTER TABLE(s) (default is a dry run).")
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
        for column, ddl in COLUMNS:
            if _column_exists(cur, column):
                print(f"{TABLE}.{column} already exists - skipping.")
                continue
            print(f"Plan: ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
            if args.apply:
                cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
                conn.commit()
                print(f"{column} added.")
            else:
                print("Dry run - re-run with --apply to write.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
