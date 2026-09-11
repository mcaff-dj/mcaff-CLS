#!/usr/bin/env python3
"""One-off DDL: adds a 'Resolved Refunded' branch to PEP_CLS.Delivery_escalation's `de_day_bucket`
VIRTUAL GENERATED column, so the TAT-by-Query-Date table (Overview tab) gets a 'Resolved Refunded'
column next to 'Forced to be marked as RTO' - see db.js's DE_DAYWISE_BUCKET_SQL/DE_DAYWISE_BUCKETS,
which this mirrors by hand (MySQL can't import a JS string - same note
alter_delivery_escalation_add_bucket_columns.py already gives).

A resolved sub-case (outcome = 'Resolved > Refunded'), not a whole view - already a subset of the
'Delivered'/'Resolved > %' population the old CASE fell through to the TAT-day buckets for, just
given its own label here instead.

`de_day_bucket` is VIRTUAL, so this is a MODIFY COLUMN re-stating its full definition (MySQL has
no ALTER ... ADD CASE WHEN), not an additive ALTER - re-running it is still safe since the check
below only applies the DDL when the new branch isn't already present in the column's stored
generation expression.

Dry-run by default; --apply performs the DDL.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"
COLUMN = "de_day_bucket"

NEW_BUCKET_DDL = f"""ALTER TABLE `{TABLE}` MODIFY COLUMN `{COLUMN}` VARCHAR(40)
  GENERATED ALWAYS AS (
    CASE
      WHEN (tat IS NOT NULL AND tat = 'Forced to be marked as RTO')
        OR (outcome IS NOT NULL AND (outcome = 'RTO' OR outcome LIKE 'RTO > %' OR outcome = 'RTO_MBP' OR outcome LIKE 'RTO_MBP > %'))
        THEN 'Forced to be marked as RTO'
      WHEN NOT (outcome = 'Delivered' OR outcome LIKE 'Delivered > %' OR outcome = 'Resolved' OR outcome LIKE 'Resolved > %')
        THEN 'unresolved'
      WHEN disposed_at IS NULL OR added_date IS NULL THEN 'unresolved'
      WHEN outcome = 'Resolved > Refunded' THEN 'Resolved Refunded'
      WHEN DATEDIFF(disposed_at, added_date) <= 2 THEN 'Within 48 hrs'
      WHEN DATEDIFF(disposed_at, added_date) <= 4 THEN 'Within 2-4 days'
      WHEN DATEDIFF(disposed_at, added_date) <= 8 THEN '4-8 days'
      WHEN DATEDIFF(disposed_at, added_date) <= 10 THEN '8-10 days'
      ELSE 'Greater than 10 days'
    END
  ) VIRTUAL"""


def _generation_expression(cur):
    cur.execute(
        "SELECT generation_expression FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, COLUMN),
    )
    row = cur.fetchone()
    if row is None:
        raise SystemExit(f"{COLUMN} does not exist on {TABLE} - run "
                          "alter_delivery_escalation_add_bucket_columns.py first.")
    return row[0]


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
        expr = _generation_expression(cur)
        if "Resolved Refunded" in expr:
            print(f"{COLUMN} already has the Resolved Refunded branch - skipping.")
            return

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'}:\n{NEW_BUCKET_DDL}\n")
        if not args.apply:
            print("Re-run with --apply to execute.")
            return

        cur.execute(NEW_BUCKET_DDL)
        conn.commit()
        print("done: de_day_bucket now includes the Resolved Refunded branch.")
        print("\nRun ANALYZE TABLE Delivery_escalation; afterward if query plans don't reflect")
        print("the change right away (optimizer statistics can lag DDL).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
