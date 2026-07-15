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

SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"


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

    if not raw_rows:
        print(f"[{tab_name}] nothing left to append after filtering")
        return

    # Map every surviving row onto the EXISTING tab's header (by name) so this
    # batch's columns - which can vary window to window, since the export's
    # Objective:* columns are dynamic per query - line up with whatever schema
    # the tab already has.
    target_headers = lib.get_sheet_values(SHEET_ID, f"'{tab_name}'!A1:ZZ1")[0]
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

    next_row = lib.get_last_data_row(SHEET_ID, tab_name) + 1
    if next_row < 2:
        next_row = 2
    lib.set_sheet_rows_at_row(SHEET_ID, tab_name, mapped_rows, next_row)

    print(f"[{tab_name}] appended {len(mapped_rows)} gap-filled rows at row {next_row}")


if __name__ == "__main__":
    main()
