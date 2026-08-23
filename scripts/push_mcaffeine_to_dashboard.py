#!/usr/bin/env python3
"""Push mcaffeine-tab tickets - unique by Ticket Number - into the dashboard
spreadsheet's "mCaffeine" tab (a separate spreadsheet, 33-column layout),
mapped per the agreed column mapping. Appends only; never clears.

Same approach as push_hyphen_to_dashboard.py: columns the dashboard computes
itself via sheet formulas (SKU, Month, Week, Total Sales M/W, etc.) are
never written with literal data - instead, the known formula template for
each column is filled in and written directly to the newly appended rows.

NOTE: this used to "drag" the formula down via the Sheets API's copyPaste
request (copying the cell from the row above, letting Sheets auto-adjust
relative references like a fill handle). copyPaste turned out to be
incompatible with this dashboard: it has a live Basic Filter hiding some
"Query Category" values, and Sheets flatly rejects any copyPaste touching a
filtered-out row ("This operation is not supported on a range with a
filtered out row") - not a transient error, so retrying never helps. A
plain values write isn't affected by filters, so writing the templated
formula text directly sidesteps the problem entirely.
"""
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib

SOURCE_SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"
SOURCE_TAB = "mcaffeine"

# Query Classes whose missing AWB gets backfilled from the item-level DB before push.
AWB_LOOKUP_QUERY_CLASSES = ("Warehouse", "Delivery")

# "Order Name" for a live mCaffeine order is "MCaff" + Item_level_data.Display_Order_Code
# (e.g. "MCaff9119979" -> "9119979"). Combo/split-shipment suffix variants of the order
# code ("9119979_1") aren't matched here - genuinely unmapped cases are left blank rather
# than guessed at, per the "map for the cases you will find" instruction.
MCAFFEINE_ORDER_NAME_PATTERN = re.compile(r"^MCaff(\d+)$", re.IGNORECASE)


def extract_mcaffeine_order_code(order_name):
    m = MCAFFEINE_ORDER_NAME_PATTERN.match(str(order_name).strip())
    return m.group(1) if m else None


CREATED_AT_PATTERN = re.compile(
    r"^(\d{1,2})/(\d{1,2})/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)$", re.IGNORECASE
)


def parse_created_at(value):
    """Parses FlowCall's 'Created At' (DD/MM/YYYY, H:MM:SS AM/PM, Asia/Kolkata) into a
    naive datetime comparable against Item_level_data.Order_Date - both are IST wall-clock
    values with no timezone info, so no conversion is needed. Returns None on anything that
    doesn't match (missing/malformed value), and the AWB backfill below treats that as
    "can't bound the lookup" rather than guessing."""
    m = CREATED_AT_PATTERN.match(str(value).strip())
    if not m:
        return None
    day, month, year, hour, minute, second, ampm = m.groups()
    hour = int(hour) % 12
    if ampm.lower() == "pm":
        hour += 12
    try:
        return datetime(int(year), int(month), int(day), hour, int(minute), int(second))
    except ValueError:
        return None


def pick_awb_before_ticket_date(candidates, ticket_dt):
    """From [(order_date, tracking), ...] for one order code, returns the tracking number
    of the latest shipment that existed AT OR BEFORE the ticket was raised - a shipment
    dated after the ticket can't be the one the ticket is about. None if none qualify."""
    best = None
    for order_date, tracking in candidates:
        if order_date <= ticket_dt and (best is None or order_date > best[0]):
            best = (order_date, tracking)
    return best[1] if best else None


