"""Sweeps the escalation Sheet's L:S columns (formulas + externally-pasted logistics data) into
BigQuery's escalation.orders_sheet_columns - the read-only BigQuery counterpart of the Sheet
columns the app used to read directly via api/_lib/escalationSheet.js.

READ ONLY against the Sheet. Never writes to it - the Sheet's other three writers
(sync_delivery_tickets_to_sheet.py, its own formulas, the external logistics pipeline) are
untouched by this script and by the whole migration this script is part of (see
docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md).

Deliberately does NOT sweep column L (totalTimesConsumerReached) - Delivery_escalation's own
total_times_user_reached (scripts/sync_delivery_tickets_to_bq.py) is a better-sourced version of
the same metric, computed from MySQL ticket data rather than a sheet formula scanning sheet rows.

status_as_per_awb (N) and update_from_logistics (Q) ARE the RTO queue's filter predicate and their
logic isn't ours to reimplement (a sheet formula, an untraced external pipeline respectively) -
this script has to keep sweeping them regardless of anything else in the migration.

Always a full WRITE_TRUNCATE rebuild, both brands in one run - a load job replaces the whole
destination table, so there's no way to truncate-and-reload just one brand's rows without also
wiping the other's. Atomic on success; a failed run leaves the existing table untouched.

CREDENTIALS: same as sync_delivery_tickets_to_sheet.py (GOOGLE_SA_KEY_JSON/FILE) plus
BQ_PROJECT_ID/BQ_DATASET, matching sync_delivery_tickets_to_bq.py.
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import lib

PROJECT = os.environ.get("BQ_PROJECT_ID") or "sheetdata-501810"
DATASET = os.environ.get("BQ_DATASET", "escalation")
TABLE = os.environ.get("BQ_SHEET_TABLE", "orders_sheet_columns")

SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
SHEET_TABS = {"HYPHEN": "HYPHEN", "mCaffeine": "mCaffeine"}  # brand -> sheet tab name (identical today)

# Sheet columns A..Z in order (mirrors api/_lib/escalationSheet.js's COLUMNS - kept in sync
# deliberately, since both read the same physical spreadsheet layout).
SHEET_COLUMNS = [
    "addedDate", "queryClass", "queryCategory", "parentOrder", "awbNumber",
    "deliveryPartnerName", "orderDate", "orderMonth", "queryDate", "queryMonth",
    "whName", "totalTimesConsumerReached", "deliveredDate", "statusAsPerAwb",
    "solvDate", "tat", "updateFromLogistics", "city", "state", "newOrderId",
    "awb", "status", "notes", "_v1", "_v2", "ticketNumber",
]


def awb_key(awb_number):
    """LOWER(TRIM(...)) normalization, matching the spec's row-key definition - two sheet rows
    can legitimately share a key when the AWB is blank."""
    return (awb_number or "").strip().lower()


def sheet_row_to_bq_dict(row_values, brand, row_number):
    """row_values: one row from a Sheet values.get response (list, A:Z, may be shorter than 26
    if trailing cells are empty - Sheets omits them). Mirrors
    api/_lib/escalationSheet.js's rowToObject: missing/short trailing cells read as ''.

    Deliberately omits totalTimesConsumerReached (column L) - see module docstring for why."""
    obj = {}
    for i, key in enumerate(SHEET_COLUMNS):
        obj[key] = row_values[i] if i < len(row_values) else ""
    return {
        "brand": brand,
        "parent_order": obj["parentOrder"],
        "awb_key": awb_key(obj["awbNumber"]),
        "row_number": row_number,
        "delivered_date": obj["deliveredDate"],
        "status_as_per_awb": obj["statusAsPerAwb"],
        "solv_date": obj["solvDate"],
        "tat": obj["tat"],
        "update_from_logistics": obj["updateFromLogistics"],
        "city": obj["city"],
        "state": obj["state"],
        "deleted_from_sheet_at": None,
    }


def sweep_tab(dry_run):
    """Reads both brand tabs, truncate-rebuilds orders_sheet_columns with the union - see module
    docstring for why this can't be scoped to one brand."""
    all_rows = []
    for brand, tab in SHEET_TABS.items():
        values = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!A2:Z")
        print(f"  {brand} ({tab}): {len(values)} sheet row(s)")
        for i, row in enumerate(values):
            all_rows.append(sheet_row_to_bq_dict(row, brand, row_number=i + 2))

    # Dedup before the load: two rows can legitimately share (brand, parent_order, awb_key) when
    # the AWB is blank - keep the LAST one seen per key (matches the spec's QUALIFY ROW_NUMBER()
    # ... ORDER BY row_number choice, applied here in Python since this is a load job, not a
    # MERGE that could enforce it in SQL).
    by_key = {}
    dropped = 0
    for r in all_rows:
        key = (r["brand"], r["parent_order"], r["awb_key"])
        if key in by_key:
            dropped += 1
        by_key[key] = r
    deduped = list(by_key.values())
    if dropped:
        print(f"  dropped {dropped} duplicate-key row(s) (blank-AWB collisions)")

    print(f"  {len(deduped)} row(s) total to {'would rewrite' if dry_run else 'rewrite'} (WRITE_TRUNCATE)")
    if dry_run:
        for r in deduped[:5]:
            print("   ", r)
        if len(deduped) > 5:
            print(f"    ... and {len(deduped) - 5} more")
        return

    rewritten = bq_lib.load_ndjson(PROJECT, DATASET, TABLE, deduped, write_disposition="WRITE_TRUNCATE")
    print(f"  rewrote {rewritten} row(s)")


def self_check():
    """Offline check of the row mapping and dedup - no Sheets, no BigQuery."""
    row = ["Aug 1, 2026", "Delivery", "Delayed Order", "HYP1", "AWB-1", "Delhivery",
           "Jul 30, 2026", "7_Jul'26", "Aug 1, 2026", "8_Aug'26", "WH1", "2",
           "", "RTO", "", "Forced to be marked as RTO", "RTO", "Mumbai", "Maharashtra"]
    out = sheet_row_to_bq_dict(row, "HYPHEN", row_number=5)
    assert out["brand"] == "HYPHEN", out
    assert out["parent_order"] == "HYP1", out
    assert out["awb_key"] == "awb-1", out
    assert out["row_number"] == 5, out
    assert out["status_as_per_awb"] == "RTO", out
    assert out["update_from_logistics"] == "RTO", out
    assert out["city"] == "Mumbai", out
    assert "total_times_consumer_reached" not in out, "column L must never be swept"

    # A short row (trailing cells omitted by Sheets) reads missing fields as ''.
    short = ["Aug 1, 2026", "Delivery", "Delayed Order", "HYP2"]
    out2 = sheet_row_to_bq_dict(short, "HYPHEN", row_number=6)
    assert out2["status_as_per_awb"] == "", out2
    assert out2["awb_key"] == "", out2  # blank AWB normalizes to '', not None

    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no BigQuery writes")
    parser.add_argument("--self-check", action="store_true", help="Run the offline row-mapping check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    sweep_tab(args.dry_run)


if __name__ == "__main__":
    main()
