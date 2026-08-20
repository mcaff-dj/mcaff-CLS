#!/usr/bin/env python3
"""One-off: backfills payment_mode for MySQL PEP_CLS.CLS_RTO_calling rows left NULL because
the column didn't exist until add_payment_mode_column.py - every row assigned/claimed/
disposed before that migration has no payment_mode at all.

Looks each row's order_id up against the RTO 'Data' sheet's Payment Method column (O, index
14 - see scripts/lead_priority.py's COL_PAYMENT_METHOD), normalized via lead_priority.is_prepaid
into 'Prepaid'/'COD' - the same source and the same normalization assign_leads.py itself uses
at assignment time.

THIS IS A PROXY, NOT A RECOVERY, same caveat as backfill_rto_reason.py: the sheet only has
TODAY's value, and payment method is an order-level fact (how the customer originally paid),
not something that changes with which agent is calling - so today's value is expected to
still be correct, but that's an assumption this script makes on your behalf.

NOT SCOPED to live cycles only, same reasoning as backfill_rto_reason.py: payment_mode is an
order-level fact rather than a per-agent-attempt one, so the same sheet value is written to
every row - live or retired - still missing it for that order_id. The Overview tab's RTO
Reason breakdown reads connected/converted from every cycle (see
getCallingRtoReasonBreakdown), so a retired row's payment_mode matters just as much as a live
one's.

Only writes when a match is found in the sheet - an order_id no longer present (e.g. archived,
aged out of the sheet's rolling window) is left NULL rather than guessed at. Those rows will
never be backfillable once they've aged out - there is no historical record of what the sheet
said back when they were assigned.

Dry run by default; --apply performs the writes.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib
from lead_priority import COL_ORDER_ID, COL_PAYMENT_METHOD, cell, is_prepaid

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"
SCHEMA = "PEP_CLS"


def build_payment_mode_by_order_id():
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AD")
    mapping = {}
    for row in values:
        order_id = cell(row, COL_ORDER_ID).strip()
        if not order_id or order_id in mapping:
            continue
        mapping[order_id] = "Prepaid" if is_prepaid(cell(row, COL_PAYMENT_METHOD)) else "COD"
    return mapping


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    if mysql_lib.get_credential() is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    print(f"Reading '{SHEET_TAB}'...")
    payment_mode_by_order_id = build_payment_mode_by_order_id()
    print(f"  {len(payment_mode_by_order_id)} distinct order_id -> payment_mode mapping(s) from the sheet.")

    missing = [
        order_id for (order_id,) in mysql_lib.query(
            "SELECT DISTINCT order_id FROM CLS_RTO_calling WHERE payment_mode IS NULL",
            database=SCHEMA,
        ) or []
    ]
    print(f"  {len(missing)} distinct order_id(s) in CLS_RTO_calling with payment_mode still NULL.")

    pairs = []  # (payment_mode, order_id)
    not_found = 0
    for order_id in missing:
        mode = payment_mode_by_order_id.get(order_id)
        if not mode:
            not_found += 1
            continue
        pairs.append((mode, order_id))

    print(f"\n{len(pairs)} order_id(s) resolvable against the sheet; {not_found} not found (left NULL).")
    if not args.apply:
        print("\nDry run - re-run with --apply to write.")
        return

    # Batched via executemany, same chunking rationale as backfill_rto_reason.py: bounded
    # transaction size, so a mid-run failure only loses the current chunk.
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
                "UPDATE CLS_RTO_calling SET payment_mode = %s WHERE order_id = %s AND payment_mode IS NULL",
                chunk,
            )
            conn.commit()
        print(f"Backfilled payment_mode for {len(pairs)} order_id(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
