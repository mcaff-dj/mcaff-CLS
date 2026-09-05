#!/usr/bin/env python3
"""One-off: adds the remaining per-area rating/reason columns from nps_delivery onto
CLS_NPS_calling, so the calling card can show a detractor's sentiment across every
surveyed area (Order Placement, Platform, Product, Customer Support, Delivery), not just
whichever area's *_detractor_reason happened to trigger their overall Detractor status.

CLS_NPS_calling already carried nps_score and each area's *_detractor_reason/_openend
(copied by getNextDetractorLead at assignment time); this adds the promoter/passive
reason pairs and the four per-area ratings (order_placement_experience,
product_first_impression, cs_team_rating, delivery_service_rating - see
scripts/nps_source.py's AREA_RATING_COLUMNS for why these four specifically), plus
top_rated_area, other_l1_specify and cs_reach. Column types mirror nps_delivery's own
(confirmed via information_schema, not assumed).

Column add only - this does NOT backfill existing CLS_NPS_calling rows (nps_delivery is
read-only and never re-joined after assignment, by design; see that table's own comment
in db.js) and does NOT touch getNextDetractorLead's own SELECT/INSERT lists, which need
their own matching code change to actually populate these columns on FUTURE assignments.

Idempotent - each ADD COLUMN is skipped if the column already exists (information_schema
check first). Dry-run by default; --apply performs the ALTERs.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_NPS_calling"

NEW_COLUMNS = {
    "top_rated_area": "TEXT",
    "other_l1_specify": "TEXT",
    "order_placement_experience": "VARCHAR(20)",
    "order_placement_promoter_reason": "TEXT",
    "order_placement_promoter_openend": "TEXT",
    "platform_passive_reason": "TEXT",
    "platform_passive_openend": "TEXT",
    "product_first_impression": "VARCHAR(20)",
    "product_packaging_promoter_reason": "TEXT",
    "product_packaging_promoter_openend": "TEXT",
    "product_first_impression_passive_reason": "TEXT",
    "product_first_impression_passive_openend": "TEXT",
    "cs_reach": "VARCHAR(10)",
    "cs_team_rating": "VARCHAR(20)",
    "cs_promoter_reason": "TEXT",
    "cs_promoter_openend": "TEXT",
    "cs_passive_reason": "TEXT",
    "cs_passive_openend": "TEXT",
    "delivery_service_rating": "VARCHAR(20)",
    "delivery_promoter_reason": "TEXT",
    "delivery_promoter_openend": "TEXT",
    "delivery_passive_reason": "TEXT",
    "delivery_passive_openend": "TEXT",
}


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the ALTER TABLEs (default is a dry run).")
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
        added = skipped = 0
        for column, ddl in NEW_COLUMNS.items():
            if _column_exists(cur, column):
                print(f"{TABLE}.{column} already exists - skipping.")
                skipped += 1
                continue
            print(f"Plan: ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
            if args.apply:
                cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
                conn.commit()
                print(f"  added.")
            added += 1
        if not args.apply:
            print(f"\nDry run - {added} column(s) would be added, {skipped} already exist. Re-run with --apply to write.")
        else:
            print(f"\nAdded {added} column(s); {skipped} already existed.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
