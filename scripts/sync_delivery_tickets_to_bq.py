"""Pushes Delivery-class tickets from PEP_CLS into BigQuery's Delivery_escalation table - the
BigQuery counterpart of sync_delivery_tickets_to_sheet.py, reading the same MySQL rows on the
same "resolved since <date>" definition.

Reuses that script's MySQL query, row-building, and AWB-backfill functions by import instead of
re-implementing "which tickets count" a second time - it is NOT modified and keeps writing the
sheet exactly as before (see docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md).

Both brand tabs land in ONE table, distinguished by a `brand` column ('HYPHEN' / 'mCaffeine') -
the same split the sheet tabs and the hyphen_tickets/mcaff_tickets MySQL tables already use.

Ingest is a full WRITE_TRUNCATE rebuild every run, not an incremental append: total_times_user_reached
needs recomputing for already-loaded rows whenever a new same-AWB ticket arrives, which an
append-only path can't do. --rebuild-since should always be the same anchor date (the date the
table's history starts from) - see .github/workflows/sync-escalation-bq.yml.

CREDENTIALS: same GOOGLE_SA_KEY_JSON/GOOGLE_SA_KEY_FILE service account as lib.py's Sheets calls,
plus BQ_PROJECT_ID for the target GCP project. That account needs BigQuery Data Editor + BigQuery
Job User on BQ_PROJECT_ID.
"""
import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import sync_delivery_tickets_to_sheet as tickets

PROJECT = os.environ.get("BQ_PROJECT_ID", "sheetdata-501810")
DATASET = os.environ.get("BQ_DATASET", "escalation")
TABLE = os.environ.get("BQ_TABLE", "Delivery_escalation")

TAB_TABLE = tickets.TAB_TABLE  # {"HYPHEN": "hyphen_tickets", "mCaffeine": "mcaff_tickets"}

# Names for build_sheet_row's first 11 slots (Added date .. WH Name - the only
# columns this job ever has data for). Order matches that function's own
# in-line comments 1:1.
TICKET_FIELDS = [
    "added_date", "query_class", "query_category", "parent_order", "awb_number",
    "delivery_partner_name", "order_date", "order_month", "query_date",
    "query_month", "wh_name",
]

def get_awb_reach_counts(table, awbs):
    """AWB -> total count of Delivery-class tickets ever raised against it in
    `table` - a running total across all history, not scoped to this sync's
    since/today filter, since "how many times has the user reached out" only
    means something as a lifetime count."""
    awbs = sorted({a for a in awbs if a})
    if not awbs:
        return {}
    placeholders = ",".join(["%s"] * len(awbs))
    rows = tickets.mysql_lib.query(
        f"SELECT disposition_awb_number, COUNT(*) FROM {table} "
        f"WHERE category LIKE %s AND disposition_awb_number IN ({placeholders}) "
        f"GROUP BY disposition_awb_number",
        ("%Delivery%", *awbs), database="PEP_CLS",
    )
    return {awb: count for awb, count in (rows or [])}


def row_to_bq_dict(sheet_row, brand, awb_counts=None):
    """sheet_row is tickets.build_sheet_row()'s output (list: 11 ticket fields,
    padded to 25, then ticket_number appended last) - reused as-is rather than
    re-deriving the same values from the raw DB row a second time. Sliced/
    indexed by position (not by a fixed length), so padding column count
    changes in build_sheet_row don't break this mapping."""
    d = {"brand": brand}
    d.update(zip(TICKET_FIELDS, sheet_row))
    d["ticket_number"] = sheet_row[-1]
    d["loaded_at"] = datetime.now(timezone.utc).isoformat()
    # get_awb_reach_counts counts by the ticket table's own disposition_awb_number
    # column, which is blank on exactly the rows fill_missing_awb had to backfill
    # from Item_level_data - those rows won't self-match that count. This row is
    # still one genuine instance of the AWB, so 1 is the floor, never 0/None for
    # a row that does have an AWB (only a truly blank AWB stays None).
    awb = d["awb_number"]
    d["total_times_user_reached"] = max((awb_counts or {}).get(awb, 0), 1) if awb else None
    return d


