#!/usr/bin/env python3
"""One-off: fetch a specific historical window of resolved tickets, apply the
same 3 cleanup rules as cleanup_ticket_sheet.py, map columns onto whatever
header the target tab ALREADY has (so this can extend an already-cleaned
tab without re-clearing it), and append at the bottom.

Python port of backfill-gap-cleaned.ps1.
"""
import argparse
import csv
import io
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from lib import CREATED_AT_PATTERN

SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"

# Used ONLY when a tab has no header row yet - matches the fixed list applied
# to both hyphen and mcaffeine via cleanup_ticket_sheet.py --restrict-columns.
# Never fall back to the batch's raw (unfiltered, ~250+ column) header here -
# that silently reintroduces every raw column instead of keeping the tab in
# its defined, cleaned shape.
DEFAULT_TARGET_COLUMNS = [
    "Ticket Number", "Customer ID", "Chat Link", "Order Name", "Source", "Created At",
    "Objective: age_group", "Objective: suggested_product_name", "Objective: product_category",
    "Objective: skin_type", "Objective: count_shopify_id", "Objective: gender", "Objective: category",
    "Objective: state_zone", "Objective: reference_link", "Objective: product_benefits",
    "Objective: first_time", "Objective: platform_name", "Objective: usage_times", "Objective: am_pm",
    "Objective: sequence_of_usage", "Objective: reason_for_purchase", "Subcategory",
    "Disposition: Order", "Disposition: Product Name", "Disposition: Batch number",
    "Disposition: AWB number", "Disposition: Order date", "Disposition: warehouse name",
    "Disposition: partner_name", "Disposition: Estimated_time_delivery_SR",
    "Disposition: Query Class",
]


