#!/usr/bin/env python3
"""One-off DDL: widens PEP_CLS.Delivery_escalation's `de_day_bucket` VIRTUAL GENERATED column's
'Resolved Refunded' branch (added by alter_delivery_escalation_add_resolved_refunded_bucket.py)
from an exact match on outcome = 'Resolved > Refunded' to a LIKE match covering
'Resolved > Refunded%' plus 'Resolved > Cancelled and refunded' - see api/_lib/db.js's
DE_RESOLVED_REFUNDED_WHERE, which this mirrors by hand (MySQL can't import a JS string).

Root cause this fixes: no code path ever writes the literal outcome 'Resolved > Refunded'.
auto_dispose_de_categories.py's GoKwik-confirmed rule writes 'Resolved > Refunded-CX', and its
Pincode-not-serviceable rule writes 'Resolved > Cancelled and refunded' - the old exact match
missed both, so every refunded ticket silently fell into the ordinary TAT-day buckets instead of
the 'Resolved Refunded' column (which read 0 despite refunded tickets existing).

`de_day_bucket` is VIRTUAL, so this is a MODIFY COLUMN re-stating its full definition (MySQL has
no ALTER ... ADD CASE WHEN), not an additive ALTER - re-running it is safe since the check below
only applies the DDL when the new branch isn't already present in the column's stored generation
expression.

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
      WHEN outcome LIKE 'Resolved > Refunded%' OR outcome = 'Resolved > Cancelled and refunded' THEN 'Resolved Refunded'
      WHEN DATEDIFF(disposed_at, added_date) <= 2 THEN 'Within 48 hrs'
      WHEN DATEDIFF(disposed_at, added_date) <= 4 THEN 'Within 2-4 days'
      WHEN DATEDIFF(disposed_at, added_date) <= 8 THEN '4-8 days'
      WHEN DATEDIFF(disposed_at, added_date) <= 10 THEN '8-10 days'
      ELSE 'Greater than 10 days'
    END
  ) VIRTUAL"""

MARKER = "Resolved > Refunded%'"


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
        if MARKER in expr:
            print(f"{COLUMN} already has the widened Resolved Refunded branch - skipping.")
            return

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'}:\n{NEW_BUCKET_DDL}\n")
        if not args.apply:
            print("Re-run with --apply to execute.")
            return

        cur.execute(NEW_BUCKET_DDL)
        conn.commit()
        print("done: de_day_bucket's Resolved Refunded branch now covers Refunded-CX and Cancelled and refunded too.")
        print("\nRun ANALYZE TABLE Delivery_escalation; afterward if query plans don't reflect")
        print("the change right away (optimizer statistics can lag DDL).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
