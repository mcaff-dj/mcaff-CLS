#!/usr/bin/env python3
"""Adds secondary indexes to MySQL PEP_CLS.Delivery_escalation.

The table has only PRIMARY KEY(id) and UNIQUE(dedup_key) (see
scripts/alter_delivery_escalation_dedup_key.py) - every column the Overview tab filters or
groups by (outcome, delivery_partner, query_category, brand, agent_email, Payment_Mode,
added_date, order_date, disposed_at) is unindexed, forcing a full table scan on every one of
those queries (getDeliveryEscalationStats/Page/Export/DaywiseStats/GeoCategoryStats in
api/_lib/db.js) regardless of how narrow the filter looks. At the table's current 31k-90k row
scale, with the Overview tab firing ~6 of these concurrently on every mount, 60s auto-refresh,
and tab-focus regain, this is the root cause of the reported slow load.

Single-column indexes, not composites: the query set filters on different subsets of these
columns depending on which tab/table is active (a composite index only helps when its leading
columns match the query's filter order), so single-column indexes let MySQL's optimizer pick
whichever one is most selective per query, and index_merge across several when more than one
applies - simpler to reason about and re-run than guessing every composite the UI might need.

Guarded by an information_schema check per index, safe to re-run. Dry-run by default; --apply
performs the DDL.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"

INDEXES = [
    ("idx_outcome", "outcome"),
    ("idx_delivery_partner", "delivery_partner"),
    ("idx_query_category", "query_category"),
    ("idx_brand", "brand"),
    ("idx_agent_email", "agent_email"),
    ("idx_payment_mode", "Payment_Mode"),
    ("idx_added_date", "added_date"),
    ("idx_order_date", "order_date"),
    ("idx_disposed_at", "disposed_at"),
]


def _index_exists(cur, index_name):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, TABLE, index_name),
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
        for index_name, column in INDEXES:
            if _index_exists(cur, index_name):
                print(f"{index_name} already exists - skipping.")
                continue
            plan.append((index_name, f"ALTER TABLE `{TABLE}` ADD INDEX `{index_name}` (`{column}`)"))

        if not plan:
            print("\nAll indexes already present - nothing to do.")
            return

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} index(es):")
        for label, stmt in plan:
            print(f"  - {label}\n      {stmt}")

        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return

        # Each ADD INDEX is its own ALTER (not one multi-index statement) so a failure partway
        # through (e.g. lock timeout under live write traffic from the sync cron) leaves the
        # earlier indexes committed instead of rolling the whole batch back - re-running picks up
        # only what's left, same idempotency guarantee as every other script here.
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
