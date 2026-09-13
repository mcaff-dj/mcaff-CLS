"""Syncs day-wise Shopify order quantity, by SKU, from mcaff_prod's Item_level_data
into the Mcaff/Hyphen tabs of the "Shopify Sales" sheet. Run daily at 5am IST via
GitHub Actions (see .github/workflows/sync-shopify-qty.yml).

Only 'Net items sold' has a source here (SUM(Quantity)). Gross sales/Discounts/
Returns/Net sales/Taxes/Total sales are money fields fed by a separate process and
are deliberately left blank on job-inserted rows, same reasoning as the AWB/logistics
columns left blank in sync_delivery_tickets_to_sheet.py.

Item_level_data's Time_Stamp (DWH ingestion time) lags Order_Date by up to ~12 days
(seen directly on 2026-09 data) - most of a day's orders aren't in the warehouse yet
at the 5am sync. So every run re-checks RESYNC_WINDOW_DAYS of trailing days, not just
"yesterday": a (Day, SKU) already in the sheet gets its qty cell corrected in place if
the DB total for it has changed, instead of being left frozen at whatever partial
count existed the first time. A (Day, SKU) not yet in the sheet is appended, same as
before. Only the qty cell is ever touched on an existing row - the money columns
another process fills in later are never overwritten. --date still syncs one exact
day only (no window), for manual backfills of dates older than the window.
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
QTY_COL = "G"
DEDUP_CHUNK_SIZE = 5000
UPDATE_CHUNK_SIZE = 300
RESYNC_WINDOW_DAYS = 14


def yesterday_ist():
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5.5)
    return (now_ist - timedelta(days=1)).date()


def format_ddmmyyyy(d):
    return d.strftime("%d-%m-%Y")


def format_month_label(d):
    # No zero-pad on month, matching sync_delivery_tickets_to_sheet.py's format_month() and
    # the real 2026 sheet convention (brands.py: 2025 months are zero-padded, 2026 are not).
    return f"{d.month}_{d.strftime('%b')}'{d.strftime('%y')}"


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
    """({(Day, SKU): (row, current_qty)} for the whole tab, true last row holding data).

    Grid rowCount can NOT be trusted as "last data row": lib.ensure_grid_size pads
    every growth by +50 rows, so after the first append the grid always runs ahead
    of the actual data - anchoring the next append there leaves a permanent blank
    gap. The real last row is the last one seen with a non-blank Day+SKU while
    scanning for the lookup map below, so both are computed from the same scan."""
    grid_last = get_grid_row_count(tab)
    if grid_last < 2:
        return {}, 1
    existing = {}
    true_last = 1
    row = 2
    while row <= grid_last:
        end = min(row + DEDUP_CHUNK_SIZE - 1, grid_last)
        values = lib.get_sheet_values(
            SPREADSHEET_ID, f"'{tab}'!{DAY_COL}{row}:{QTY_COL}{end}",
        )
        for i, r in enumerate(values):
            if len(r) >= 2 and r[0] and r[1]:
                qty = int(r[2]) if len(r) >= 3 and r[2] not in ("", None) else 0
                existing[(r[0], r[1])] = (row + i, qty)
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


def plan_day(db_rows, day, vendor, existing):
    """Pure split of one day's DB rows into (new_rows_to_append, updates_to_correct),
    given the sheet's existing {(Day, SKU): (row, qty)} map. No network - kept separate
    from sync_window so self_check can exercise it offline."""
    day_str = format_ddmmyyyy(day)
    new_rows = []
    updates = []
    for sku, item_type, qty in db_rows:
        qty = int(qty or 0)
        key = (day_str, sku or "")
        if key in existing:
            row, old_qty = existing[key]
            if qty != old_qty:
                updates.append((row, qty))
        else:
            new_rows.append(build_sheet_row(sku, item_type, qty, day, vendor))
    return new_rows, updates


def sync_window(tab, days, dry_run):
    vendor = TAB_VENDOR[tab]
    channels = TAB_CHANNELS[tab]
    print(f"--- {tab} ({','.join(channels)}): {days[0].isoformat()} to {days[-1].isoformat()} ---")

    existing, true_last_row = scan_existing(tab)  # read-only, safe under --dry-run too -
                                                   # needed so the preview shows corrections,
                                                   # not just "new" for every row

    all_new_rows = []
    all_updates = []
    for day in days:
        db_rows = fetch_daywise_qty(channels, day)
        new_rows, updates = plan_day(db_rows, day, vendor, existing)
        all_new_rows.extend(new_rows)
        all_updates.extend(updates)
        print(f"  {day.isoformat()}: {len(db_rows)} SKU row(s) from DB, "
              f"{len(new_rows)} new, {len(updates)} to correct")

    if dry_run:
        for r in all_new_rows[:5]:
            print("    new:", r)
        if len(all_new_rows) > 5:
            print(f"    ... and {len(all_new_rows) - 5} more new row(s)")
        for row, qty in all_updates[:5]:
            print(f"    correct row {row}: qty -> {qty}")
        if len(all_updates) > 5:
            print(f"    ... and {len(all_updates) - 5} more correction(s)")
        return

    if all_updates:
        for start in range(0, len(all_updates), UPDATE_CHUNK_SIZE):
            chunk = all_updates[start:start + UPDATE_CHUNK_SIZE]
            lib.set_sheet_values_batch(SPREADSHEET_ID, [
                {"range": f"'{tab}'!{QTY_COL}{row}", "values": [[qty]]}
                for row, qty in chunk
            ])
        print(f"  corrected {len(all_updates)} row(s)")

    if all_new_rows:
        start_row = true_last_row + 1
        lib.set_sheet_rows_at_row(SPREADSHEET_ID, tab, all_new_rows, start_row)
        print(f"  wrote rows {start_row}-{start_row + len(all_new_rows) - 1}")


def self_check():
    """Offline check of the day-split logic - no DB, no sheet."""
    day = datetime(2026, 9, 1).date()
    day_str = format_ddmmyyyy(day)
    db_rows = [
        ("SKU1", "Type A", 500),   # already in sheet, qty grew -> correct in place
        ("SKU2", "Type B", 10),    # already in sheet, unchanged -> left alone
        ("SKU3", "Type C", 3),     # not in sheet yet -> appended
    ]
    existing = {
        (day_str, "SKU1"): (100, 50),
        (day_str, "SKU2"): (101, 10),
    }
    new_rows, updates = plan_day(db_rows, day, "MCaffeine", existing)
    assert updates == [(100, 500)]
    assert len(new_rows) == 1
    assert new_rows[0][5] == "SKU3" and new_rows[0][6] == 3
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", choices=sorted(TAB_CHANNELS), required=True)
    parser.add_argument("--date", help="YYYY-MM-DD to sync exactly this one day, no resync window "
                                        "(default: trailing %d days ending yesterday IST)" % RESYNC_WINDOW_DAYS)
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no sheet writes")
    parser.add_argument("--self-check", action="store_true", help="Run the offline day-split check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if args.date:
        days = [datetime.strptime(args.date, "%Y-%m-%d").date()]
    else:
        end = yesterday_ist()
        days = [end - timedelta(days=i) for i in range(RESYNC_WINDOW_DAYS - 1, -1, -1)]
    sync_window(args.tab, days, args.dry_run)


if __name__ == "__main__":
    main()