def rebuild_table(since, dry_run):
    """Rewrites the WHOLE table (both brands) with freshly rebuilt rows -
    the only way to correct already-loaded fields (awb_number,
    delivery_partner_name, total_times_user_reached) in this Sandbox project:
    DML (UPDATE/MERGE/DELETE) is billing-gated the same way streaming inserts
    are (see bq_lib.load_ndjson), so an in-place fix-up isn't available.

    `since` should cover exactly what's already in the table (matches the
    date last used with sync_brand --since) - this REPLACES the table, so
    anything outside that window disappears. write_disposition="WRITE_TRUNCATE"
    only swaps in on load-job success, so a failed run leaves the existing
    table untouched rather than half-overwriting it."""
    if not PROJECT:
        raise RuntimeError("BQ_PROJECT_ID env var is required")

    all_bq_rows = []
    for brand, table in TAB_TABLE.items():
        db_rows = tickets.fetch_today_delivery_tickets(table, since=since)
        print(f"  {brand} ({table}): {len(db_rows)} Delivery-class ticket(s) since {since}")
        sheet_rows = [tickets.build_sheet_row(r) for r in db_rows]
        tickets.fill_missing_awb(sheet_rows)
        awb_counts = get_awb_reach_counts(table, [r[4] for r in sheet_rows])
        all_bq_rows.extend(row_to_bq_dict(r, brand, awb_counts) for r in sheet_rows)

    print(f"  {len(all_bq_rows)} row(s) total to {'would rewrite' if dry_run else 'rewrite'} (WRITE_TRUNCATE)")
    if dry_run:
        for r in all_bq_rows[:5]:
            print("   ", r)
        if len(all_bq_rows) > 5:
            print(f"    ... and {len(all_bq_rows) - 5} more")
        return

    rewritten = bq_lib.load_ndjson(PROJECT, DATASET, TABLE, all_bq_rows, write_disposition="WRITE_TRUNCATE")
    print(f"  rewrote {rewritten} row(s)")


def self_check():
    """Offline check of the row mapping - no BigQuery, no DB."""
    db_row = ("TCK-1", "Late", "ORD-1", "", "AWB-1", "Delhivery",
              datetime(2026, 8, 1), datetime(2026, 8, 2), datetime(2026, 8, 3), "WH1")
    sheet_row = tickets.build_sheet_row(db_row)
    out = row_to_bq_dict(sheet_row, "HYPHEN", awb_counts={"AWB-1": 3})
    assert out["brand"] == "HYPHEN", out
    assert out["ticket_number"] == "TCK-1", out
    assert out["parent_order"] == "ORD-1", out
    assert out["wh_name"] == "WH1", out
    assert out["order_month"] == tickets.format_month(datetime(2026, 8, 1)), out
    assert out["total_times_user_reached"] == 3, out
    assert "loaded_at" in out
    # AWB present but this ticket's own disposition_awb_number was blank (the
    # AWB came from fill_missing_awb's Item_level_data backfill instead) -
    # get_awb_reach_counts can't self-match it, but the row is still one real
    # instance of the AWB, so the count floors at 1, never 0.
    out2 = row_to_bq_dict(sheet_row, "HYPHEN", awb_counts={})
    assert out2["total_times_user_reached"] == 1, out2
    # No AWB at all (still blank after backfill) -> genuinely unknown, stays None.
    no_awb_row = tickets.build_sheet_row(("TCK-2", "Late", "ORD-2", "", "", "Delhivery",
                                           datetime(2026, 8, 1), datetime(2026, 8, 2), datetime(2026, 8, 3), "WH1"))
    out3 = row_to_bq_dict(no_awb_row, "HYPHEN", awb_counts={})
    assert out3["total_times_user_reached"] is None, out3
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no BigQuery writes")
    parser.add_argument("--rebuild-since", metavar="YYYY-MM-DD", required=False,
                         help="Rewrite the WHOLE table (both brands, WRITE_TRUNCATE) with freshly rebuilt rows since "
                              "this date, to keep awb_number/delivery_partner_name/total_times_user_reached correct. "
                              "Always both brands.")
    parser.add_argument("--self-check", action="store_true", help="Run the offline row-mapping check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if not args.rebuild_since:
        parser.error("--rebuild-since is required")
    rebuild_table(args.rebuild_since, args.dry_run)


if __name__ == "__main__":
    main()
