#!/usr/bin/env python3
"""Recurring (every 2 hours) export: fetch resolved tickets since the last
run, apply the same 3 cleanup rules as cleanup_ticket_sheet.py, map columns
onto whatever header the tab already has, drop any ticket whose "Ticket
Number" is already present in the sheet, and append only the new/unique
ones.

State file tracks the last successful window end per tab, so a run that
fires late still catches up the full gap instead of dropping it.

This supersedes export_resolved_tickets.py (which appended raw, unfiltered
columns and had no dedup) - use this one for the scheduled job so the tabs
stay in the cleaned/restricted shape.
"""
import argparse
import csv
import io
import json
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from lib import CREATED_AT_PATTERN

SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"
STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "resolved-ticket-export-state.json"

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


DISPATCH_DELAY_TRIGGER_CLASSES = ("Delivery", "Requests & Enquiries")


def build_dispatch_delay_duplicate(row, idx_dispatch, idx_qclass, idx_ticket, idx_subcategory):
    """Returns a Warehouse/Late-Delay-Dispatch duplicate of `row` when its dispatch
    delay exceeds 24h and its Query Class is Delivery or Requests & Enquiries (the
    latter is otherwise dropped from the sheet entirely by a later filter - only
    this duplicate survives for it), else None. Ticket Number gets a random
    suffix so the duplicate never collides with the original or an existing row."""
    if idx_dispatch < 0 or idx_qclass < 0 or len(row) <= max(idx_dispatch, idx_qclass):
        return None
    try:
        hours = float(row[idx_dispatch])
    except (TypeError, ValueError):
        return None
    if hours <= 24 or str(row[idx_qclass]).strip() not in DISPATCH_DELAY_TRIGGER_CLASSES:
        return None

    needed_len = max(idx_qclass, idx_subcategory, idx_ticket) + 1
    dup = list(row) + [""] * (needed_len - len(row))
    if idx_ticket >= 0:
        dup[idx_ticket] = f"{dup[idx_ticket]}-WH{random.randint(1000, 9999)}"
    dup[idx_qclass] = "Warehouse"
    if idx_subcategory >= 0:
        dup[idx_subcategory] = "Late/Delay Dispatch"
    return dup


def get_state():
    if not STATE_PATH.exists():
        return {}
    with open(STATE_PATH, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=4)


