"""Pushes today's resolved Delivery-class tickets from PEP_CLS into the
HYPHEN/mCaffeine tabs of the "Internal Escalation" sheet. Run every 2 hours via
GitHub Actions (see .github/workflows/sync-delivery-tickets.yml).

Only 11 of the tab's ~25 columns have a source in hyphen_tickets/mcaff_tickets
(Added date, Query Class, Query Category, Parent Order, AWB Number, Delivery
Partner Name, Order Date, Order Month, Query date, Query month, WH Name). The
rest (Delivered Date, Status as per AWB, Solv Date, TAT, City, State, etc.)
come from a separate logistics-tracking pipeline this job doesn't touch, so
they're left blank on job-inserted rows.

Any of the columns L:P the TAB ITSELF computes with a formula is dragged
down into the newly appended rows (see drag_formulas) - a pasted row that
leaves a formula column blank silently breaks every downstream pivot reading
it, and nobody notices until month-end.

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

# Columns to fill formulas down into: L (index 11) through P (index 15) - the
# only formula-driven span in these tabs. A:K hold job data (a formula there
# would be overwritten by the value write anyway); Q:S are pasted by the
# logistics pipeline, T:W are typed by the escalation desk (api/escalation),
# and Z is the internal dedup key - none of those are dragged.
FORMULA_FIRST_COL = 11
FORMULA_LAST_COL = 15

TAB_TABLE = {
    "HYPHEN": "hyphen_tickets",
    "mCaffeine": "mcaff_tickets",
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


EXISTING_TICKETS_CHUNK_SIZE = 5000  # see get_existing_ticket_numbers

# 300s, not lib.get_sheet_values' own 120s default - reads against this sheet started
# timing out at every size tried (bounded 32k-row, 5k-row chunks, even a bare 2-cell
# read), well past when the sheet was last this size and these same calls were fast. If
# that's the sheet having gotten genuinely heavier to serve (not throttling - a plain
# rate-limit would reject fast, not hang), a longer single-request budget is the correct
# response; it does nothing for actual throttling, which no client-side timeout can fix.
SHEET_READ_TIMEOUT_SEC = 300


def get_existing_ticket_numbers(tab):
    # Read in chunks, not one 'Z2:Z{last_row}' call - bounding the range (vs. the
    # original open-ended 'Z2:Z') fixed the timeout at 28-31k rows, but at 32k+ rows even
    # the BOUNDED single-request read started timing out (5/5 attempts, ~120s each) -
    # fetching this many cells of one column in one response is what's slow, not whether
    # the range has an end. Chunking sidesteps that regardless of which it actually is.
    last_row = get_last_data_row(tab)
    if last_row < 2:
        return set()
    existing = set()
    row = 2
    while row <= last_row:
        end = min(row + EXISTING_TICKETS_CHUNK_SIZE - 1, last_row)
        values = lib.get_sheet_values(
            SPREADSHEET_ID, f"'{tab}'!{TICKET_NUMBER_COL}{row}:{TICKET_NUMBER_COL}{end}",
            timeout_sec=SHEET_READ_TIMEOUT_SEC,
        )
        existing.update(r[0] for r in values if r and r[0])
        row = end + 1
    return existing


def get_last_data_row(tab):
    # The grid's own row COUNT (a metadata call, no cell data - same call
    # set_sheet_rows_at_row already uses in lib.py to decide whether to grow the grid
    # before writing), not a column read. Reliable here because every append grows the
    # grid to exactly match written rows, so grid size tracks last-data-row tightly.
    # An open-ended column read (e.g. the previous 'B:B' - column A ("Added date") is
    # blank on every pre-existing row, so B ("Query Class") was used as the real anchor)
    # started timing out once this tab passed ~30k rows: Sheets Value ranges API resolves
    # an unbounded column against the full grid extent, which is the expensive part, not
    # the actual data. A metadata call stays cheap regardless of row count.
    _, grid_props = lib._get_sheet_gid_and_grid(SPREADSHEET_ID, tab)
    return grid_props.get("rowCount", 0)


def fetch_today_delivery_tickets(table, since=None):
    """since: optional 'YYYY-MM-DD' to backfill everything resolved from that date through
    today (inclusive), for catching up after a run failed partway and missed a day - normal
    runs omit it and only pick up tickets resolved today."""
    date_filter = "DATE(resolved_at) BETWEEN %s AND CURDATE()" if since else "DATE(resolved_at) = CURDATE()"
    params = ("%Delivery%", since) if since else ("%Delivery%",)
    sql = f"""
        SELECT ticket_number, subcategory, order_name, disposition_order,
               disposition_awb_number, disposition_partner_name,
               disposition_order_date, created_at, resolved_at,
               disposition_warehouse_name
        FROM {table}
        WHERE category LIKE %s AND {date_filter}
              AND (subcategory IS NULL OR subcategory != 'Estimated time of delivery')
        ORDER BY resolved_at
    """
    rows = mysql_lib.query(sql, params=params, database="PEP_CLS")
    if rows is None:
        raise RuntimeError("MYSQL_* credentials not configured - cannot fetch tickets.")
    return rows


MCAFF_ORDER_PREFIX = "MCaff"


def _awb_lookup_key(parent_order):
    """Item_level_data.Display_Order_Code drops the 'MCaff' brand prefix for
    mCaffeine orders - MCaff9097914 is stored there as plain 9097914 - while
    HYPHEN/Fien orders keep their prefix as-is. Strip it here, at the query
    boundary, so callers/output still key off the ticket's own parent_order."""
    if parent_order.startswith(MCAFF_ORDER_PREFIX):
        return parent_order[len(MCAFF_ORDER_PREFIX):]
    return parent_order


