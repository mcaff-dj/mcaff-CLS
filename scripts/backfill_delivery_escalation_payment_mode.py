#!/usr/bin/env python3
"""One-off DDL + backfill: adds `Payment_Mode` to PEP_CLS.Delivery_escalation and derives it from
mcaff_prod.Item_level_data by AWB (Delivery_escalation.awb_code = Item_level_data.Tracking_Number)
- same cross-schema lookup key backfill_delivery_escalation_shipping_city.py already uses for
Shipping_Address_City. Item_level_data has no Payment_Mode/Payment_Method column of its own -
only `COD` (bigint) - so the value is derived: COD = 1 -> 'COD', else -> 'Prepaid'. A row whose
COD itself is NULL is skipped rather than guessed at, same "only write when a real match exists"
rule backfill_payment_mode.py already applies to its own (unrelated) sheet-sourced backfill.
Kept fresh for new tickets going forward by sync_delivery_tickets_to_sheet.py's own
fetch_payment_mode_by_awb, at insert time.

Batched IN(...) lookups against Item_level_data, not a JOIN across the whole ~50M-row table -
same reasoning as the city backfill: a targeted IN() on its indexed Tracking_Number is fast, an
unfiltered scan/join isn't. Item_level_data has multiple rows per Tracking_Number (split
shipments/re-syncs); ORDER BY Created DESC + first-row-seen-wins picks the latest.

Plain nullable column, not generated - the source lives in a different schema, out of reach for
a generated column's own-row-only expression.

Dry-run by default; --apply performs the DDL and backfill. Idempotent - skips the ALTER if the
column exists, and the backfill is a plain UPDATE by awb_code so re-running just refreshes it.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"
COLUMN = "Payment_Mode"
SOURCE = "mcaff_prod.Item_level_data"
# Item_level_data's own payment signal - see this module's docstring on why it's derived rather
# than copied 1:1 from a same-named column (there isn't one).
SOURCE_EXPR = "CASE WHEN COD = 1 THEN 'COD' ELSE 'Prepaid' END"
BATCH_SIZE = 500


def dedupe_payment_mode_rows(rows):
    """rows: iterable of (Tracking_Number, Payment_Mode) already ORDER BY Created DESC ->
    {awb: payment_mode} keeping the first (latest) value seen per AWB."""
    mode_by_awb = {}
    for awb, mode in rows:
        mode_by_awb.setdefault(awb, mode)
    return mode_by_awb


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
    assert dedupe_payment_mode_rows([("AWB1", "Prepaid"), ("AWB1", "COD"), ("AWB2", "COD")]) == {
        "AWB1": "Prepaid", "AWB2": "COD",
    }
    assert dedupe_payment_mode_rows([]) == {}
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DDL + backfill (default is a dry run).")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
            (SCHEMA, TABLE, COLUMN),
        )
        column_exists = cur.fetchone() is not None

        if column_exists:
            print(f"{COLUMN} already present on {SCHEMA}.{TABLE}.")
        else:
            ddl = f"ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` VARCHAR(32) NULL"
            print(f"{'Applying' if args.apply else 'DRY RUN - would apply'}:\n\n{ddl}\n")
            if args.apply:
                cur.execute(ddl)
                conn.commit()
                print(f"Added {COLUMN} to {SCHEMA}.{TABLE}.")

        cur.execute(f"SELECT DISTINCT awb_code FROM `{TABLE}` WHERE awb_code IS NOT NULL AND awb_code <> ''")
        awbs = [r[0] for r in cur.fetchall()]
        print(f"\n{len(awbs)} distinct AWB(s) to look up in {SOURCE}.")

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
                f"SELECT Tracking_Number, {SOURCE_EXPR} FROM {SOURCE} "
                f"WHERE Tracking_Number IN ({placeholders}) "
                f"AND COD IS NOT NULL "
                f"ORDER BY Created DESC",
                batch,
            )
            mode_by_awb = dedupe_payment_mode_rows(cur.fetchall())
            if mode_by_awb:
                cur.executemany(
                    f"UPDATE `{TABLE}` SET `{COLUMN}` = %s WHERE awb_code = %s",
                    [(mode, awb) for awb, mode in mode_by_awb.items()],
                )
                conn.commit()
                updated += cur.rowcount
            print(f"  batch {i // BATCH_SIZE + 1}/{total_batches}: {len(mode_by_awb)}/{len(batch)} matched")
        print(f"\nDone - updated ~{updated} row(s) in {SCHEMA}.{TABLE}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
