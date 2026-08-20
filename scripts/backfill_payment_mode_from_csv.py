#!/usr/bin/env python3
"""One-off: backfills payment_mode on MySQL PEP_CLS.CLS_RTO_calling from a CSV export keyed
by tracking number (Tracking_Number, payment mode), joining on awb_code rather than order_id
- a different join key from backfill_payment_mode.py's sheet-based backfill, for whatever
leads that one couldn't resolve (order_id aged out of the sheet's rolling window, but the
courier/payment system still has the AWB on record).

Only fills rows where payment_mode IS STILL NULL - never overwrites a value already set by
the sheet backfill or a live write (assign_leads.py / claimRtoLead / recordLeadDisposition),
since this CSV's provenance/freshness relative to those isn't established. Updates every row
sharing that awb_code, not just the live cycle - payment_mode is an order-level fact, same
reasoning as backfill_payment_mode.py and backfill_rto_reason.py.

Dry run by default; --apply performs the writes.
"""
import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib

SCHEMA = "PEP_CLS"
VALID_MODES = {"COD", "Prepaid"}


def load_csv(path):
    """{awb_code: payment_mode} for every row with a recognized mode. First row wins per
    awb_code (same dedup convention as this repo's sheet-based scripts)."""
    mapping = {}
    skipped = 0
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            awb = (row.get("Tracking_Number") or "").strip()
            mode = (row.get("payment mode") or "").strip()
            if not awb or awb in mapping:
                continue
            if mode not in VALID_MODES:
                skipped += 1
                continue
            mapping[awb] = mode
    return mapping, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path", help="Path to the Tracking_Number,payment mode CSV")
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    if mysql_lib.get_credential() is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    payment_mode_by_awb, skipped = load_csv(args.csv_path)
    print(f"Loaded {len(payment_mode_by_awb)} awb_code -> payment_mode mapping(s) from {args.csv_path}"
          + (f" ({skipped} row(s) with an unrecognized payment mode value skipped)." if skipped else "."))

    missing = [
        row[0] for row in mysql_lib.query(
            "SELECT DISTINCT awb_code FROM CLS_RTO_calling WHERE payment_mode IS NULL "
            "AND awb_code IS NOT NULL AND awb_code <> ''",
            database=SCHEMA,
        ) or []
    ]
    print(f"{len(missing)} distinct awb_code(s) in CLS_RTO_calling with payment_mode still NULL.")

    pairs = []  # (payment_mode, awb_code)
    not_found = 0
    for awb in missing:
        mode = payment_mode_by_awb.get(awb)
        if not mode:
            not_found += 1
            continue
        pairs.append((mode, awb))

    print(f"\n{len(pairs)} awb_code(s) resolvable against the CSV; {not_found} not found in it (left NULL).")
    if not args.apply:
        print("\nDry run - re-run with --apply to write.")
        return

    CHUNK_SIZE = 500
    cred = mysql_lib.get_credential()
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        for start in range(0, len(pairs), CHUNK_SIZE):
            chunk = pairs[start:start + CHUNK_SIZE]
            cur.executemany(
                "UPDATE CLS_RTO_calling SET payment_mode = %s WHERE awb_code = %s AND payment_mode IS NULL",
                chunk,
            )
            conn.commit()
        print(f"Backfilled payment_mode for {len(pairs)} awb_code(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
