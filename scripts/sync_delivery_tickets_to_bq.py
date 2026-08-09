"""Loads today's resolved Delivery-class tickets from PEP_CLS straight into BigQuery.

The BigQuery counterpart to sync_delivery_tickets_to_sheet.py, which is deliberately left
untouched and keeps writing the sheet. Two jobs, one destination each: a BigQuery outage cannot
break the sheet write that keeps the L:P formulas alive, and a Sheets outage cannot stop the
queue's data reaching BigQuery.

The two are unordered with respect to each other. This job owns the ticket columns; the sheet
sweep owns the formula and logistics columns. Whichever writes a row second fills in the other
half rather than fighting over it.

Query logic is imported from the sheet job rather than copied - fetch_today_delivery_tickets,
fill_missing_awb and build_sheet_row are pure MySQL reads with no sheet side effects, and that
file guards its entry point with __main__, so importing it runs nothing. One definition of
"which tickets count", two consumers.

Dedup is against escalation.orders.ticket_number, not the sheet's column Z, so neither job can
starve the other. The MERGE is idempotent on top of that, which makes a re-run - after a failure,
or with --since to backfill a missed day - always safe.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import escalation_bq_schema as schema
import sync_delivery_tickets_to_sheet as tickets

# Sheet tab name == brand == the key into the sheet job's MySQL table map. Same three things.
BRAND_TABLE = tickets.TAB_TABLE

MERGE_FIELDS = schema.IDENTITY_COLUMNS + schema.TICKET_COLUMNS


def ticket_row_to_bq(cells, brand):
    """One build_sheet_row() output -> the ticket-owned columns of escalation.orders.

    Routed through the shared sheet-index table, so this job and the sweep can never disagree
    about which cell is which. Sheet-owned and app-owned columns are dropped rather than sent as
    blanks: the MERGE would not name them anyway, and an empty string here would be a lie about
    who owns them.
    """
    row = schema.sheet_row_to_bq(cells, brand)
    return {k: row[k] for k in MERGE_FIELDS}


def existing_ticket_numbers(brand):
    rows = bq_lib.query_rows(
        f"SELECT DISTINCT ticket_number FROM `{schema.ORDERS}` "
        "WHERE brand = @brand AND ticket_number IS NOT NULL AND ticket_number != ''",
        [bq_lib.str_param("brand", brand)],
    )
    return {r["ticket_number"] for r in rows if r.get("ticket_number")}


def load_brand(brand, dry_run=False, since=None):
    table = BRAND_TABLE[brand]
    print(f"--- {brand} ({table}) ---")
    schema.create_tables()

    existing = existing_ticket_numbers(brand)
    print(f"  {len(existing)} ticket numbers already in BigQuery")

    db_rows = tickets.fetch_today_delivery_tickets(table, since=since)
    print(f"  {len(db_rows)} Delivery-class tickets resolved "
          f"{'since ' + since if since else 'today'} in DB")

    fresh = [r for r in db_rows if r[0] not in existing]
    print(f"  {len(fresh)} new tickets to load")
    if not fresh:
        return {"brand": brand, "fetched": len(db_rows), "new": 0, "merged": 0}

    tickets.fill_missing_awb(fresh)
    rows = [ticket_row_to_bq(tickets.build_sheet_row(r), brand) for r in fresh]

    duplicates = schema.count_duplicate_keys(rows)
    if duplicates:
        print(f"  note: {duplicates} row(s) share a (brand, parent_order, awb_key) key")

    if dry_run:
        for r in rows[:5]:
            print("   ", r)
        if len(rows) > 5:
            print(f"    ... and {len(rows) - 5} more")
        return {"brand": brand, "fetched": len(db_rows), "new": len(rows), "merged": 0}

    # One MERGE for the batch. Never a statement per ticket: BigQuery queues concurrent mutating
    # DML per table, and a backfill can carry thousands of rows.
    data = bq_lib.query(
        schema.build_ticket_merge(),
        [bq_lib.struct_array_param("items", MERGE_FIELDS, rows)],
    )
    merged = bq_lib.affected_rows(data)
    print(f"  merged {merged} row(s) into {schema.ORDERS}")
    return {"brand": brand, "fetched": len(db_rows), "new": len(rows), "merged": merged}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=sorted(BRAND_TABLE))
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch and print only, no BigQuery writes")
    parser.add_argument("--since",
                        help="YYYY-MM-DD: backfill tickets resolved from this date through today")
    args = parser.parse_args()
    if not args.brand:
        parser.error("--brand is required")
    load_brand(args.brand, args.dry_run, args.since)


if __name__ == "__main__":
    main()
