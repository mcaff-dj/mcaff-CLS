#!/usr/bin/env python3
"""Adds address_city/address_state/address_pincode to MySQL PEP_CLS.CLS_RTO_calling.

The RTO CRM's "Data" sheet has always carried these (columns L/M/N - "Address City"/"Address
State"/"Address Pincode", see process_rto_csv_upload_job.py's EXPECTED_SHEET_HEADER) but nothing
persisted them onto this table - same gap payment_mode closed for payment method (see
add_payment_mode_column.py). Stamped at ASSIGNMENT time (this row's creation), not disposal -
see scripts/assign_leads.py's record_lead_assignments, api/_lib/db.js's claimRtoLead (manual
self-claim and next-lead.js's auto top-up both go through it). See
backfill_cls_rto_calling_address.py for existing rows (city/state only - Item_level_data, that
script's source, carries no pincode).

Same idiom as add_payment_mode_column.py: idempotent (checks information_schema first),
dry-run by default, --apply performs the DDL.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"

NEW_COLUMNS = [
    ("address_city", "VARCHAR(128) NULL"),
    ("address_state", "VARCHAR(64) NULL"),
    ("address_pincode", "VARCHAR(16) NULL"),
]


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


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
        plan = []
        for col, ddl in NEW_COLUMNS:
            if _column_exists(cur, col):
                print(f"{col} already present - skipping.")
            else:
                plan.append((col, f"ALTER TABLE `{TABLE}` ADD COLUMN `{col}` {ddl}"))

        if not plan:
            print("\nAll columns already present - nothing to do.")
            return

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} column(s):")
        for col, stmt in plan:
            print(f"  - {col}\n      {stmt}")

        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return

        for col, stmt in plan:
            cur.execute(stmt)
            conn.commit()
            print(f"  done: {col}")
        print("\nDone.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
