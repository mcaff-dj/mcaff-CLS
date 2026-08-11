"""Pushes Delivery-class tickets from PEP_CLS into Supabase Postgres, writing ticket fields
directly onto each order's row in escalation_lead_assignments - the Postgres counterpart of
sync_delivery_tickets_to_sheet.py, reading the same MySQL rows on the same "resolved since <date>"
definition.

Ticket data used to live in a separate escalation_tickets table, joined against
escalation_lead_assignments at read time - but that join was never actually wired into
api/_lib/db.js's getEscalationOrders, so the columns went unread. This merges ticket fields
directly onto escalation_lead_assignments instead (see
docs/superpowers/specs/2026-08-11-escalation-drop-bq-and-sheet-design.md for the now-superseded
two-table design). One order can have multiple MySQL tickets over time but only one live
assignment row, so this writes onto whichever row is currently "live" (reassigned_away_at IS NULL
AND last_updated_at IS NULL) for that parent_order, inserting a fresh live row (email NULL) if
none exists yet - same pattern resolveEscalationAssignment (api/_lib/db.js) already uses for
orders resolved without ever being assigned. Last-synced ticket wins when an order has more than
one ticket.

Reuses sync_delivery_tickets_to_sheet.py's MySQL query, row-building, and AWB-backfill functions
by import instead of re-implementing "which tickets count" a second time - that script is NOT
modified and keeps writing the sheet exactly as before.

total_times_user_reached still needs a second pass: a --since-windowed fetch only recomputes that
count for rows it just touched, so older live rows sharing the same AWB would otherwise go stale.
The second UPDATE below fixes exactly those rows, using the same awb_counts already computed for
step one.

CREDENTIALS: MYSQL_* (unchanged - same as sync_delivery_tickets_to_sheet.py) plus POSTGRES_URL.
No Google credentials needed - this script never touches Sheets or BigQuery.
"""
import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import sync_delivery_tickets_to_sheet as tickets

TAB_TABLE = tickets.TAB_TABLE  # {"HYPHEN": "hyphen_tickets", "mCaffeine": "mcaff_tickets"}

# Names for build_sheet_row's first 11 slots (Added date .. WH Name), same mapping
# sync_delivery_tickets_to_bq.py used.
TICKET_FIELDS = [
    "added_date", "query_class", "query_category", "parent_order", "awb_number",
    "delivery_partner_name", "order_date", "order_month", "query_date",
    "query_month", "wh_name",
]

# Two-step write per ticket row: try the live row for this order first (the common case - an
# order already has an assignment/eligibility row), fall back to inserting a fresh live row
# (email NULL) when none exists yet. Can't be a single ON CONFLICT upsert - unlike the old
# escalation_tickets table (PK brand+ticket_number), escalation_lead_assignments has no unique
# constraint ticket data alone can target, only the partial "live row per parent_order" index.
UPDATE_LIVE_SQL = """
    UPDATE escalation_lead_assignments
    SET brand = %(brand)s, ticket_number = %(ticket_number)s, awb_number = %(awb_number)s,
        added_date = %(added_date)s, query_class = %(query_class)s, query_category = %(query_category)s,
        delivery_partner_name = %(delivery_partner_name)s, order_date = %(order_date)s,
        order_month = %(order_month)s, query_date = %(query_date)s, query_month = %(query_month)s,
        wh_name = %(wh_name)s, total_times_user_reached = %(total_times_user_reached)s,
        ticket_loaded_at = %(loaded_at)s
    WHERE parent_order = %(parent_order)s AND reassigned_away_at IS NULL AND last_updated_at IS NULL
"""

INSERT_LIVE_SQL = """
    INSERT INTO escalation_lead_assignments
      (parent_order, email, brand, ticket_number, awb_number, added_date, query_class,
       query_category, delivery_partner_name, order_date, order_month, query_date, query_month,
       wh_name, total_times_user_reached, ticket_loaded_at)
    VALUES (%(parent_order)s, NULL, %(brand)s, %(ticket_number)s, %(awb_number)s, %(added_date)s,
            %(query_class)s, %(query_category)s, %(delivery_partner_name)s, %(order_date)s,
            %(order_month)s, %(query_date)s, %(query_month)s, %(wh_name)s,
            %(total_times_user_reached)s, %(loaded_at)s)
"""

# Scoped to the live row only - a resolved order's ticket columns are history, not something a
# later reach-count recompute should silently rewrite.
RECOMPUTE_SQL = """
    UPDATE escalation_lead_assignments SET total_times_user_reached = %(count)s
    WHERE brand = %(brand)s AND awb_number = %(awb_number)s
      AND reassigned_away_at IS NULL AND last_updated_at IS NULL
"""


def get_awb_reach_counts(table, awbs):
    """AWB -> total count of Delivery-class tickets ever raised against it in `table` - a
    running total across all history, not scoped to this sync's since/today filter, since "how
    many times has the user reached out" only means something as a lifetime count. Queries MySQL
    directly (not the local Postgres mirror), which can't have every historical row for an AWB
    when this run's fetch is windowed by `since`."""
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


def row_to_pg_dict(sheet_row, brand, awb_counts=None):
    """sheet_row is tickets.build_sheet_row()'s output (list: 11 ticket fields, padded to 25,
    then ticket_number appended last) - reused as-is rather than re-deriving the same values from
    the raw DB row a second time. Sliced/indexed by position (not by a fixed length), so padding
    column count changes in build_sheet_row don't break this mapping."""
    d = {"brand": brand}
    d.update(zip(TICKET_FIELDS, sheet_row))
    d["ticket_number"] = sheet_row[-1]
    d["loaded_at"] = datetime.now(timezone.utc)
    awb = d["awb_number"]
    # get_awb_reach_counts counts by the ticket table's own disposition_awb_number column, which
    # is blank on exactly the rows fill_missing_awb had to backfill from Item_level_data - those
    # rows won't self-match that count. This row is still one genuine instance of the AWB, so 1
    # is the floor, never 0/None for a row that does have an AWB.
    d["total_times_user_reached"] = max((awb_counts or {}).get(awb, 0), 1) if awb else None
    return d


