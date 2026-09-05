#!/usr/bin/env python3
"""One-off: adds calling_agent_process.detractor_brand_filter - NPS-Calling's per-agent brand
restriction, same shape as the existing ndr_brand_filter column but validated against
nps_delivery.brand's own casing ('Mcaffeine'/'Hyphen'), not ndr_brand_filter's ('mCaffeine').
'' = no restriction.

Column add only. Idempotent - skipped if it already exists. Dry-run by default; --apply
performs the ALTER.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_agent_process"
COLUMN = "detractor_brand_filter"
DDL = "VARCHAR(16)"


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
            print(f"{TABLE}.{COLUMN} already exists - nothing to do.")
            return
        print(f"Plan: ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` {DDL}")
        if args.apply:
            cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` {DDL}")
            conn.commit()
            print("Added.")
        else:
            print("\nDry run - re-run with --apply to write.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
