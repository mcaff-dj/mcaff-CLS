"""Appends yesterday's day-wise Shopify order quantity, by SKU, from mcaff_prod's
Item_level_data into the Mcaff/Hyphen tabs of the "Shopify Sales" sheet. Run daily at
5am IST via GitHub Actions (see .github/workflows/sync-shopify-qty.yml).

Only 'Net items sold' has a source here (SUM(Quantity)). Gross sales/Discounts/
Returns/Net sales/Taxes/Total sales are money fields fed by a separate process and
are deliberately left blank on job-inserted rows, same reasoning as the AWB/logistics
columns left blank in sync_delivery_tickets_to_sheet.py.

Never overwrites or deletes existing rows - only appends past the sheet's current
last row, skipping any (Day, SKU) pair for this tab already present so a rerun for a
day already synced doesn't duplicate it.
"""
import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib

SPREADSHEET_ID = "19m-WGJm--xwd9-f9612aHIzI_-e9nKynRfbDEQmkP2M"
ITEM_LEVEL_SCHEMA = "mcaff_prod"

# Channel_Name values that count as this tab's "Shopify" traffic - Item_level_data
# carries several near-miss variants (SHOPIFY-2, Shopify_home, MCaf_Shopify.in, ...)
# that are deliberately excluded; only these are this tab's Shopify channel.
TAB_CHANNELS = {
    "Mcaff": ["SHOPIFY", "FIEN_SHOPIFY"],
    "Hyphen": ["HYP_SHOPIFY", "HYP_SHOPIFY_IN"],
}
TAB_VENDOR = {
    "Mcaff": "MCaffeine",
    "Hyphen": "HYPHEN",
}

DAY_COL = "E"
SKU_COL = "F"
DEDUP_CHUNK_SIZE = 5000


def yesterday_ist():
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5.5)
    return (now_ist - timedelta(days=1)).date()


def format_ddmmyyyy(d):
    return d.strftime("%d-%m-%Y")


def format_month_label(d):
    return f"{d.month:02d}_{d.strftime('%b')}'{d.strftime('%y')}"


def fetch_daywise_qty(channels, day):
    # Order_Date >= day AND < day+1, not DATE(Order_Date) = day - wrapping the column in a
    # function stops the query from using the index, and this table is ~50M rows (docs note
    # the same for gen_geo_insights: only a bare range predicate stays sargable here).
    placeholders = ",".join(["%s"] * len(channels))
    next_day = day + timedelta(days=1)
    rows = mysql_lib.query(
        f"""
        SELECT Item_SKU_Code, Item_Type_Name, SUM(Quantity)
        FROM Item_level_data
        WHERE Channel_Name IN ({placeholders}) AND Order_Date >= %s AND Order_Date < %s
        GROUP BY Item_SKU_Code, Item_Type_Name
        ORDER BY Item_SKU_Code
        """,
        tuple(channels) + (day.isoformat(), next_day.isoformat()),
        database=ITEM_LEVEL_SCHEMA,
    )
    if rows is None:
        raise RuntimeError("MYSQL_* credentials not configured - cannot fetch quantities.")
    return rows


def get_grid_row_count(tab):
    _, grid_props = lib._get_sheet_gid_and_grid(SPREADSHEET_ID, tab)
    return grid_props.get("rowCount", 0)


def scan_existing(tab):
    """({(Day, SKU) already in the sheet}, true last row holding data).

    Grid rowCount can NOT be trusted as "last data row": lib.ensure_grid_size pads
    every growth by +50 rows, so after the first append the grid always runs ahead
    of the actual data - anchoring the next append there leaves a permanent blank
    gap. The real last row is the last one seen with a non-blank Day+SKU while
    scanning for the dedup set below, so both are computed from the same scan."""
    grid_last = get_grid_row_count(tab)
    if grid_last < 2:
        return set(), 1
    existing = set()
    true_last = 1
    row = 2
    while row <= grid_last:
        end = min(row + DEDUP_CHUNK_SIZE - 1, grid_last)
        values = lib.get_sheet_values(
            SPREADSHEET_ID, f"'{tab}'!{DAY_COL}{row}:{SKU_COL}{end}",
        )
        for i, r in enumerate(values):
            if len(r) >= 2 and r[0] and r[1]:
                existing.add((r[0], r[1]))
                true_last = row + i
        row = end + 1
    return existing, true_last


def build_sheet_row(sku, item_type, qty, day, vendor):
    sku = sku or ""
    month_start = day.replace(day=1)
    return [
        item_type or "",             # Product title
        vendor,                     # Product vendor
        "",                          # Product type
        format_ddmmyyyy(month_start),  # Month
        format_ddmmyyyy(day),          # Day
        sku,                         # Product variant SKU
        int(qty or 0),               # Net items sold
        "", "", "", "", "", "",       # Gross sales, Discounts, Returns, Net sales, Taxes, Total sales
        format_month_label(day),     # Months
    ]


def sync_tab(tab, day, dry_run):
    vendor = TAB_VENDOR[tab]
    channels = TAB_CHANNELS[tab]
    print(f"--- {tab} ({','.join(channels)}) for {day.isoformat()} ---")

    db_rows = fetch_daywise_qty(channels, day)
    print(f"  {len(db_rows)} SKU row(s) from DB")

    existing, true_last_row = scan_existing(tab) if not dry_run else (set(), 1)
    day_str = format_ddmmyyyy(day)
    new_rows = [
        build_sheet_row(sku, item_type, qty, day, vendor)
        for sku, item_type, qty in db_rows
        if (day_str, sku or "") not in existing
    ]
    skipped = len(db_rows) - len(new_rows)
    if skipped:
        print(f"  {skipped} row(s) already in sheet for {day_str} - skipped")
    print(f"  {len(new_rows)} new row(s) to {'would append' if dry_run else 'append'}")

    if not new_rows:
        return

    if dry_run:
        for r in new_rows[:5]:
            print("   ", r)
        if len(new_rows) > 5:
            print(f"    ... and {len(new_rows) - 5} more")
        return

    start_row = true_last_row + 1
    lib.set_sheet_rows_at_row(SPREADSHEET_ID, tab, new_rows, start_row)
    print(f"  wrote rows {start_row}-{start_row + len(new_rows) - 1}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", choices=sorted(TAB_CHANNELS), required=True)
    parser.add_argument("--date", help="YYYY-MM-DD to sync (default: yesterday IST)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no sheet writes")
    args = parser.parse_args()
    day = datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else yesterday_ist()
    sync_tab(args.tab, day, args.dry_run)


if __name__ == "__main__":
    main()
