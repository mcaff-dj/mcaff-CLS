#!/usr/bin/env python3
"""Push hyphen-tab tickets - unique by Ticket Number - into the dashboard
spreadsheet's "Hyphen" tab (a separate spreadsheet, 41-column layout), mapped
per the agreed column mapping. Appends only; never clears.

Columns the dashboard computes itself via sheet formulas (SKU, Month, Week,
Total Sales M/W, etc.) are never written with literal data - instead, the
known formula template for each column is filled in and written directly to
the newly appended rows.

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

SOURCE_SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"
SOURCE_TAB = "hyphen"

DASHBOARD_SHEET_ID = "11RM238fAcqZxLKF1zzrUB0fPTQgDO2kwfkzcQSoYjBg"
DASHBOARD_TAB = "Hyphen"

# Destination column -> source ("hyphen" tab) column, for columns that are
# plain literal values in the dashboard (not sheet formulas).
# NOTE: "Delivery Partner Name" is intentionally NOT mapped (left blank),
# per explicit instruction - do not add it back without being asked.
FIELD_MAP = {
    "Ticket No": "Ticket Number",
    "Parent Order": "Order Name",
    "Last Source Type": "Source",
    "Query Class": "Disposition: Query Class",
    "Query Category": "Subcategory",
    "Product Name": "Disposition: Product Name",
    "Batch Number": "Disposition: Batch number",
    "AWB Number": "Disposition: AWB number",
    "WH Name": "Disposition: warehouse name",
    "Log_partner": "Disposition: partner_name",
    "EDD": "Disposition: Estimated_time_delivery_SR",
    "Age": "Objective: age_group",
    "gender": "Objective: gender",
    "Skin type": "Objective: skin_type",
    "First time/Regular": "Objective: first_time",
    "State_zone": "Objective: state_zone",
    "Reason of purchase": "Objective: reason_for_purchase",
    "am_pm": "Objective: am_pm",
    "usage_times": "Objective: usage_times",
    "sequence_of_usage": "Objective: sequence_of_usage",
    "platform": "Objective: platform_name",
}

# Subcategories that fall under the "Request and enquiry" bucket - these
# tickets are pure requests/enquiries, not delivery/order issues, so they're
# excluded from the dashboard rather than pushed. Kept duplicated from
# push_mcaffeine_to_dashboard.py per this file's own "self-contained" policy.
REQUEST_AND_ENQUIRY_SUBCATEGORIES = frozenset({
    "Enquiry about offers/coupons",
    "Refund enquiry",
    "Cancelation request",
    "Change in detail(Account/Order)",
    "Dissatisfied",
    "Estimated time of delivery",
    "General",
    "Product enquiry( price, how to, ingredients,effects)",
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


# Destination columns holding sheet formulas - see module docstring.
FORMULA_COLUMNS = [
    "SKU", "Month", "Week", "Order  Month", "Order Week", "Year", "Unique",
    "Order Year", "Total Sales M", "Total Sales W", "Pro Sales",
    "Partner Allocation", "WH Allocation",
]

# Formula templates, written directly into every newly appended row (see
# module docstring for why - copyPaste "drag down" doesn't work on this
# dashboard). "{r}" is replaced with the actual 1-based row number. Captured
# verbatim from the live dashboard sheet's own formulas.
#
# EXCEPTION: templates containing ARRAYFORMULA are never dragged row-by-row -
# see the ARRAYFORMULA branch below main() for why.
FORMULA_TEMPLATES = {
    "SKU": '=iferror(VLOOKUP(G{r},SKU!A:B,2,0))',
    "Month": '=IF(Q{r}="2026",TEXT(B{r},"M")&"_"&TEXT(B{r},"MMM\'YY"),TEXT(B{r},"MM")&"_"&TEXT(B{r},"MMM\'YY"))',
    "Week": "=iferror(VLOOKUP($B{r},'week-date'!$A:$C,3,0))",
    "Order  Month": '=IF(S{r}="2026",TEXT(L{r},"M")&"_"&TEXT(L{r},"MMM\'YY"),TEXT(L{r},"MM")&"_"&TEXT(L{r},"MMM\'YY"))',
    "Order Week": '=IFERROR(VLOOKUP($L{r},\'week-date\'!$A:$C,3,0),"")',
    "Year": '=TEXT(B{r},"YYYY")',
    "Unique": '=IF(COUNTIFS($C$2:C{r},C{r},$F$2:F{r},F{r})=1,"Unique","Duplicate")',
    "Order Year": '=TEXT(L{r},"YYYY")',
    "Total Sales M": "=ARRAYFORMULA(IFERROR(VLOOKUP(M{r}:M,'Sales per month'!A:B,2,0)))",
    "Total Sales W": "=ARRAYFORMULA(iferror(VLOOKUP(N{r}:N,'Sales per month'!A:B,2,0),0))",
    "Pro Sales": "=SUMIFS('Sales per month'!G:G,'Sales per month'!F:F,I{r},'Sales per month'!N:N,M{r})",
    "Partner Allocation": '=SUMIFS(\'Sales per month\'!T:T,\'Sales per month\'!Y:Y,K{r},\'Sales per month\'!Q:Q,"Hyphen",\'Sales per month\'!AA:AA,M{r})',
    "WH Allocation": '=SUMIFS(\'Sales per month\'!AI:AI,\'Sales per month\'!AH:AH,W{r},\'Sales per month\'!AN:AN,M{r},\'Sales per month\'!AE:AE,"Hyphen")',
}

# Destination date columns -> source column, reformatted so the dashboard's
# date cells store real date values (matching its existing serial-number
# cells) instead of unparsed text.
DATE_FIELDS = {
    "Created Date": "Created At",
    "Order Date": "Disposition: Order date",
}


def parse_flowcall_date(value):
    """Parses Flowcall's "D/M/YYYY, h:mm:ss am/pm" datetime strings (day
    first - values like "15/7" rule out month-first) plus a few other
    formats seen in Disposition: Order date, into "M/D/YYYY" so Sheets'
    USER_ENTERED input auto-recognizes it as a real date. Falls back to the
    raw string untouched if nothing matches."""
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


def main():
    src_last_row = lib.get_last_data_row(SOURCE_SHEET_ID, SOURCE_TAB)
    if src_last_row < 2:
        print("[dashboard] source hyphen tab has no data rows - nothing to push")
        return

    src_headers = lib.get_sheet_values(SOURCE_SHEET_ID, f"'{SOURCE_TAB}'!A1:ZZ1")[0]
    src_last_col = lib.get_column_letter(len(src_headers) - 1)
    src_rows = lib.get_sheet_rows_chunked(SOURCE_SHEET_ID, SOURCE_TAB, src_last_col, chunk_size=5000, start_row=2)
    print(f"[dashboard] source hyphen has {len(src_rows)} rows, {len(src_headers)} columns")

    src_idx = {name: i for i, name in enumerate(src_headers)}
    idx_ticket_src = src_idx.get("Ticket Number")
    if idx_ticket_src is None:
        raise RuntimeError("Source hyphen tab has no 'Ticket Number' column")

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

    new_rows = []
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

        dest_row = []
        for dest_header in dash_headers:
            if dest_header in FORMULA_COLUMNS:
                dest_row.append("")  # filled via copy/template below - never literal data
                continue
            if dest_header in DATE_FIELDS:
                src_field = DATE_FIELDS[dest_header]
                raw_val = src_row[src_idx[src_field]] if src_field in src_idx and src_idx[src_field] < len(src_row) else ""
                dest_row.append(parse_flowcall_date(raw_val))
                continue
            mapped = FIELD_MAP.get(dest_header)
            if mapped and mapped in src_idx and src_idx[mapped] < len(src_row):
                dest_row.append(src_row[src_idx[mapped]])
            else:
                dest_row.append("")  # no source column for this destination field
        new_rows.append(dest_row)

    print(f"[dashboard] {len(new_rows)} new unique tickets to push "
          f"({skipped_excluded} excluded as request/enquiry or awaiting-response)")
    if not new_rows:
        return

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


if __name__ == "__main__":
    main()
