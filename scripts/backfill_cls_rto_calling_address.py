#!/usr/bin/env python3
"""Backfills address_city/address_state on existing PEP_CLS.CLS_RTO_calling rows from
mcaff_prod.Item_level_data by AWB (CLS_RTO_calling.awb_code = Item_level_data.Tracking_Number) -
same cross-schema lookup key backfill_delivery_escalation_shipping_city.py already uses for the
same source table. Run add_address_columns_to_cls_rto_calling.py --apply first.

address_pincode is NOT backfilled here - Item_level_data (see docs/CODEBASE_REFERENCE.md's data
store map) carries Shipping_Address_City/Shipping_Address_State only, no pincode. Existing rows
keep address_pincode NULL; it starts filling only from new disposals, which read it straight off
the sheet (recordLeadDisposition).

Batched IN(...) lookups against Item_level_data, not a JOIN across the whole ~50M-row table -
see gen_geo_insights.py's own comment: an unfiltered scan/join against it is what times out, a
targeted IN() on its indexed Tracking_Number is what's fast. Item_level_data has multiple rows
per Tracking_Number (split shipments/re-syncs); ORDER BY Created DESC + first-row-seen-wins picks
the latest, same as backfill_delivery_escalation_shipping_city.py's dedupe_city_rows.

Dry-run by default; --apply performs the backfill. Idempotent - a plain UPDATE by awb_code, so
re-running just refreshes it.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"
SOURCE = "mcaff_prod.Item_level_data"
BATCH_SIZE = 500


def dedupe_address_rows(rows):
    """rows: iterable of (Tracking_Number, city, state) already ORDER BY Created DESC ->
    {awb: (city, state)} keeping the first (latest) pair seen per AWB."""
    address_by_awb = {}
    for awb, city, state in rows:
        address_by_awb.setdefault(awb, (city, state))
    return address_by_awb


def connect():
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    return pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        read_timeout=180, write_timeout=180,
    )


def self_check():
    assert dedupe_address_rows([
        ("AWB1", "Mumbai", "Maharashtra"), ("AWB1", "Pune", "Maharashtra"), ("AWB2", "Delhi", "Delhi"),
    ]) == {"AWB1": ("Mumbai", "Maharashtra"), "AWB2": ("Delhi", "Delhi")}
    assert dedupe_address_rows([]) == {}
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the backfill (default is a dry run).")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(
            f"SELECT DISTINCT awb_code FROM `{TABLE}` WHERE awb_code IS NOT NULL AND awb_code <> ''"
        )
        awbs = [r[0] for r in cur.fetchall()]
        print(f"{len(awbs)} distinct AWB(s) to look up in {SOURCE}.")

        if not args.apply:
            print("Would then batch-lookup each AWB in Item_level_data and UPDATE matching rows.")
            print("Re-run with --apply to execute.")
            return

        total_batches = -(-len(awbs) // BATCH_SIZE) if awbs else 0
        updated = 0
        for i in range(0, len(awbs), BATCH_SIZE):
            batch = awbs[i:i + BATCH_SIZE]
            placeholders = ",".join(["%s"] * len(batch))
            cur.execute(
                f"SELECT Tracking_Number, Shipping_Address_City, Shipping_Address_State FROM {SOURCE} "
                f"WHERE Tracking_Number IN ({placeholders}) "
                f"AND (Shipping_Address_City IS NOT NULL OR Shipping_Address_State IS NOT NULL) "
                f"ORDER BY Created DESC",
                batch,
            )
            address_by_awb = dedupe_address_rows(cur.fetchall())
            if address_by_awb:
                cur.executemany(
                    f"UPDATE `{TABLE}` SET address_city = %s, address_state = %s WHERE awb_code = %s",
                    [(city, state, awb) for awb, (city, state) in address_by_awb.items()],
                )
                conn.commit()
                updated += cur.rowcount
            print(f"  batch {i // BATCH_SIZE + 1}/{total_batches}: {len(address_by_awb)}/{len(batch)} matched")
        print(f"\nDone - updated ~{updated} row(s) in {SCHEMA}.{TABLE}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
