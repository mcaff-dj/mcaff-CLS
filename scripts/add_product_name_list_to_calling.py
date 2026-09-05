#!/usr/bin/env python3
"""One-off: adds a few more order-context columns from nps_delivery onto CLS_NPS_calling -
product_name_list (product(s) the order actually contained, comma-separated when more than
one), payment_method (cod/prepaid), courier_company. Column types mirror nps_delivery's own
(confirmed via information_schema, not assumed).

Column add only - same caveats as scripts/add_nps_area_ratings_to_calling.py: no backfill of
existing rows, and getNextDetractorLead needs its own matching SELECT/INSERT change to
populate these on future assignments.

Idempotent - each ADD COLUMN is skipped if it already exists. Dry-run by default; --apply
performs the ALTERs.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_NPS_calling"

NEW_COLUMNS = {
    "product_name_list": "TEXT",
    "payment_method": "VARCHAR(50)",
    "courier_company": "VARCHAR(100)",
}


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the ALTER TABLEs (default is a dry run).")
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
        added = skipped = 0
        for column, ddl in NEW_COLUMNS.items():
            if _column_exists(cur, column):
                print(f"{TABLE}.{column} already exists - skipping.")
                skipped += 1
                continue
            print(f"Plan: ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
            if args.apply:
                cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
                conn.commit()
                print("  added.")
            added += 1
        if not args.apply:
            print(f"\nDry run - {added} column(s) would be added, {skipped} already exist. Re-run with --apply to write.")
        else:
            print(f"\nAdded {added} column(s); {skipped} already existed.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
