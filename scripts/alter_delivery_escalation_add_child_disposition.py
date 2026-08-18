#!/usr/bin/env python3
"""One-off DDL: adds `child_disposition` to PEP_CLS.Delivery_escalation - the sub-level of the
admin-configured disposition tree, split out of `outcome` so it can be grouped/filtered on its
own instead of only as a substring.

A VIRTUAL GENERATED column, not a written one, deliberately. `outcome` already stores the full
cascading path joined with " > " (see DeliveryEscalationClient.js's dispPath.join(' > ')), so
the child is derivable rather than separate data - and deriving it means it cannot drift out of
sync with outcome. It is also automatically correct for EVERY write path (single dispose, bulk
CSV upload, and anything added later) with no code change in any of them, and is already right
for all existing rows the moment it is added. Same pattern the table's own dedup_key uses.

"Child" = everything after the FIRST " > ", so "Delivered > Late > Courier" yields
"Late > Courier"; a top-level-only outcome ("Delivered") yields NULL.

Dry-run by default; --apply performs the DDL. Idempotent - skips if already present.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"
COLUMN = "child_disposition"

DDL = f"""ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` VARCHAR(255)
  GENERATED ALWAYS AS (
    CASE WHEN `outcome` IS NOT NULL AND LOCATE(' > ', `outcome`) > 0
         THEN SUBSTRING(`outcome`, LOCATE(' > ', `outcome`) + 3)
         ELSE NULL END
  ) VIRTUAL"""


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

        cur.execute(f"""
            SELECT outcome, {COLUMN}, COUNT(*) FROM {TABLE}
            WHERE {COLUMN} IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5
        """)
        rows = cur.fetchall()
        print(f"\nSample (outcome -> {COLUMN}):")
        for outcome, child, n in rows:
            print(f"  {outcome!r} -> {child!r}  ({n} rows)")
        if not rows:
            print("  (no multi-level outcomes recorded yet - column will populate as agents pick one)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
