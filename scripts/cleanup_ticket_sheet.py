#!/usr/bin/env python3
"""One-off cleanup pass over an already-exported ticket tab:
 1. Order Name "N/A"/"NA" -> falls back to Disposition: Order, else Customer ID, else blank
 2. Replace the literal text "Marked Undelivered" -> "Fake update" in every cell
 3. Drop rows where Subcategory is blank
 4. (hyphen only, via --restrict-columns) trim to a fixed column list

Fetches the whole tab, transforms in memory, then clears and rewrites it.
Python port of cleanup-ticket-sheet.ps1.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"

HYPHEN_TARGET_COLUMNS = [
    "Ticket Number", "Customer ID", "Chat Link", "Order Name", "Source", "Created At",
    "Objective: age_group", "Objective: suggested_product_name", "Objective: product_category",
    "Objective: skin_type", "Objective: count_shopify_id", "Objective: gender", "Objective: category",
    "Objective: state_zone", "Objective: reference_link", "Objective: product_benefits",
    "Objective: first_time", "Objective: platform_name", "Objective: usage_times", "Objective: am_pm",
    "Objective: sequence_of_usage", "Objective: reason_for_purchase", "Subcategory",
    "Disposition: Order", "Disposition: Product Name", "Disposition: Batch number",
    "Disposition: AWB number", "Disposition: Order date", "Disposition: warehouse name",
    "Disposition: partner_name", "Disposition: Estimated_time_delivery_SR",
]


def write_back(sheet_id, tab_name, final_headers, rows):
    clear_range = f"'{tab_name}'!A1:ZZ20000"
    lib.clear_sheet_range(sheet_id, clear_range)
    lib.set_sheet_values_batch(sheet_id, [{"range": f"'{tab_name}'!A1", "values": [final_headers]}])
    if rows:
        lib.set_sheet_rows_at_row(sheet_id, tab_name, rows, 2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab-name", required=True)
    parser.add_argument("--restrict-columns", action="store_true")
    parser.add_argument("--from-cache", action="store_true")
    args = parser.parse_args()

    tab_name = args.tab_name
    cache_path = Path(__file__).resolve().parent.parent / "data" / f"cleanup-cache-{tab_name}.json"

    if args.from_cache:
        if not cache_path.exists():
            raise SystemExit(f"No cache file at {cache_path} to resume from.")
        print(f"[{tab_name}] resuming from cached result at {cache_path} (skipping fetch/transform)")
        with open(cache_path, "r", encoding="utf-8-sig") as f:
            cached = json.load(f)
        final_headers = cached["headers"]
        rows = cached["rows"]
        write_back(SHEET_ID, tab_name, final_headers, rows)
        cache_path.unlink(missing_ok=True)
        print(f"[{tab_name}] done (from cache)")
        return

    headers = lib.get_sheet_values(SHEET_ID, f"'{tab_name}'!A1:ZZ1")[0]
    last_col = lib.get_column_letter(len(headers) - 1)
    print(f"[{tab_name}] {len(headers)} columns (last={last_col}) - fetching all rows...")
    rows = lib.get_sheet_rows_chunked(SHEET_ID, tab_name, last_col, chunk_size=5000, start_row=2)

    idx_order_name = headers.index("Order Name") if "Order Name" in headers else -1
    idx_disp_order = headers.index("Disposition: Order") if "Disposition: Order" in headers else -1
    idx_customer_id = headers.index("Customer ID") if "Customer ID" in headers else -1
    idx_subcategory = headers.index("Subcategory") if "Subcategory" in headers else -1

    print(f"[{tab_name}] indices - OrderName={idx_order_name} DispOrder={idx_disp_order} "
          f"CustomerID={idx_customer_id} Subcategory={idx_subcategory}")

    fallback_count = 0
    replace_count = 0

    for row in rows:
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

    before_count = len(rows)
    if idx_subcategory >= 0:
        rows = [r for r in rows if len(r) > idx_subcategory and str(r[idx_subcategory]).strip() != ""]
    dropped_count = before_count - len(rows)
    print(f"[{tab_name}] dropped {dropped_count} rows with blank Subcategory ({before_count} -> {len(rows)})")

    final_headers = headers
    if args.restrict_columns:
        col_indices = []
        missing = []
        for name in HYPHEN_TARGET_COLUMNS:
            idx = headers.index(name) if name in headers else -1
            if idx < 0:
                missing.append(name)
            col_indices.append(idx)
        if missing:
            print(f"[{tab_name}] WARNING - target columns not found in current header (left blank): {', '.join(missing)}")
        final_headers = HYPHEN_TARGET_COLUMNS
        rows = [
            [(src_row[i] if 0 <= i < len(src_row) else "") for i in col_indices]
            for src_row in rows
        ]

    print(f"[{tab_name}] writing back {len(final_headers)} columns x {len(rows)} rows")

    # Cache the fully computed result before touching the sheet - if the clear or
    # the write gets hit by a transient connection reset partway through, rerun
    # with --from-cache to skip straight to the write instead of re-fetching.
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump({"headers": final_headers, "rows": rows}, f, separators=(",", ":"))
    print(f"[{tab_name}] cached computed result to {cache_path}")

    write_back(SHEET_ID, tab_name, final_headers, rows)
    cache_path.unlink(missing_ok=True)
    print(f"[{tab_name}] done")


if __name__ == "__main__":
    main()
