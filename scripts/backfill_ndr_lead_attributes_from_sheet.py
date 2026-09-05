#!/usr/bin/env python3
"""One-off backfill: fills PEP_CLS.ndr_lead_assignments.delivery_partner/ndr_reason/
payment_mode/brand for existing rows, read from each active NDR team's live Google Sheet (see
docs/superpowers/specs/2026-09-05-calling-overview-process-filter-design.md). Run once, after
scripts/migrate_ndr_lead_attributes.py --apply and after this repo's claim-time mirroring
(Tasks 2-3) has deployed - not a substitute for either.

Matched by awb_number, updating EVERY historical cycle for that AWB (these are lead-level
facts, not cycle-level - a lead's courier/reason/payment-mode/brand don't change across
reassignment cycles). An AWB no longer present in any active sheet is left NULL; there is
nowhere else to recover it from, and it will show as attribute-less in the Overview's
breakdown tables the same way any other "no data for this filter" row does.

COALESCE-free by construction: the UPDATE's WHERE clause requires delivery_partner IS NULL,
so a row a prior run (or the claim-time mirror) already populated is never touched again -
this is what makes it idempotent and safe to re-run against an updated sheet.

Dry-run by default; --apply performs the writes.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from mysql_lib import get_credential
from assign_ndr_leads import fetch_active_ndr_teams, SPREADSHEET_ID, SHEET_TAB, PRESENCE_SCHEMA, brand_of

COL_ORDER_ID = 0   # A
COL_COURIER = 5    # F - "Courier Company" / sheet header "Partner name"
COL_AWB = 4        # E
COL_PAYMENT_MODE = 11  # L
COL_LATEST_NDR_REASON = 16  # Q
LAST_COL = "Q"
UPDATE_CHUNK = 200


def build_attribute_map(rows):
    """rows: sheet rows (A2:Q shape, as returned by lib.get_sheet_values) -> {awb_number:
    (delivery_partner, ndr_reason, payment_mode, brand)}. First-seen-wins per AWB, same
    convention as every other sheet-backed backfill in this repo. A row with no AWB is
    skipped - there is nothing to key it by."""
    by_awb = {}
    for row in rows:
        awb = (row[COL_AWB] if len(row) > COL_AWB else "").strip()
        if not awb or awb in by_awb:
            continue
        courier = (row[COL_COURIER] if len(row) > COL_COURIER else "").strip() or None
        reason = (row[COL_LATEST_NDR_REASON] if len(row) > COL_LATEST_NDR_REASON else "").strip() or None
        payment_mode = (row[COL_PAYMENT_MODE] if len(row) > COL_PAYMENT_MODE else "").strip() or None
        order_id = row[COL_ORDER_ID] if len(row) > COL_ORDER_ID else ""
        brand = brand_of(order_id) if order_id else None
        by_awb[awb] = (courier, reason, payment_mode, brand)
    return by_awb


def _resolve_runs():
    teams = fetch_active_ndr_teams()
    if teams is None:
        raise SystemExit("Could not determine NDR's active teams (calling_teams query failed).")
    if not teams:
        return [{"id": None, "name": "NDR", "sheet_id": SPREADSHEET_ID, "sheet_tab": SHEET_TAB}]
    return teams


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the writes (default: dry run)")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql

    combined = {}
    for run in _resolve_runs():
        rows = lib.get_sheet_values(run["sheet_id"], f"'{run['sheet_tab']}'!A2:{LAST_COL}1000000")
        attrs = build_attribute_map(rows)
        print(f"[{run['name']}] {len(attrs)} AWB(s) with attributes in the live sheet.")
        combined.update(attrs)  # later teams overwrite earlier on an AWB collision - rare, harmless

    if not combined:
        print("Nothing found in any active sheet - nothing to do.")
        return 0

    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=PRESENCE_SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(
            f"SELECT COUNT(*) FROM ndr_lead_assignments WHERE delivery_partner IS NULL "
            f"AND awb_number IN ({','.join(['%s'] * len(combined))})",
            list(combined.keys()),
        ) if len(combined) <= 10000 else None  # skip the preview count on a huge batch
        matched = cur.fetchone()[0] if cur.rowcount != -1 and len(combined) <= 10000 else None
        if matched is not None:
            print(f"{matched} row(s) currently NULL will be updated.")

        if not args.apply:
            print("\nDRY RUN - re-run with --apply to write.")
            return 0

        rows_to_write = [
            (courier, reason, payment_mode, brand, awb)
            for awb, (courier, reason, payment_mode, brand) in combined.items()
        ]
        updated = 0
        for start in range(0, len(rows_to_write), UPDATE_CHUNK):
            chunk = rows_to_write[start:start + UPDATE_CHUNK]
            cur.executemany(
                "UPDATE ndr_lead_assignments SET delivery_partner = %s, ndr_reason = %s, "
                "payment_mode = %s, brand = %s WHERE awb_number = %s AND delivery_partner IS NULL",
                chunk,
            )
            conn.commit()
            updated += cur.rowcount
            print(f"  ...{start + len(chunk)}/{len(rows_to_write)} AWBs processed")
        print(f"\nDone. {updated} row(s) updated.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
