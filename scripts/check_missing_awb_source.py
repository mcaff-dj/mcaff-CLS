#!/usr/bin/env python3
"""Read-only: for a list of order_ids with no awb_code in Delivery_escalation, checks (a) the
row itself - brand, ticket_number, added_date, whether it even has a valid order_id right now -
and (b) whether Item_level_data (a DIFFERENT database, mcaff_prod - see fetch_awb_by_order in
sync_delivery_tickets_to_sheet.py) has since picked up a Tracking_Number for it. The sync job
that mirrors Flowcall tickets into Delivery_escalation is a ONE-TIME snapshot: if the courier
hadn't generated an AWB yet (or Flowcall hadn't linked the order yet) at the moment a ticket was
first synced, it's written with a blank awb_code and never re-checked again on its own -
scripts/backfill_delivery_escalation_missing_order_and_awb.py is the one that re-checks. This
script tells you, for each id, whether that re-check would actually find anything now.

Usage: python scripts/check_missing_awb_source.py order_id [order_id ...]
   or: python scripts/check_missing_awb_source.py --file path/to/ids.txt   (one id per line)
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib
from sync_delivery_tickets_to_sheet import _awb_lookup_key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", help="order_id(s) to check")
    ap.add_argument("--file", help="path to a text file, one order_id per line")
    args = ap.parse_args()

    ids = list(args.ids)
    if args.file:
        ids += [line.strip() for line in Path(args.file).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not ids:
        raise SystemExit("Give at least one order_id, or --file a list of them.")

    for order_id in ids:
        rows = mysql_lib.query(
            "SELECT id, brand, ticket_number, order_id, awb_code, added_date, outcome "
            "FROM Delivery_escalation WHERE order_id = %s",
            (order_id,), database="PEP_CLS")
        if rows is None:
            raise SystemExit("MYSQL_* credentials not configured.")

        key = _awb_lookup_key(order_id)
        tracking = mysql_lib.query(
            "SELECT Tracking_Number FROM Item_level_data "
            "WHERE Display_Order_Code = %s AND Tracking_Number IS NOT NULL AND Tracking_Number != '' "
            "ORDER BY Created DESC LIMIT 1",
            (key,), database="mcaff_prod")

        if not rows:
            print(f"{order_id}: NOT FOUND in Delivery_escalation (no row with this exact order_id)")
        else:
            for r in rows:
                id_, brand, ticket_number, oid, awb, added_date, outcome = r
                print(f"{order_id}: id={id_} brand={brand} ticket_number={ticket_number!r} "
                      f"awb_code={awb!r} added_date={added_date} outcome={outcome!r}")

        if tracking:
            print(f"   -> Item_level_data NOW has Tracking_Number={tracking[0][0]!r} for key {key!r} "
                  f"- backfill_delivery_escalation_missing_order_and_awb.py should recover this one.")
        else:
            print(f"   -> Item_level_data has no Tracking_Number yet for key {key!r} either - "
                  f"still genuinely no AWB at the source.")
        print()


if __name__ == "__main__":
    main()
