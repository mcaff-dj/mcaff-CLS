#!/usr/bin/env python3
"""One-off backfill: mirrors the FULL existing HYPHEN/mCaffeine sheet history into
PEP_CLS.Delivery_escalation's cron-mirror columns - not just the rows
sync_delivery_tickets_to_sheet.py appends going forward. Same column set that job writes
(brand/order_id/awb_code/delivery_partner/query_class/query_category/wh_name/ticket_number/
added_date/order_date/order_month/query_date/query_month) and the same upsert shape, just
sourced from the sheet itself instead of PEP_CLS hyphen_tickets/mcaff_tickets - this sheet
also carries rows that predate or fall outside that job's own source query. Does NOT touch
status_as_per_awb/tat (a separate logistics pipeline's columns) or the dispose-flow fields
(agent_email/assigned_at/disposed_at/outcome/agent_remarks) - out of scope here, same as the
cron mirror.

Two passes, not one read-and-upsert loop: first pulls each tab's full A:Z range into a CSV
under --out-dir - one read of a ~20k/13k-row tab is the slow, timeout-prone part (see
sync_delivery_tickets_to_sheet.py's SHEET_READ_TIMEOUT_SEC comment) - so it happens once and
is saved; a retry re-runs the DB side against the CSV instead of re-hitting Sheets. Second
pass reads the CSV back and upserts in batches.

Same dedup_key branch caveat as the cron mirror (see that script's own docstring): this
writes ticket_number, so a row lands on Delivery_escalation's generated dedup_key column's
ticket_number branch, not the awb_code branch disposeDeliveryEscalationTicket's inserts use -
the two won't merge into one row for the same ticket.

Dry-run by default (writes the CSV, prints what it would upsert, touches no DB rows);
--apply performs the upserts.
"""
import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib

SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
TABS = ["HYPHEN", "mCaffeine"]
LAST_COL = "Z"
UPSERT_BATCH_SIZE = 1000

CSV_HEADER = [
    "addedDate", "queryClass", "queryCategory", "parentOrder", "awbNumber",
    "deliveryPartnerName", "orderDate", "orderMonth", "queryDate", "queryMonth", "whName",
] + [f"col{i}" for i in range(11, 25)] + ["ticketNumber"]

DELIVERY_ESCALATION_UPSERT = """
    INSERT INTO Delivery_escalation
        (brand, order_id, awb_code, delivery_partner, query_class, query_category,
         wh_name, ticket_number, added_date, order_date, order_month, query_date, query_month)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON DUPLICATE KEY UPDATE
        order_id = VALUES(order_id), delivery_partner = VALUES(delivery_partner),
        query_class = VALUES(query_class), query_category = VALUES(query_category),
        wh_name = VALUES(wh_name), ticket_number = VALUES(ticket_number),
        added_date = VALUES(added_date), order_date = VALUES(order_date),
        order_month = VALUES(order_month), query_date = VALUES(query_date),
        query_month = VALUES(query_month)
"""


def parse_sheet_date(s):
    """Reverses sync_delivery_tickets_to_sheet.py's format_date ("Aug 18, 2026"). Returns
    None for blank/unparseable cells - some historical rows predate that format or were
    entered by hand (build_sheet_row's own comment notes Added Date is blank on real rows)."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, "%b %d, %Y").date()
    except ValueError:
        return None


def fetch_tab_to_csv(tab, out_dir):
    rows = lib.get_sheet_rows_chunked(SPREADSHEET_ID, tab, LAST_COL)
    path = out_dir / f"{tab}_sheet_export.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_HEADER)
        w.writerows(rows)
    print(f"  {tab}: {len(rows)} rows -> {path}")
    return path


def rows_from_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader, None)  # header
        return list(reader)


def build_row(cells, tab):
    """None for a row with no Parent Order - nothing to key an upsert on."""
    v = lambda i: cells[i] if i < len(cells) else ""
    order_id = v(3)
    if not order_id:
        return None
    return (
        tab, order_id, v(4) or None, v(5) or None, v(1) or None, v(2) or None,
        v(10) or None, v(25) or None,
        parse_sheet_date(v(0)), parse_sheet_date(v(6)), v(7) or None,
        parse_sheet_date(v(8)), v(9) or None,
    )


def backfill_tab(tab, csv_path, dry_run):
    cells_rows = rows_from_csv(csv_path)
    upsert_rows = [r for r in (build_row(c, tab) for c in cells_rows) if r]
    print(f"  {tab}: {len(upsert_rows)}/{len(cells_rows)} rows have a Parent Order to key on")
    if dry_run:
        for r in upsert_rows[:5]:
            print("   ", r)
        if len(upsert_rows) > 5:
            print(f"    ... and {len(upsert_rows) - 5} more")
        return
    for i in range(0, len(upsert_rows), UPSERT_BATCH_SIZE):
        batch = upsert_rows[i:i + UPSERT_BATCH_SIZE]
        mysql_lib.executemany(DELIVERY_ESCALATION_UPSERT, batch, database="PEP_CLS")
        print(f"  {tab}: upserted {min(i + UPSERT_BATCH_SIZE, len(upsert_rows))}/{len(upsert_rows)}")


def self_check():
    """Offline check of the sheet-cell -> upsert-row mapping - no sheet, no DB."""
    assert parse_sheet_date("Aug 18, 2026") == datetime(2026, 8, 18).date()
    assert parse_sheet_date("") is None
    assert parse_sheet_date("garbage") is None

    row = ["Aug 18, 2026", "Delivery", "Delayed Order", "HYP123", "AWB1", "Delhivery",
           "Aug 10, 2026", "8_Aug'26", "Aug 18, 2026", "8_Aug'26", "WH1"] + [""] * 14 + ["TCK1"]
    assert build_row(row, "HYPHEN") == (
        "HYPHEN", "HYP123", "AWB1", "Delhivery", "Delivery", "Delayed Order", "WH1", "TCK1",
        datetime(2026, 8, 18).date(), datetime(2026, 8, 10).date(), "8_Aug'26",
        datetime(2026, 8, 18).date(), "8_Aug'26",
    )
    assert build_row([], "HYPHEN") is None  # blank row, nothing to key on
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the upserts (default is a dry run).")
    ap.add_argument("--out-dir", default=".", help="Where to write the per-tab sheet-export CSVs.")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for tab in TABS:
        print(f"--- {tab} ---")
        csv_path = fetch_tab_to_csv(tab, out_dir)
        backfill_tab(tab, csv_path, dry_run=not args.apply)


if __name__ == "__main__":
    main()