def fetch_awb_by_order(parent_orders):
    """Display_Order_Code -> Tracking_Number, for orders whose ticket-level AWB is blank.
    Item_level_data has one row per order item/sync channel, so an order can map to more
    than one Tracking_Number (split shipments, re-syncs) - ORDER BY Created DESC plus
    "first row seen per order wins" below picks the latest one."""
    if not parent_orders:
        return {}
    key_by_order = {order: _awb_lookup_key(order) for order in parent_orders}
    lookup_keys = sorted(set(key_by_order.values()))
    placeholders = ",".join(["%s"] * len(lookup_keys))
    rows = mysql_lib.query(
        f"SELECT Display_Order_Code, Tracking_Number FROM Item_level_data "
        f"WHERE Display_Order_Code IN ({placeholders}) AND Tracking_Number IS NOT NULL AND Tracking_Number != '' "
        f"ORDER BY Created DESC",
        tuple(lookup_keys), database="mcaff_prod",
    )
    awb_by_key = {}
    for order_code, tracking in (rows or []):
        awb_by_key.setdefault(order_code, tracking)
    return {order: awb_by_key[key] for order, key in key_by_order.items() if key in awb_by_key}


def fill_missing_awb(rows):
    missing_orders = sorted({r[3] for r in rows if not r[4] and r[3]})
    if not missing_orders:
        return
    awb_by_order = fetch_awb_by_order(missing_orders)
    filled = 0
    for r in rows:
        if not r[4] and r[3] in awb_by_order:
            r[4] = awb_by_order[r[3]]
            filled += 1
    if filled:
        print(f"  filled AWB from Item_level_data for {filled} row(s)")


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


def pick_formula_sources(block, first_col=FORMULA_FIRST_COL, first_row=2):
    """col_index -> 1-based row number to drag that column's formula from.

    block is a FORMULA-rendered value range starting at (first_row, first_col).
    Per column it keeps the LAST row holding a formula, which is why the row
    directly above the new block can't just be assumed to be the source: every
    row this job inserted itself leaves L:P blank, so after the first run the
    preceding rows are blank and the real formula lives further up.

    ARRAYFORMULA cells are skipped, not used as a source: one anchored above
    already spans the rows below it, so dragging a copy in would collide with
    its own output (same reason push_hyphen_to_dashboard.py exempts them)."""
    sources = {}
    for i, row in enumerate(block):
        for j, cell in enumerate(row):
            if not isinstance(cell, str) or not cell.startswith("="):
                continue
            if "ARRAYFORMULA" in cell.upper():
                continue
            sources[first_col + j] = first_row + i
    return sources


