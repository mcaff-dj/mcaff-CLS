#!/usr/bin/env python3
"""One-off: adds CLS_NPS_calling.affected_products (TEXT) - the specific product(s), from that
lead's own product_name_list, the agent identifies as the actual subject of a "Product Related
Issue" disposition. Comma-joined, same shape as product_name_list itself.

Unlike the other add_*_to_calling.py scripts, this column has nothing to copy from
nps_delivery at assignment time - it's filled in by the agent at dispose time, via
api/detractor/lead-assignment.js.

Idempotent - skipped if the column already exists. Dry-run by default; --apply to write.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_NPS_calling"
COLUMN = "affected_products"
COLUMN_DDL = "TEXT"


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
