#!/usr/bin/env python3
"""One-off DDL: adds `de_day_bucket` and `de_contact_bucket` to PEP_CLS.Delivery_escalation, plus
an index on each - the Overview tab's day-wise table (getDeliveryEscalationDaywiseStats in
api/_lib/db.js) GROUPs BY these as a CASE expression on every request, and no index on the raw
columns underneath (outcome, disposed_at, added_date, contact_count - see
alter_delivery_escalation_add_indexes.py) can help a GROUP BY on a value MySQL has to compute
per-row first. That CASE, not any single filter, was the single biggest cost left in that query.

Both are VIRTUAL GENERATED columns, not written ones - same reasoning
alter_delivery_escalation_add_child_disposition.py already gives for child_disposition: each CASE
is fully deterministic from stored columns (outcome/tat/disposed_at/added_date/contact_count, no
CURDATE()/NOW()), so deriving them means they can never drift from db.js's own
DE_DAYWISE_BUCKET_SQL/DE_CONTACT_BUCKET_SQL, MySQL keeps them current on every write with no cron,
and they're already correct for every existing row the moment this runs. Kept in sync with those
two JS constants by hand - MySQL can't import a JS string, so if either CASE in db.js changes, this
file's copy must change with it.

Dry-run by default; --apply performs the DDL. Idempotent - skips whatever's already present.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"

# Mirrors DE_FORCED_RTO_WHERE/DE_RESOLVED_WHERE (db.js) inline rather than referencing them, same
# as db.js's own DE_DAYWISE_BUCKET_SQL does - those two are themselves CASE/OR trees, not simple
# columns, so this reproduces their logic directly instead of trying to compose SQL fragments.
DAY_BUCKET_DDL = f"""ALTER TABLE `{TABLE}` ADD COLUMN `de_day_bucket` VARCHAR(40)
  GENERATED ALWAYS AS (
    CASE
      WHEN (tat IS NOT NULL AND tat = 'Forced to be marked as RTO')
        OR (outcome IS NOT NULL AND (outcome = 'RTO' OR outcome LIKE 'RTO > %' OR outcome = 'RTO_MBP' OR outcome LIKE 'RTO_MBP > %'))
        THEN 'Forced to be marked as RTO'
      WHEN NOT (outcome = 'Delivered' OR outcome LIKE 'Delivered > %' OR outcome = 'Resolved' OR outcome LIKE 'Resolved > %')
        THEN 'unresolved'
      WHEN disposed_at IS NULL OR added_date IS NULL THEN 'unresolved'
      WHEN DATEDIFF(disposed_at, added_date) <= 2 THEN 'Within 48 hrs'
      WHEN DATEDIFF(disposed_at, added_date) <= 4 THEN 'Within 2-4 days'
      WHEN DATEDIFF(disposed_at, added_date) <= 8 THEN '4-8 days'
      WHEN DATEDIFF(disposed_at, added_date) <= 10 THEN '8-10 days'
      ELSE 'Greater than 10 days'
    END
  ) VIRTUAL"""

CONTACT_BUCKET_DDL = f"""ALTER TABLE `{TABLE}` ADD COLUMN `de_contact_bucket` VARCHAR(20)
  GENERATED ALWAYS AS (
    CASE
      WHEN contact_count <= 1 THEN '1 time'
      WHEN contact_count BETWEEN 2 AND 4 THEN '2-4 times'
      WHEN contact_count BETWEEN 5 AND 9 THEN '5-9 times'
      ELSE '10+ times'
    END
  ) VIRTUAL"""

STEPS = [
    ("de_day_bucket", "column", DAY_BUCKET_DDL),
    ("idx_de_day_bucket", "index", f"ALTER TABLE `{TABLE}` ADD INDEX `idx_de_day_bucket` (`de_day_bucket`)"),
    ("de_contact_bucket", "column", CONTACT_BUCKET_DDL),
    ("idx_de_contact_bucket", "index", f"ALTER TABLE `{TABLE}` ADD INDEX `idx_de_contact_bucket` (`de_contact_bucket`)"),
]


def _column_exists(cur, name):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, name),
    )
    return cur.fetchone() is not None


def _index_exists(cur, name):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, TABLE, name),
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
        for name, kind, stmt in STEPS:
            exists = _column_exists(cur, name) if kind == "column" else _index_exists(cur, name)
            if exists:
                print(f"{name} already present - skipping.")
                continue
            plan.append((name, stmt))

        if not plan:
            print("\nAll columns/indexes already present - nothing to do.")
            return

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} step(s):")
        for label, stmt in plan:
            print(f"  - {label}\n{stmt}\n")

        if not args.apply:
            print("Re-run with --apply to execute.")
            return

        # One ALTER per step (not a single multi-change statement) - same reasoning
        # alter_delivery_escalation_add_indexes.py gives: a failure partway through leaves the
        # earlier steps committed, and a re-run picks up only what's left.
        for label, stmt in plan:
            cur.execute(stmt)
            conn.commit()
            print(f"  done: {label}")
        print("\nDone. Run ANALYZE TABLE Delivery_escalation; afterward if query plans don't")
        print("reflect the new indexes right away (optimizer statistics can lag DDL).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