def drag_formulas(tab, start_row, end_row, dry_run=False):
    """Fills every formula column in L:P down into rows start_row..end_row,
    the way dragging the fill handle would - Sheets' own copyPaste adjusts the
    relative references, so no formula text is parsed or rewritten here.

    Never fatal: the rows are already written and already deduped by column Z,
    so a failure here would otherwise abandon them with blank formula columns
    and no retry on the next run. It prints the range to drag by hand instead.
    The known failure is a Basic Filter on the tab - Sheets rejects any
    copyPaste touching a filtered-out row (see push_hyphen_to_dashboard.py's
    docstring); if that's what the logged body says, switch this tab to
    explicit formula templates like those scripts did."""
    if start_row <= 2:
        return  # nothing above the new rows to copy from
    first = lib.get_column_letter(FORMULA_FIRST_COL)
    last = lib.get_column_letter(FORMULA_LAST_COL)
    block = lib.get_sheet_values(
        SPREADSHEET_ID, f"'{tab}'!{first}{2}:{last}{start_row - 1}",
        value_render_option="FORMULA",
    )
    sources = pick_formula_sources(block)
    if not sources:
        print(f"  no formula columns found in {first}:{last} - nothing to drag")
        return
    cols = ", ".join(f"{lib.get_column_letter(c)}<-row {r}" for c, r in sorted(sources.items()))
    if dry_run:
        print(f"  would drag formulas into rows {start_row}-{end_row}: {cols}")
        return
    try:
        gid = lib.get_sheet_gid(SPREADSHEET_ID, tab)
        for col, src_row in sorted(sources.items()):
            lib.copy_paste_column(SPREADSHEET_ID, gid, src_row, start_row, end_row, col)
        print(f"  dragged formulas into rows {start_row}-{end_row}: {cols}")
    except Exception as e:
        print(f"  WARNING: formula drag failed for rows {start_row}-{end_row} ({cols}): {e}")
        print(f"  ACTION NEEDED: drag {first}:{last} down over rows {start_row}-{end_row} of '{tab}' by hand")


def sync_tab(tab, dry_run, since=None):
    table = TAB_TABLE[tab]
    print(f"--- {tab} ({table}) ---")

    existing = get_existing_ticket_numbers(tab) if not dry_run else set()
    if not dry_run:
        print(f"  {len(existing)} ticket numbers already in sheet")
    elif since:
        # dry-run + since still needs the existing set to report an accurate "new rows" count
        existing = get_existing_ticket_numbers(tab)

    db_rows = fetch_today_delivery_tickets(table, since=since)
    print(f"  {len(db_rows)} Delivery-class tickets resolved {'since ' + since if since else 'today'} in DB")

    new_rows = [build_sheet_row(r) for r in db_rows if r[0] not in existing]
    print(f"  {len(new_rows)} new rows to {'would append' if dry_run else 'append'}")

    if not new_rows:
        return

    fill_missing_awb(new_rows)

    if dry_run:
        for r in new_rows[:5]:
            print("   ", r)
        if len(new_rows) > 5:
            print(f"    ... and {len(new_rows) - 5} more")
        start_row = get_last_data_row(tab) + 1
        drag_formulas(tab, start_row, start_row + len(new_rows) - 1, dry_run=True)
        return

    ensure_ticket_number_header(tab)
    start_row = get_last_data_row(tab) + 1
    lib.set_sheet_rows_at_row(SPREADSHEET_ID, tab, new_rows, start_row)
    print(f"  wrote rows {start_row}-{start_row + len(new_rows) - 1}")
    # After the value write, never before: the write blanks L:P on these rows.
    drag_formulas(tab, start_row, start_row + len(new_rows) - 1)


def self_check():
    """Offline check of the formula-source pick - no sheet, no DB."""
    # P (index 15) formula on row 2, then two job-inserted rows leaving L:P blank:
    # the source must stay row 2, not the blank row directly above the new block.
    block = [
        ["", "", "", "", "=O2-I2", ""],
        [], [],
    ]
    assert pick_formula_sources(block) == {15: 2}, pick_formula_sources(block)
    # Last formula row per column wins, and ARRAYFORMULA cells are never sources.
    block = [["=A2", "=ARRAYFORMULA(B2:B)"], ["=A3", "=ARRAYFORMULA(B3:B)"]]
    assert pick_formula_sources(block) == {11: 3}, pick_formula_sources(block)
    # Literal values are not formulas.
    assert pick_formula_sources([["RTO", "12"]]) == {}
    # MCaff-prefixed orders look up by their bare numeric ID; other brands keep their prefix.
    assert _awb_lookup_key("MCaff9097914") == "9097914"
    assert _awb_lookup_key("HYP37526450") == "HYP37526450"
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", choices=sorted(TAB_TABLE))
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no sheet writes")
    parser.add_argument("--since", help="YYYY-MM-DD: backfill tickets resolved from this date through today (default: today only)")
    parser.add_argument("--self-check", action="store_true", help="Run the offline formula-source check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if not args.tab:
        parser.error("--tab is required")
    sync_tab(args.tab, args.dry_run, args.since)


if __name__ == "__main__":
    main()