def fetch_awb_candidates(rows_to_push, src_idx):
    """Batched lookup of every (Order_Date, Tracking_Number) Item_level_data has for each
    order code a Warehouse/Delivery row with a blank AWB needs - one query for the whole
    batch rather than one per row. Returns {order_code: [(order_date, tracking), ...]};
    picking the one to actually use (bounded by that row's own ticket date) happens per-row
    in the caller via pick_awb_before_ticket_date, since two tickets can reference the same
    order code but be raised at different times."""
    idx_qclass = src_idx.get("Disposition: Query Class")
    idx_awb = src_idx.get("Disposition: AWB number")
    idx_order_name = src_idx.get("Order Name")
    if idx_qclass is None or idx_awb is None or idx_order_name is None:
        return {}

    order_codes = set()
    for row in rows_to_push:
        if idx_qclass >= len(row) or str(row[idx_qclass]).strip() not in AWB_LOOKUP_QUERY_CLASSES:
            continue
        if idx_awb < len(row) and str(row[idx_awb]).strip():
            continue  # AWB already present, nothing to backfill
        if idx_order_name >= len(row):
            continue
        code = extract_mcaffeine_order_code(row[idx_order_name])
        if code:
            order_codes.add(code)

    if not order_codes:
        return {}

    order_codes = sorted(order_codes)
    placeholders = ",".join(["%s"] * len(order_codes))
    rows = mysql_lib.query(
        f"SELECT Display_Order_Code, Tracking_Number, Order_Date FROM Item_level_data "
        f"WHERE Brand = 'mCaffeine' AND Tracking_Number IS NOT NULL AND Tracking_Number <> '' "
        f"AND Display_Order_Code IN ({placeholders})",
        tuple(order_codes), database="mcaff_prod",
    )
    if not rows:  # None (no DB creds) or empty result - nothing to backfill
        print(f"[dashboard] AWB lookup: {len(order_codes)} order(s) needed a backfill, "
              f"{'DB unavailable' if rows is None else 'no matching tracking numbers found'}")
        return {}

    candidates_by_code = {}
    for code, tracking, order_date in rows:
        candidates_by_code.setdefault(code, []).append((order_date, tracking))
    print(f"[dashboard] AWB lookup: {len(order_codes)} order(s) needed a backfill, "
          f"{len(candidates_by_code)} had at least one tracking number in the DB")
    return candidates_by_code


DASHBOARD_SHEET_ID = "1fjrwKgi26q3kxsLsFrXP0KY0uAJNfcpTeHBQhCXwkPA"
DASHBOARD_TAB = "mCaffeine"

# Subcategories that fall under the "Request and enquiry" bucket - these
# tickets are pure requests/enquiries, not delivery/order issues, so they're
# excluded from the dashboard rather than pushed.
# NOTE: "Enquiry about offers/coupons", "Refund enquiry", and "Product
# enquiry( price, how to, ingredients,effects)" are NOT here even though they
# started in this bucket - "Update_tickets - Pivot Table 1.csv" gives them a
# real business Query Class (Product / Packaging and Operational / Product
# or Technical), so they're pushed to the dashboard like any classified
# ticket instead of being excluded.
REQUEST_AND_ENQUIRY_SUBCATEGORIES = frozenset({
    "Cancelation request",
    "Change in detail(Account/Order)",
    "Dissatisfied",
    "Estimated time of delivery",
    "General",
    "Unsubscription",
    "Appreciation",
    "Return Requested",
})

# Query Classes excluded from the dashboard outright - "Awaiting Response"
# tickets aren't resolved yet, so they don't belong in the dashboard.
EXCLUDED_QUERY_CLASSES = frozenset({"Awaiting Response"})


def is_excluded_from_dashboard(subcategory, query_class):
    """True if the ticket is a pure request/enquiry (by Subcategory) or still
    Awaiting Response (by Query Class) - either way it's skipped, never pushed."""
    return (str(subcategory).strip() in REQUEST_AND_ENQUIRY_SUBCATEGORIES
            or str(query_class).strip() in EXCLUDED_QUERY_CLASSES)

