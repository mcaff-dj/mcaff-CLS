"""Pushes today's resolved Delivery-class tickets from PEP_CLS into BigQuery's
Delivery_escalation table - the BigQuery counterpart of
sync_delivery_tickets_to_sheet.py, reading the same MySQL rows on the same
"resolved today" definition.

Reuses that script's MySQL query, row-building, and AWB-backfill functions by
import instead of re-implementing "which tickets count" a second time - it is
NOT modified and keeps writing the sheet exactly as before (see
docs/superpowers/specs/2026-08-09-escalation-bigquery-direct-ingest-design.md,
which takes this same reuse-by-import approach for its own BigQuery loader).

Both brand tabs land in ONE table, distinguished by a `brand` column
('HYPHEN' / 'mCaffeine') - the same split the sheet tabs and the
hyphen_tickets/mcaff_tickets MySQL tables already use, so nothing has to
translate between them.

Dedup is independent of the sheet: each run queries BigQuery for ticket
numbers already loaded for that brand and skips them, the BigQuery equivalent
of column Z's role in the sheet job. Rows are appended via a load job (see
bq_lib.load_ndjson) rather than a streaming insert - this dedup query is the
only line of defense, since load jobs have no per-row insertId dedup the way
streaming inserts do.

CREDENTIALS: same GOOGLE_SA_KEY_JSON/GOOGLE_SA_KEY_FILE service account as
lib.py's Sheets calls, plus BQ_PROJECT_ID for the target GCP project. That
account needs BigQuery Data Editor + BigQuery Job User on BQ_PROJECT_ID.
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

SCHEMA = [{"name": name, "type": "STRING"} for name in ["brand", *TICKET_FIELDS, "ticket_number"]] + [
    {"name": "loaded_at", "type": "TIMESTAMP"},
]


def row_to_bq_dict(sheet_row, brand):
    """sheet_row is tickets.build_sheet_row()'s output (list: 11 ticket fields,
    padded to 25, then ticket_number appended last) - reused as-is rather than
    re-deriving the same values from the raw DB row a second time. Sliced/
    indexed by position (not by a fixed length), so padding column count
    changes in build_sheet_row don't break this mapping."""
    d = {"brand": brand}
    d.update(zip(TICKET_FIELDS, sheet_row))
    d["ticket_number"] = sheet_row[-1]
    d["loaded_at"] = datetime.now(timezone.utc).isoformat()
    return d


def get_existing_ticket_numbers(brand):
    sql = f"SELECT ticket_number FROM `{PROJECT}.{DATASET}.{TABLE}` WHERE brand = @brand"
    rows = bq_lib.run_query(PROJECT, sql, params={"brand": brand})
    return {r["ticket_number"] for r in rows if r.get("ticket_number")}


def sync_brand(brand, dry_run, since=None):
    table = TAB_TABLE[brand]
    print(f"--- {brand} ({table}) -> BigQuery {DATASET}.{TABLE} ---")

    if not PROJECT:
        raise RuntimeError("BQ_PROJECT_ID env var is required")

    if not dry_run:
        bq_lib.ensure_table(PROJECT, DATASET, TABLE, SCHEMA)

    existing = get_existing_ticket_numbers(brand) if not dry_run else set()
    if not dry_run:
        print(f"  {len(existing)} ticket numbers already in BigQuery")

    db_rows = tickets.fetch_today_delivery_tickets(table, since=since)
    print(f"  {len(db_rows)} Delivery-class tickets resolved {'since ' + since if since else 'today'} in DB")

    new_db_rows = [r for r in db_rows if r[0] not in existing]
    print(f"  {len(new_db_rows)} new rows to {'would insert' if dry_run else 'insert'}")
    if not new_db_rows:
        return

    sheet_rows = [tickets.build_sheet_row(r) for r in new_db_rows]
    tickets.fill_missing_awb(sheet_rows)
    bq_rows = [row_to_bq_dict(r, brand) for r in sheet_rows]

    if dry_run:
        for r in bq_rows[:5]:
            print("   ", r)
        if len(bq_rows) > 5:
            print(f"    ... and {len(bq_rows) - 5} more")
        return

    inserted = bq_lib.load_ndjson(PROJECT, DATASET, TABLE, bq_rows)
    print(f"  inserted {inserted} row(s)")


def self_check():
    """Offline check of the row mapping - no BigQuery, no DB."""
    db_row = ("TCK-1", "Late", "ORD-1", "", "", "Delhivery",
              datetime(2026, 8, 1), datetime(2026, 8, 2), datetime(2026, 8, 3), "WH1")
    sheet_row = tickets.build_sheet_row(db_row)
    out = row_to_bq_dict(sheet_row, "HYPHEN")
    assert out["brand"] == "HYPHEN", out
    assert out["ticket_number"] == "TCK-1", out
    assert out["parent_order"] == "ORD-1", out
    assert out["wh_name"] == "WH1", out
    assert out["order_month"] == tickets.format_month(datetime(2026, 8, 1)), out
    assert "loaded_at" in out
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", choices=sorted(TAB_TABLE), help="brand to sync (HYPHEN or mCaffeine)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no BigQuery writes")
    parser.add_argument("--since", help="YYYY-MM-DD: backfill tickets resolved from this date through today (default: today only)")
    parser.add_argument("--self-check", action="store_true", help="Run the offline row-mapping check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if not args.tab:
        parser.error("--tab is required")
    sync_brand(args.tab, args.dry_run, args.since)


if __name__ == "__main__":
    main()