def fetch_export_csv(api_token, tab_name, start_str, end_str):
    body = {
        "startDate": start_str,
        "endDate": end_str,
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
    parser.add_argument("--hours-back", type=int, default=2)
    args = parser.parse_args()

    tab_name = args.tab_name
    now = datetime.now(timezone.utc)
    state = get_state()
    if state.get(tab_name):
        start_date = datetime.fromisoformat(state[tab_name].replace("Z", "+00:00"))
    else:
        start_date = now - timedelta(hours=args.hours_back)
    end_date = now

    start_str = start_date.strftime("%Y-%m-%dT%H:%M:%S.") + f"{start_date.microsecond // 1000:03d}Z"
    end_str = end_date.strftime("%Y-%m-%dT%H:%M:%S.") + f"{end_date.microsecond // 1000:03d}Z"

    print(f"[{tab_name}] fetching tickets resolved {start_str} -> {end_str}")

    csv_text = fetch_export_csv(args.api_token, tab_name, start_str, end_str)
    all_rows = list(csv.reader(io.StringIO(csv_text)))

    if len(all_rows) <= 1:
        print(f"[{tab_name}] no resolved tickets in this window - nothing to append")
        state[tab_name] = end_str
        save_state(state)
        return

    raw_headers = all_rows[0]
    raw_rows = [list(r) for r in all_rows[1:]]
    print(f"[{tab_name}] fetched {len(raw_rows)} raw rows, {len(raw_headers)} columns")

    idx_order_name = raw_headers.index("Order Name") if "Order Name" in raw_headers else -1
    idx_disp_order = raw_headers.index("Disposition: Order") if "Disposition: Order" in raw_headers else -1
    idx_customer_id = raw_headers.index("Customer ID") if "Customer ID" in raw_headers else -1
    idx_subcategory = raw_headers.index("Subcategory") if "Subcategory" in raw_headers else -1
    idx_ticket_number = raw_headers.index("Ticket Number") if "Ticket Number" in raw_headers else -1
    idx_query_class = raw_headers.index("Disposition: Query Class") if "Disposition: Query Class" in raw_headers else -1
    idx_dispatch_delay = (raw_headers.index("Objective: Dispatch_date_timeframe")
                           if "Objective: Dispatch_date_timeframe" in raw_headers else -1)

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

    dispatch_duplicates = [
        dup for row in raw_rows
        if (dup := build_dispatch_delay_duplicate(row, idx_dispatch_delay, idx_query_class,
                                                   idx_ticket_number, idx_subcategory)) is not None
    ]
    if dispatch_duplicates:
        raw_rows.extend(dispatch_duplicates)
        print(f"[{tab_name}] added {len(dispatch_duplicates)} dispatch-delay duplicate rows "
              f"(Warehouse / Late-Delay Dispatch)")

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

    # De-dup THIS batch against itself (a ticket can appear twice if it was
    # touched more than once inside the window) and against every Ticket
    # Number already sitting in the sheet, so a re-run (or a resumed/late
    # window overlapping previous coverage) never creates duplicate rows.
    if idx_ticket_number >= 0:
        seen_in_batch = set()
        deduped = []
        for r in raw_rows:
            tid = str(r[idx_ticket_number]) if len(r) > idx_ticket_number else ""
            if tid and tid in seen_in_batch:
                continue
            if tid:
                seen_in_batch.add(tid)
            deduped.append(r)
        intra_batch_dupes = len(raw_rows) - len(deduped)
        raw_rows = deduped
        if intra_batch_dupes:
            print(f"[{tab_name}] dropped {intra_batch_dupes} duplicate Ticket Number rows within this batch")

    if not raw_rows:
        print(f"[{tab_name}] nothing left to append after filtering")
        state[tab_name] = end_str
        save_state(state)
        return

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
        print(f"[{tab_name}] no column for (left blank): {', '.join(missing)}")

    idx_ticket_number_in_target = target_headers.index("Ticket Number") if "Ticket Number" in target_headers else -1

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
            bad_samples = [
                f"{str(r[idx_ticket_number_in_target]) if idx_ticket_number_in_target >= 0 else '?'}="
                f"{str(r[idx_created_at_in_target])!r}"
                for r in quarantined
            ]
            print(f"[{tab_name}] QUARANTINED {before_validate - len(mapped_rows)} row(s) with malformed "
                  f"'Created At' (likely a column-shift from CSV parsing) - NOT written: {', '.join(bad_samples)}")

    if idx_ticket_number_in_target >= 0:
        existing_ids = set()
        if lib.get_last_data_row(SHEET_ID, tab_name) >= 2:
            col_letter = lib.get_column_letter(idx_ticket_number_in_target)
            existing_vals = lib.get_sheet_values(SHEET_ID, f"'{tab_name}'!{col_letter}2:{col_letter}")
            existing_ids = {str(r[0]) for r in existing_vals if r}
        before_dedup = len(mapped_rows)
        mapped_rows = [r for r in mapped_rows if str(r[idx_ticket_number_in_target]) not in existing_ids]
        print(f"[{tab_name}] dropped {before_dedup - len(mapped_rows)} rows already present in the sheet "
              f"(matched by Ticket Number)")

    if not mapped_rows:
        print(f"[{tab_name}] nothing new to append (all tickets already present)")
        state[tab_name] = end_str
        save_state(state)
        return

    next_row = lib.get_last_data_row(SHEET_ID, tab_name) + 1
    if next_row < 2:
        next_row = 2
    lib.set_sheet_rows_at_row(SHEET_ID, tab_name, mapped_rows, next_row)

    print(f"[{tab_name}] appended {len(mapped_rows)} unique rows at row {next_row} (window {start_str} -> {end_str})")

    state[tab_name] = end_str
    save_state(state)


if __name__ == "__main__":
    main()