# Destination column -> source ("mcaffeine" tab) column, for columns that are
# plain literal values in the dashboard (not sheet formulas).
# NOTE: "Delivery Partner Name" is intentionally NOT mapped (left blank),
# mirroring the hyphen mapping - it's array-formula-driven off Log_partner
# anyway, so leaving it out of literal writes is correct either way.
# NOTE: header has trailing spaces on "Unique " and "platform " - matched
# exactly as they appear in the live sheet.
FIELD_MAP = {
    "Parent Order": "Order Name",
    "Last Source Type": "Source",
    "Ticket No": "Ticket Number",
    "Query Class": "Disposition: Query Class",
    "Query Category": "Subcategory",
    "Product Name": "Disposition: Product Name",
    "Batch Number": "Disposition: Batch number",
    "AWB Number": "Disposition: AWB number",
    "WH Name": "Disposition: warehouse name",
    "Log_partner": "Disposition: partner_name",
    "EDD": "Disposition: Estimated_time_delivery_SR",  # always blank in source - mcaffeine's real field has no _SR suffix
    "State_zone": "Objective: state_zone",
    "platform ": "Objective: platform_name",
}

# Destination columns holding sheet formulas. This dashboard's formula
# coverage is less consistent than the Hyphen one (some blank even at the
# anchor row) - treated as formula columns anyway so we never risk writing
# literal data over a formula; "drag from the row above" adapts to whatever
# is actually there (formula or blank) without needing to know which.
FORMULA_COLUMNS = [
    "SKU", "Month", "Week", "Order  Month", "Order Week", "Year", "Unique ",
    "Order Year", "Total Sales M", "Total Sales W", "Pro Sales",
    "Partner Allocation", "WH Allocation",
]

# Formula templates, written directly into every newly appended row (see
# module docstring for why - copyPaste "drag down" doesn't work on this
# dashboard). "{r}" is replaced with the actual 1-based row number. Captured
# verbatim from the live dashboard sheet's own formulas. Columns not listed
# here (Month, Order Year) showed no formula even at row 2 in this sheet -
# left blank rather than guessed at.
#
# EXCEPTION: templates containing ARRAYFORMULA are never dragged row-by-row -
# see the ARRAYFORMULA branch below main() for why.
FORMULA_TEMPLATES = {
    "SKU": '=iferror(VLOOKUP(G{r},SKU!M:N,2,0))',
    "Week": "=VLOOKUP($A{r},'week-date'!$A:$C,3,0)",
    "Order  Month": '=IF(S{r}="2026",TEXT(L{r},"M")&"_"&TEXT(L{r},"MMM\'YY"),TEXT(L{r},"MM")&"_"&TEXT(L{r},"MMM\'YY"))',
    "Order Week": '=IFERROR(ARRAYFORMULA(VLOOKUP($L{r}:L,\'week-date\'!$A:$C,3,0),""))',
    "Year": '=TEXT(A{r},"YYYY")',
    "Unique ": '=IF(COUNTIFS($B$2:B{r},B{r},$F$2:F{r},F{r})=1,"Unique","Duplicate")',
    "Total Sales M": "=ARRAYFORMULA(IFERROR(VLOOKUP(M{r}:M,'Sales per month'!A:B,2,0)))",
    "Total Sales W": "=ARRAYFORMULA(iferror(VLOOKUP(N{r}:N,'Sales per month'!A:B,2,0),0))",
    "Pro Sales": "=SUMIFS('Sales per month'!F:F,'Sales per month'!E:E,I{r},'Sales per month'!D:D,M{r})",
    "Partner Allocation": '=SUMIFS(\'Sales per month\'!R:R,\'Sales per month\'!W:W,K{r},\'Sales per month\'!O:O,"Mcaffeine",\'Sales per month\'!X:X,M{r})',
    "WH Allocation": '=SUMIFS(\'Sales per month\'!AD:AD,\'Sales per month\'!AC:AC,V{r},\'Sales per month\'!AI:AI,M{r},\'Sales per month\'!Z:Z,"Mcaffeine")',
}

# Destination date columns -> source column, reformatted so the dashboard's
# date cells store real date values instead of unparsed text.
DATE_FIELDS = {
    "Created Date": "Created At",
    "Order Date": "Disposition: Order date",
}


