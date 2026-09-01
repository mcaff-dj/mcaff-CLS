#!/usr/bin/env python3
"""One-off DDL: adds `new_order_AWB` to MySQL PEP_CLS.Delivery_escalation - tracks the AWB of a
reshipped/replacement order, separate from the original `awb_code` (which stays the (brand,
awb_code) unique key - unchanged by this column).

Dry-run by default (prints the plan); --apply performs the DDL. Idempotent - detects an
already-added column and skips, safe to re-run.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"
COLUMN = "new_order_AWB"
DDL = f"ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` VARCHAR(64) NULL AFTER `awb_code`"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DDL (default is a dry run).")
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
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
            (SCHEMA, TABLE, COLUMN),
        )
        if cur.fetchone():
            print(f"{COLUMN} already present on {SCHEMA}.{TABLE} - nothing to do.")
            return

        print(f"{'Applying' if args.apply else 'DRY RUN - would apply'}:\n\n{DDL}\n")
        if not args.apply:
            print("Re-run with --apply to execute.")
            return

        cur.execute(DDL)
        conn.commit()
        print(f"Added {COLUMN} to {SCHEMA}.{TABLE}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
