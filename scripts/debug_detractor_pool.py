#!/usr/bin/env python3
"""Read-only diagnostic for "Next to Assign shows 0 / nobody is getting NPS-Calling leads".

The Next to Assign tab reads getUnassignedDetractorLeads (api/_lib/db.js), whose WHERE clause
is three conditions stacked: nps_category = 'Detractor', no row yet in CLS_NPS_calling, and
submitted_date within the last 30 days. An empty tab means one of those three emptied out, and
they have completely different fixes - so this prints each one separately for both pools
(nps_delivery and nps_product) instead of just re-confirming the zero:

  1. unclaimed Detractors with NO date filter at all   -> is there anything left in the pool?
  2. ...of those, how many fall inside the 30-day window (what the app actually offers)
  3. newest submitted_date present in the table         -> has the upstream NPS feed stopped?
     (nothing in this repo writes these two tables - they come from an external pipeline)
  4. rows whose submitted_date does not parse as DD/MM/YYYY -> STR_TO_DATE returns NULL for
     these and the recency filter silently drops them, so a format drift upstream looks
     exactly like an empty pool

Reading the output:
  (1) is 0                      -> pool genuinely exhausted; every Detractor is already claimed.
                                   Nothing to fix in code - wait for the feed, or widen scope.
  (1) > 0 but (2) is 0          -> leads exist but are all older than 30 days. The window is
                                   the constraint, not the data (DETRACTOR_RECENCY_DAYS-shaped
                                   change, currently hardcoded as INTERVAL 30 DAY in db.js).
  (3) is weeks old              -> the upstream NPS ingestion stopped; fix the feed, not the app.
  (4) > 0                       -> submitted_date format drifted; those rows are invisible to
                                   both the app and count (2).

No writes, no assignment - safe to run any time.

Usage: python scripts/debug_detractor_pool.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
RECENCY_DAYS = 30  # mirrors the INTERVAL 30 DAY in api/_lib/db.js's detractor pool queries

# nps_delivery is one row per response_id; nps_product is one row per (response_id, product_slot)
# with nps_category constant across a response's own slots, so it is deduped to distinct
# response_id to match "one lead per person" - the same shape the app's own query produces.
POOLS = {
    "delivery": {
        "table": "nps_delivery",
        "count": "COUNT(*)",
    },
    "product": {
        "table": "nps_product",
        "count": "COUNT(DISTINCT p.response_id)",
    },
}


def main():
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        cur = conn.cursor()
        for pool, spec in POOLS.items():
            table, count_expr = spec["table"], spec["count"]
            print(f"\n=== {pool} pool ({table}) ===")

            # (1) unclaimed Detractors, no date filter
            cur.execute(
                f"""
                SELECT {count_expr} AS n
                FROM {table} p
                LEFT JOIN CLS_NPS_calling c ON c.response_id = p.response_id
                WHERE c.response_id IS NULL AND p.nps_category = 'Detractor'
                """
            )
            total = cur.fetchone()["n"]

            # (2) ...of those, inside the window the app actually offers
            cur.execute(
                f"""
                SELECT {count_expr} AS n
                FROM {table} p
                LEFT JOIN CLS_NPS_calling c ON c.response_id = p.response_id
                WHERE c.response_id IS NULL AND p.nps_category = 'Detractor'
                  AND STR_TO_DATE(p.submitted_date, '%%d/%%m/%%Y') >= DATE_SUB(CURDATE(), INTERVAL %s DAY)
                """,
                (RECENCY_DAYS,),
            )
            in_window = cur.fetchone()["n"]

            print(f"  unclaimed Detractors, any date : {total}")
            print(f"  ...within last {RECENCY_DAYS} days (offered) : {in_window}")
            if total and not in_window:
                print(f"  >> {total} unclaimed lead(s) exist but ALL fall outside the {RECENCY_DAYS}-day window.")
            elif not total:
                print("  >> pool is genuinely exhausted - every Detractor is already claimed.")

            # (3) how fresh is the upstream feed
            cur.execute(
                f"""
                SELECT MAX(STR_TO_DATE(submitted_date, '%d/%m/%Y')) AS newest,
                       DATEDIFF(CURDATE(), MAX(STR_TO_DATE(submitted_date, '%d/%m/%Y'))) AS days_old
                FROM {table}
                """
            )
            fresh = cur.fetchone()
            print(f"  newest submitted_date in table : {fresh['newest']} ({fresh['days_old']} day(s) old)")
            if fresh["days_old"] is not None and fresh["days_old"] > RECENCY_DAYS:
                print("  >> upstream NPS feed has not landed a row inside the window - fix the feed, not the app.")

            # (4) unparseable dates are invisible to the recency filter
            cur.execute(
                f"""
                SELECT COUNT(*) AS n FROM {table}
                WHERE submitted_date IS NOT NULL AND TRIM(submitted_date) <> ''
                  AND STR_TO_DATE(submitted_date, '%d/%m/%Y') IS NULL
                """
            )
            bad = cur.fetchone()["n"]
            print(f"  rows with unparseable submitted_date : {bad}"
                  f"{'  >> these are silently dropped by the recency filter' if bad else ''}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