def parse_flowcall_date(value):
    """See push_hyphen_to_dashboard.py for the format rationale - identical
    parsing logic, kept duplicated here rather than shared to keep each
    push script self-contained and independently runnable."""
    if not value:
        return ""
    s = str(value).strip()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)$", s, re.IGNORECASE)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return datetime(year, month, day).strftime("%m/%d/%Y")
        except ValueError:
            return s
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%m/%d/%Y")
        except ValueError:
            continue
    return s


def fetch_source_rows():
    """Default row source: the live FlowCall-mirrored 'mcaffeine' tab. A caller
    with rows from elsewhere (e.g. a one-off xlsx import) can skip this and
    call push_rows_to_dashboard(headers, rows) directly - same mapping/dedup/
    formula logic either way."""
    src_last_row = lib.get_last_data_row(SOURCE_SHEET_ID, SOURCE_TAB)
    if src_last_row < 2:
        print("[dashboard] source mcaffeine tab has no data rows - nothing to push")
        return None, None

    src_headers = lib.get_sheet_values(SOURCE_SHEET_ID, f"'{SOURCE_TAB}'!A1:ZZ1")[0]
    src_last_col = lib.get_column_letter(len(src_headers) - 1)
    src_rows = lib.get_sheet_rows_chunked(SOURCE_SHEET_ID, SOURCE_TAB, src_last_col, chunk_size=5000, start_row=2)
    print(f"[dashboard] source mcaffeine has {len(src_rows)} rows, {len(src_headers)} columns")
    return src_headers, src_rows


