"""Pushes today's resolved Delivery-class tickets from mcaff_dwh into the
Hyphen/mCaff tabs of the "Internal Escalation" sheet. Run every 2 hours via
GitHub Actions (see .github/workflows/sync-delivery-tickets.yml).

Only 11 of the tab's ~25 columns have a source in hyphen_tickets/mcaff_tickets
(Added date, Query Class, Query Category, Parent Order, AWB Number, Delivery
Partner Name, Order Date, Order Month, Query date, Query month, WH Name). The
rest (Delivered Date, Status as per AWB, Solv Date, TAT, City, State, etc.)
come from a separate logistics-tracking pipeline this job doesn't touch, so
they're left blank on job-inserted rows.

The sheet has no column holding ticket_number, so column Z is added purely as
an internal dedup key - each run reads it to skip tickets already pasted.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib

SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
TICKET_NUMBER_COL = "Z"  # one past the tab's existing 25 columns (A-Y)

TAB_TABLE = {
    "Hyphen": "hyphen_tickets",
    "mCaff": "mcaff_tickets",
}


def format_date(dt):
    if dt is None:
        return ""
    return f"{dt.strftime('%b')} {dt.day}, {dt.year}"


def format_month(dt):
    if dt is None:
        return ""
    return f"{dt.month}_{dt.strftime('%b')}'{dt.strftime('%y')}"


def ensure_ticket_number_header(tab):
    existing = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!{TICKET_NUMBER_COL}1")
    if existing and existing[0] and existing[0][0] == "Ticket Number":
        return
    lib.set_sheet_values_batch(SPREADSHEET_ID, [
        {"range": f"'{tab}'!{TICKET_NUMBER_COL}1", "values": [["Ticket Number"]]},
    ])
    print(f"  wrote 'Ticket Number' header at {tab}!{TICKET_NUMBER_COL}1")


def get_existing_ticket_numbers(tab):
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!{TICKET_NUMBER_COL}2:{TICKET_NUMBER_COL}")
    return {row[0] for row in values if row and row[0]}


def get_last_data_row(tab):
    # Column A ("Added date") is blank on every pre-existing row in these tabs,
    # so it can't anchor the last-row lookup the way lib.get_last_data_row
    # assumes - use column B ("Query Class"), populated on every real row.
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!B:B")
    return len(values) if values else 0


def fetch_today_delivery_tickets(table):
    sql = f"""
        SELECT ticket_number, subcategory, order_name, disposition_order,
               disposition_awb_number, disposition_partner_name,
               disposition_order_date, created_at, resolved_at,
               disposition_warehouse_name
        FROM {table}
        WHERE category LIKE %s AND DATE(resolved_at) = CURDATE()
              AND (subcategory IS NULL OR subcategory != 'Estimated time of delivery')
        ORDER BY resolved_at
    """
    rows = mysql_lib.query(sql, params=("%Delivery%",), database="mcaff_dwh")
    if rows is None:
        raise RuntimeError("MYSQL_* credentials not configured - cannot fetch tickets.")
    return rows


def build_sheet_row(row):
    (ticket_number, subcategory, order_name, disposition_order,
     awb, partner, order_date, created_at, resolved_at, warehouse) = row
    parent_order = order_name or disposition_order or ""
    row_out = [""] * 25
    row_out[0] = format_date(resolved_at)    # Added date
    row_out[1] = "Delivery"                  # Query Class
    row_out[2] = subcategory or ""           # Query Category
    row_out[3] = parent_order                # Parent Order
    row_out[4] = awb or ""                   # AWB Number
    row_out[5] = partner or ""               # Delivery Partner Name
    row_out[6] = format_date(order_date)     # Order Date
    row_out[7] = format_month(order_date)    # Order Month
    row_out[8] = format_date(created_at)     # Query date
    row_out[9] = format_month(created_at)    # Query month
    row_out[10] = warehouse or ""            # WH Name
    row_out.append(ticket_number)            # col 26: Ticket Number (dedup key)
    return row_out


def sync_tab(tab, dry_run):
    table = TAB_TABLE[tab]
    print(f"--- {tab} ({table}) ---")

    existing = get_existing_ticket_numbers(tab) if not dry_run else set()
    if not dry_run:
        print(f"  {len(existing)} ticket numbers already in sheet")

    db_rows = fetch_today_delivery_tickets(table)
    print(f"  {len(db_rows)} Delivery-class tickets resolved today in DB")

    new_rows = [build_sheet_row(r) for r in db_rows if r[0] not in existing]
    print(f"  {len(new_rows)} new rows to {'would append' if dry_run else 'append'}")

    if not new_rows:
        return

    if dry_run:
        for r in new_rows[:5]:
            print("   ", r)
        if len(new_rows) > 5:
            print(f"    ... and {len(new_rows) - 5} more")
        return

    ensure_ticket_number_header(tab)
    start_row = get_last_data_row(tab) + 1
    lib.set_sheet_rows_at_row(SPREADSHEET_ID, tab, new_rows, start_row)
    print(f"  wrote rows {start_row}-{start_row + len(new_rows) - 1}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", choices=sorted(TAB_TABLE), required=True)
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no sheet writes")
    args = parser.parse_args()
    sync_tab(args.tab, args.dry_run)


if __name__ == "__main__":
    main()
