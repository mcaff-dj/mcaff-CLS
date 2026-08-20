#!/usr/bin/env python3
"""Adds `payment_mode` (VARCHAR(16) NULL, 'Prepaid'/'COD') to MySQL PEP_CLS.CLS_RTO_calling.

Payment mode has always been available to assign_leads.py (COL_PAYMENT_METHOD /
is_prepaid, see lead_priority.py) and to the RTO CRM client (t.paymentMethod, see
RtoCrmClient.js's parseRows) but was never persisted onto this table - both live only
in the Google Sheet, which the Calling Team Overview tab (api/_lib/db.js's
getCallingOverviewStats/getCallingRtoReasonBreakdown) deliberately does not read, to
keep that tab a single MySQL round trip. This column lets the Overview tab's RTO
Reason breakdown filter by payment mode without adding a sheet dependency.

Existing rows stay NULL until scripts/backfill_payment_mode.py runs - see that
script's docstring for why some rows can never be backfilled.

Same idiom as migrate_cls_rto_calling_schema.py: idempotent (checks
information_schema first), dry-run by default, --apply performs the DDL.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"
COLUMN = "payment_mode"
DDL = f"ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` VARCHAR(16) NULL"


def _column_exists(cur):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, COLUMN),
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
        if _column_exists(cur):
            print(f"{COLUMN} already present on {SCHEMA}.{TABLE} - nothing to do.")
            return
        print(f"{'Applying' if args.apply else 'DRY RUN - would apply'}:\n  {DDL}")
        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return
        cur.execute(DDL)
        conn.commit()
        print("done.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