def sync(since, dry_run):
    if not os.environ.get("POSTGRES_URL"):
        raise RuntimeError("POSTGRES_URL env var is required")

    all_rows = []
    all_awb_counts = {}
    for brand, table in TAB_TABLE.items():
        db_rows = tickets.fetch_today_delivery_tickets(table, since=since)
        print(f"  {brand} ({table}): {len(db_rows)} Delivery-class ticket(s) since {since}")
        sheet_rows = [tickets.build_sheet_row(r) for r in db_rows]
        tickets.fill_missing_awb(sheet_rows)
        awb_counts = get_awb_reach_counts(table, [r[4] for r in sheet_rows])
        all_rows.extend(row_to_pg_dict(r, brand, awb_counts) for r in sheet_rows)
        for awb, count in awb_counts.items():
            all_awb_counts[(brand, awb)] = count

    print(f"  {len(all_rows)} row(s) total to {'would upsert' if dry_run else 'upsert'}")
    if dry_run:
        for r in all_rows[:5]:
            print("   ", r)
        if len(all_rows) > 5:
            print(f"    ... and {len(all_rows) - 5} more")
        return

    conn = lib.get_pg_connection(os.environ["POSTGRES_URL"])
    inserted = 0
    try:
        # Pipeline mode batches the network round-trips: each row's UPDATE (and its
        # conditional INSERT-on-miss) still depends on that row's own prior result, but
        # psycopg overlaps sending row N+1's queries with receiving row N's replies instead
        # of a strict wait-then-send per row - this is psycopg's own documented use case for
        # pipelining (insert-after-failed-update). One flush at the end instead of one round
        # trip per statement is what actually cuts wall-clock on a remote (Supabase) connection.
        with conn.pipeline(), conn.cursor() as cur:
            for row in all_rows:
                cur.execute(UPDATE_LIVE_SQL, row)
                if cur.rowcount == 0:
                    cur.execute(INSERT_LIVE_SQL, row)
                    inserted += 1
            # Recompute total_times_user_reached on every live row sharing a touched AWB, not
            # just the ones this run fetched - see module docstring for why a plain upsert can't
            # do this.
            recompute = [{"brand": b, "awb_number": awb, "count": c} for (b, awb), c in all_awb_counts.items()]
            if recompute:
                cur.executemany(RECOMPUTE_SQL, recompute)
        conn.commit()
    finally:
        conn.close()
    print(f"  wrote {len(all_rows)} row(s) ({inserted} new live row(s)), "
          f"recomputed total_times_user_reached for {len(all_awb_counts)} AWB(s)")


def self_check():
    """Offline check of the row mapping - no MySQL, no Postgres."""
    db_row = ("TCK-1", "Late", "ORD-1", "", "AWB-1", "Delhivery",
              datetime(2026, 8, 1), datetime(2026, 8, 2), datetime(2026, 8, 3), "WH1")
    sheet_row = tickets.build_sheet_row(db_row)
    out = row_to_pg_dict(sheet_row, "HYPHEN", awb_counts={"AWB-1": 3})
    assert out["brand"] == "HYPHEN", out
    assert out["ticket_number"] == "TCK-1", out
    assert out["parent_order"] == "ORD-1", out
    assert out["wh_name"] == "WH1", out
    assert out["order_month"] == tickets.format_month(datetime(2026, 8, 1)), out
    assert out["total_times_user_reached"] == 3, out
    assert "loaded_at" in out

    out2 = row_to_pg_dict(sheet_row, "HYPHEN", awb_counts={})
    assert out2["total_times_user_reached"] == 1, out2

    no_awb_row = tickets.build_sheet_row(("TCK-2", "Late", "ORD-2", "", "", "Delhivery",
                                           datetime(2026, 8, 1), datetime(2026, 8, 2), datetime(2026, 8, 3), "WH1"))
    out3 = row_to_pg_dict(no_awb_row, "HYPHEN", awb_counts={})
    assert out3["total_times_user_reached"] is None, out3

    # Every %(name)s placeholder the write-path SQL references must exist as a key on the dict
    # row_to_pg_dict produces (or, for RECOMPUTE_SQL, on the recompute-params dict) - catches a
    # column added to one but not the other without needing a live Postgres connection.
    import re
    placeholders = lambda sql: set(re.findall(r"%\((\w+)\)s", sql))
    for sql in (UPDATE_LIVE_SQL, INSERT_LIVE_SQL):
        missing = placeholders(sql) - set(out.keys())
        assert not missing, f"{sql!r} references undefined keys: {missing}"
    recompute_keys = {"brand", "awb_number", "count"}
    missing = placeholders(RECOMPUTE_SQL) - recompute_keys
    assert not missing, f"RECOMPUTE_SQL references undefined keys: {missing}"
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no Postgres writes")
    parser.add_argument("--since", metavar="YYYY-MM-DD", required=False,
                         help="Backfill everything resolved from this date through today, not just today.")
    parser.add_argument("--self-check", action="store_true", help="Run the offline row-mapping check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    sync(args.since, args.dry_run)


if __name__ == "__main__":
    main()