def push_rows_to_dashboard(src_headers, src_rows):
    src_idx = {name: i for i, name in enumerate(src_headers)}
    idx_ticket_src = src_idx.get("Ticket Number")
    if idx_ticket_src is None:
        raise RuntimeError("Source mcaffeine tab has no 'Ticket Number' column")

    dash_headers = lib.get_sheet_values(DASHBOARD_SHEET_ID, f"'{DASHBOARD_TAB}'!A1:ZZ1")[0]
    idx_ticket_dash = dash_headers.index("Ticket No") if "Ticket No" in dash_headers else -1
    if idx_ticket_dash < 0:
        raise RuntimeError("Dashboard tab has no 'Ticket No' column")

    dash_last_row = lib.get_last_data_row(DASHBOARD_SHEET_ID, DASHBOARD_TAB)

    existing_ids = set()
    if dash_last_row >= 2:
        col_letter = lib.get_column_letter(idx_ticket_dash)
        existing_vals = lib.get_sheet_values(DASHBOARD_SHEET_ID, f"'{DASHBOARD_TAB}'!{col_letter}2:{col_letter}")
        for r in existing_vals:
            if r and r[0]:
                existing_ids.add(str(r[0]))
    print(f"[dashboard] {len(existing_ids)} existing Ticket No values in dashboard")

    idx_subcategory_src = src_idx.get("Subcategory")
    idx_qclass_filter_src = src_idx.get("Disposition: Query Class")

    rows_to_push = []
    seen_this_batch = set()
    skipped_excluded = 0
    for src_row in src_rows:
        if idx_ticket_src >= len(src_row):
            continue
        ticket_id = str(src_row[idx_ticket_src])
        if not ticket_id or ticket_id in existing_ids or ticket_id in seen_this_batch:
            continue
        subcategory = src_row[idx_subcategory_src] if idx_subcategory_src is not None and idx_subcategory_src < len(src_row) else ""
        query_class = src_row[idx_qclass_filter_src] if idx_qclass_filter_src is not None and idx_qclass_filter_src < len(src_row) else ""
        if is_excluded_from_dashboard(subcategory, query_class):
            skipped_excluded += 1
            continue
        seen_this_batch.add(ticket_id)
        rows_to_push.append(src_row)

    print(f"[dashboard] {len(rows_to_push)} new unique tickets to push "
          f"({skipped_excluded} excluded as request/enquiry or awaiting-response)")
    if not rows_to_push:
        return 0

    awb_candidates_by_code = fetch_awb_candidates(rows_to_push, src_idx)
    idx_qclass_src = src_idx.get("Disposition: Query Class")
    idx_created_at_src = src_idx.get("Created At")
    awb_backfilled = 0

    new_rows = []
    for src_row in rows_to_push:
        dest_row = []
        for dest_header in dash_headers:
            if dest_header in FORMULA_COLUMNS:
                dest_row.append("")  # filled via copy below - never literal data
                continue
            if dest_header in DATE_FIELDS:
                src_field = DATE_FIELDS[dest_header]
                raw_val = src_row[src_idx[src_field]] if src_field in src_idx and src_idx[src_field] < len(src_row) else ""
                dest_row.append(parse_flowcall_date(raw_val))
                continue
            mapped = FIELD_MAP.get(dest_header)
            value = src_row[src_idx[mapped]] if mapped and mapped in src_idx and src_idx[mapped] < len(src_row) else ""
            if (dest_header == "AWB Number" and not str(value).strip() and awb_candidates_by_code
                    and idx_qclass_src is not None and idx_qclass_src < len(src_row)
                    and str(src_row[idx_qclass_src]).strip() in AWB_LOOKUP_QUERY_CLASSES):
                order_code = extract_mcaffeine_order_code(src_row[src_idx["Order Name"]]) if "Order Name" in src_idx else None
                ticket_dt = (parse_created_at(src_row[idx_created_at_src])
                             if idx_created_at_src is not None and idx_created_at_src < len(src_row) else None)
                if order_code and ticket_dt and order_code in awb_candidates_by_code:
                    found = pick_awb_before_ticket_date(awb_candidates_by_code[order_code], ticket_dt)
                    if found:
                        value = found
                        awb_backfilled += 1
            dest_row.append(value)
        new_rows.append(dest_row)
    if awb_candidates_by_code:
        print(f"[dashboard] backfilled AWB for {awb_backfilled} row(s) from item-level DB "
              f"(latest shipment at or before the ticket's Created At)")

    start_row = dash_last_row + 1 if dash_last_row >= 1 else 2
    lib.set_sheet_rows_at_row(DASHBOARD_SHEET_ID, DASHBOARD_TAB, new_rows, start_row)
    dest_row_end = start_row + len(new_rows) - 1
    print(f"[dashboard] appended {len(new_rows)} rows at row {start_row}")

    for col_name in FORMULA_COLUMNS:
        if col_name not in dash_headers:
            continue
        template = FORMULA_TEMPLATES.get(col_name)
        if not template:
            continue
        col_index = dash_headers.index(col_name)
        col_letter = lib.get_column_letter(col_index)
        if "ARRAYFORMULA" in template.upper():
            # An ARRAYFORMULA cell already governs the whole column from its
            # anchor row downward (an open range like M2:M auto-expands to
            # cover every row below it) - writing another copy into each new
            # row overlaps that same range and Sheets rejects it with #REF!
            # ("Array result was not expanded because it would overwrite
            # data in ..."), which is what broke the "Refresh reports" run
            # on 2026-07-23. Only seed it once, and only on a brand-new tab
            # that has no existing anchor row to rely on.
            if dash_last_row < 2:
                formula = template.replace("{r}", str(start_row))
                lib.set_sheet_values_batch(DASHBOARD_SHEET_ID, [{
                    "range": f"'{DASHBOARD_TAB}'!{col_letter}{start_row}",
                    "values": [[formula]],
                }])
            continue
        formulas = [[template.replace("{r}", str(start_row + i))] for i in range(len(new_rows))]
        lib.set_sheet_values_batch(DASHBOARD_SHEET_ID, [{
            "range": f"'{DASHBOARD_TAB}'!{col_letter}{start_row}:{col_letter}{dest_row_end}",
            "values": formulas,
        }])
    print(f"[dashboard] wrote templated formulas for {len(FORMULA_COLUMNS)} columns, rows {start_row}-{dest_row_end}")
    return len(new_rows)


def main():
    src_headers, src_rows = fetch_source_rows()
    if src_headers is None:
        return
    push_rows_to_dashboard(src_headers, src_rows)


if __name__ == "__main__":
    main()
