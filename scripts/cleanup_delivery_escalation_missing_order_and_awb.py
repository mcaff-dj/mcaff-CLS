#!/usr/bin/env python3
"""One-off cleanup: deletes existing Delivery_escalation rows that have NEITHER a real order_id
nor an AWB - Flowcall's own 'N/A' order_id (any casing) combined with a blank awb_code leaves a
row with no usable identifier at all, unjoinable to anything and unactionable by an agent. See
scripts/sync_delivery_tickets_to_sheet.py's own has_valid_order_id, which now keeps the 2-hourly
sync from creating any MORE of them - this only clears out the ones already there.

A row with 'N/A' order_id but a REAL awb_code is left alone - AWB alone is still a usable
identifier (search/dispose/bulk-upload all key off it), only the (N/A order_id) AND (no AWB)
combination is truly dead weight.

Dry-run by default (prints the count); --apply performs the DELETE.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib

WHERE = (
    "UPPER(TRIM(order_id)) = 'N/A' "
    "AND (awb_code IS NULL OR TRIM(awb_code) = '')"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DELETE (default is a dry run).")
    args = ap.parse_args()

    got = mysql_lib.query(f"SELECT COUNT(*) FROM Delivery_escalation WHERE {WHERE}", database="PEP_CLS")
    if got is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    n = got[0][0]
    print(f"{n} row(s) have order_id = 'N/A' and no AWB")

    if not args.apply:
        print("DRY RUN - would DELETE them. Re-run with --apply to perform it.")
        return
    if n == 0:
        print("Nothing to do.")
        return

    deleted = mysql_lib.execute(f"DELETE FROM Delivery_escalation WHERE {WHERE}", database="PEP_CLS")
    print(f"Deleted {deleted} row(s).")


if __name__ == "__main__":
    main()