def fetch_export_csv(api_token, tab_name, gap_start, gap_end):
    body = {
        "startDate": gap_start,
        "endDate": gap_end,
        "timestampKey": "resolvedAt",
        "statuses": ["resolved_by_ai", "resolved_by_agent"],
        "sortOrder": "desc",
        "timezone": "Asia/Kolkata",
        "locale": "en-IN",
    }
    last_err = None
    for attempt in range(1, 5):
        try:
            resp = requests.post(
                "https://api.flowcall.co/apis/task-runs/tickets/export",
                headers={"Authorization": f"Bearer {api_token}"},
                json=body,
                timeout=180,
            )
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            last_err = e
            print(f"[{tab_name}] export request attempt {attempt} failed: {e}")
            if attempt == 4:
                raise
            time.sleep(5 * attempt)
    raise RuntimeError("export request failed") from last_err


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-token", required=True)
    parser.add_argument("--tab-name", required=True)
    parser.add_argument("--gap-start", required=True)
    parser.add_argument("--gap-end", required=True)
    args = parser.parse_args()

    tab_name = args.tab_name
    print(f"[{tab_name}] fetching gap window {args.gap_start} -> {args.gap_end}")

    csv_text = fetch_export_csv(args.api_token, tab_name, args.gap_start, args.gap_end)
    all_rows = list(csv.reader(io.StringIO(csv_text)))
    if len(all_rows) <= 1:
        print(f"[{tab_name}] no tickets in gap window - nothing to do")
        return

    raw_headers = all_rows[0]
    raw_rows = [list(r) for r in all_rows[1:]]
    print(f"[{tab_name}] fetched {len(raw_rows)} raw rows, {len(raw_headers)} columns")

    idx_order_name = raw_headers.index("Order Name") if "Order Name" in raw_headers else -1
    idx_disp_order = raw_headers.index("Disposition: Order") if "Disposition: Order" in raw_headers else -1
    idx_customer_id = raw_headers.index("Customer ID") if "Customer ID" in raw_headers else -1
    idx_subcategory = raw_headers.index("Subcategory") if "Subcategory" in raw_headers else -1
    idx_query_class = raw_headers.index("Disposition: Query Class") if "Disposition: Query Class" in raw_headers else -1

    fallback_count = 0
    replace_count = 0
    for row in raw_rows:
        if idx_order_name >= 0 and len(row) > idx_order_name:
            val = str(row[idx_order_name]).strip().upper()
            if val in ("N/A", "NA"):
                disp_val = str(row[idx_disp_order]) if idx_disp_order >= 0 and len(row) > idx_disp_order else ""
                cust_val = str(row[idx_customer_id]) if idx_customer_id >= 0 and len(row) > idx_customer_id else ""
                if disp_val.strip() and disp_val.strip().lower() != "null":
                    row[idx_order_name] = disp_val
                elif cust_val.strip() and cust_val.strip().lower() != "null":
                    row[idx_order_name] = cust_val
                else:
                    row[idx_order_name] = ""
                fallback_count += 1
        for c in range(len(row)):
            if row[c] and "Marked Undelivered" in str(row[c]):
                row[c] = str(row[c]).replace("Marked Undelivered", "Fake update")
                replace_count += 1
    print(f"[{tab_name}] Order Name fallback applied to {fallback_count} rows; "
          f"'Marked Undelivered' replaced in {replace_count} cells")

    before_count = len(raw_rows)
    if idx_subcategory >= 0:
        raw_rows = [r for r in raw_rows if len(r) > idx_subcategory and str(r[idx_subcategory]).strip() != ""]
    print(f"[{tab_name}] dropped {before_count - len(raw_rows)} rows with blank Subcategory "
          f"({before_count} -> {len(raw_rows)})")

    before_qc_count = len(raw_rows)
    if idx_query_class >= 0:
        raw_rows = [r for r in raw_rows
                    if not (len(r) > idx_query_class and
                            ("Requests & Enquiries" in str(r[idx_query_class]) or "Others" in str(r[idx_query_class])))]
    print(f"[{tab_name}] dropped {before_qc_count - len(raw_rows)} rows with 'Requests & Enquiries'/'Others' in "
          f"Disposition: Query Class ({before_qc_count} -> {len(raw_rows)})")

    if not raw_rows:
        print(f"[{tab_name}] nothing left to append after filtering")
        return

    # Map every surviving row onto the EXISTING tab's header (by name) so this
    # batch's columns - which can vary window to window, since the export's
    # Objective:* columns are dynamic per query - line up with whatever schema
    # the tab already has. If the tab has no header yet, use the defined
    # default rather than this batch's raw header.
    existing_header = lib.get_sheet_values(SHEET_ID, f"'{tab_name}'!A1:ZZ1")
    if existing_header:
        target_headers = existing_header[0]
    else:
        target_headers = DEFAULT_TARGET_COLUMNS
        lib.set_sheet_values_batch(SHEET_ID, [{"range": f"'{tab_name}'!A1", "values": [target_headers]}])
        print(f"[{tab_name}] tab had no header - wrote the {len(target_headers)}-column default header")

    col_indices = []
    missing = []
    for name in target_headers:
        idx = raw_headers.index(name) if name in raw_headers else -1
        if idx < 0:
            missing.append(name)
        col_indices.append(idx)
    if missing:
        print(f"[{tab_name}] gap batch has no column for (left blank): {', '.join(missing)}")

    mapped_rows = [
        [(src_row[i] if 0 <= i < len(src_row) else "") for i in col_indices]
        for src_row in raw_rows
    ]

    idx_created_at_in_target = target_headers.index("Created At") if "Created At" in target_headers else -1
    if idx_created_at_in_target >= 0:
        before_validate = len(mapped_rows)
        quarantined = [r for r in mapped_rows if not CREATED_AT_PATTERN.match(str(r[idx_created_at_in_target]).strip())]
        mapped_rows = [r for r in mapped_rows if CREATED_AT_PATTERN.match(str(r[idx_created_at_in_target]).strip())]
        if quarantined:
            idx_ticket_number_in_target = target_headers.index("Ticket Number") if "Ticket Number" in target_headers else -1
            bad_tickets = [str(r[idx_ticket_number_in_target]) if idx_ticket_number_in_target >= 0 else "?" for r in quarantined]
            print(f"[{tab_name}] QUARANTINED {before_validate - len(mapped_rows)} row(s) with malformed "
                  f"'Created At' (likely a column-shift from CSV parsing) - NOT written: {', '.join(bad_tickets)}")

    idx_ticket_number_in_target = target_headers.index("Ticket Number") if "Ticket Number" in target_headers else -1
    if idx_ticket_number_in_target >= 0:
        existing_ids = lib.get_sheet_values(SHEET_ID, f"'{tab_name}'!{lib.get_column_letter(idx_ticket_number_in_target)}2:{lib.get_column_letter(idx_ticket_number_in_target)}")
        existing_ids = {str(r[0]) for r in existing_ids if r}
        before_dedup = len(mapped_rows)
        mapped_rows = [r for r in mapped_rows if str(r[idx_ticket_number_in_target]) not in existing_ids]
        if before_dedup - len(mapped_rows):
            print(f"[{tab_name}] dropped {before_dedup - len(mapped_rows)} rows already present in the sheet "
                  f"(matched by Ticket Number)")

    if not mapped_rows:
        print(f"[{tab_name}] nothing new to append after quarantine/dedup")
        return

    next_row = lib.get_last_data_row(SHEET_ID, tab_name) + 1
    if next_row < 2:
        next_row = 2
    lib.set_sheet_rows_at_row(SHEET_ID, tab_name, mapped_rows, next_row)

    print(f"[{tab_name}] appended {len(mapped_rows)} gap-filled rows at row {next_row}")


if __name__ == "__main__":
    main()
