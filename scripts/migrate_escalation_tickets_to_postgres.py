"""One-off: backfills the ticket columns (added_date/query_class/.../wh_name/ticket_number/brand)
that api/_lib/db.js's ensurePgSchema merged onto escalation_lead_assignments, from the escalation
Sheet's A:K + Z columns - the same source scripts/sync_delivery_tickets_to_sheet.py writes and
scripts/sync_delivery_tickets_to_pg.py now mirrors into Postgres going forward. This script covers
the gap: history already in the Sheet from before that cron job started writing to Postgres.

Companion to migrate_escalation_resolutions_to_postgres.py (same one-off/COALESCE/re-runnable
shape, T:W instead of A:K+Z). Run once, by hand, before relying on the ticket columns being
complete - not on a schedule.

One order can have multiple ticket rows in the Sheet; the Sheet is append-only in chronological
order (see sync_delivery_tickets_to_sheet.py's sync_tab), so the LAST row seen per parent_order in
sheet order is the most recent ticket - the same "most recent wins" rule the live cron sync
applies going forward. Only that winning row per order is written.

COALESCE in the UPDATE means a second run - or the live cron sync running in between - never gets
clobbered by older Sheet data: a column already set (by an earlier run of this script or by the
cron job) is left alone. Only fills gaps.

Matches scripts/sync_delivery_tickets_to_pg.py's write shape: UPDATE the order's most-recently-
assigned row (resolved or not), INSERT a fresh row (email NULL) only if none exists yet - NOT the
old "live row or insert" shape, which reopened a bogus new cycle on every re-run against an order
that had already been resolved.
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
SHEET_TABS = ["HYPHEN", "mCaffeine"]

# A:Z column order, matching sync_delivery_tickets_to_sheet.py's build_sheet_row layout (A:K) plus
# its Ticket Number dedup column (Z).
TICKET_COLUMNS = [
    "added_date", "query_class", "query_category", "parent_order", "awb_number",
    "delivery_partner_name", "order_date", "order_month", "query_date", "query_month", "wh_name",
]
COL_TICKET_NUMBER = 25  # Z

POSTGRES_ENV_VAR = "POSTGRES_URL"

UPDATE_LIVE_SQL = """
    UPDATE escalation_lead_assignments
    SET brand = COALESCE(brand, %(brand)s),
        ticket_number = COALESCE(ticket_number, %(ticket_number)s),
        awb_number = COALESCE(awb_number, %(awb_number)s),
        added_date = COALESCE(added_date, %(added_date)s),
        query_class = COALESCE(query_class, %(query_class)s),
        query_category = COALESCE(query_category, %(query_category)s),
        delivery_partner_name = COALESCE(delivery_partner_name, %(delivery_partner_name)s),
        order_date = COALESCE(order_date, %(order_date)s),
        order_month = COALESCE(order_month, %(order_month)s),
        query_date = COALESCE(query_date, %(query_date)s),
        query_month = COALESCE(query_month, %(query_month)s),
        wh_name = COALESCE(wh_name, %(wh_name)s),
        ticket_loaded_at = COALESCE(ticket_loaded_at, now())
    WHERE id = (
        SELECT id FROM escalation_lead_assignments
        WHERE parent_order = %(parent_order)s ORDER BY assigned_at DESC LIMIT 1
    )
"""

INSERT_LIVE_SQL = """
    INSERT INTO escalation_lead_assignments
      (parent_order, email, brand, ticket_number, awb_number, added_date, query_class,
       query_category, delivery_partner_name, order_date, order_month, query_date, query_month,
       wh_name, ticket_loaded_at)
    VALUES (%(parent_order)s, NULL, %(brand)s, %(ticket_number)s, %(awb_number)s, %(added_date)s,
            %(query_class)s, %(query_category)s, %(delivery_partner_name)s, %(order_date)s,
            %(order_month)s, %(query_date)s, %(query_month)s, %(wh_name)s, now())
"""


def brand_for_order(parent_order):
    """Brand is derived from the order id's own prefix, not which tab the row came from - a
    HYP-prefixed order pasted into the wrong tab (or found via CSV import) still reports its real
    brand. Matches getEscalationOrderIndex's brand values elsewhere."""
    return "HYPHEN" if parent_order.startswith("H") else "mCaffeine"


def read_ticket_rows():
    """{parent_order: {ticket-column dict}} - one entry per order, the LAST (most recent, since
    the sheet is append-only in chronological order) ticket row seen for it, across both tabs."""
    by_order = {}
    for tab in SHEET_TABS:
        values = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!A2:Z")
        for row in values:
            d = {col: (row[i] if len(row) > i else "") for i, col in enumerate(TICKET_COLUMNS)}
            parent_order = d.pop("parent_order")
            if not parent_order:
                continue
            d["parent_order"] = parent_order
            d["brand"] = brand_for_order(parent_order)
            d["ticket_number"] = row[COL_TICKET_NUMBER] if len(row) > COL_TICKET_NUMBER else ""
            by_order[parent_order] = d  # later rows overwrite earlier ones - last seen wins
    return by_order


def migrate(dry_run):
    by_order = read_ticket_rows()
    rows = list(by_order.values())
    print(f"  {len(rows)} order(s) with ticket data found in the sheet")
    if dry_run:
        for r in rows[:5]:
            print("   ", r)
        if len(rows) > 5:
            print(f"    ... and {len(rows) - 5} more")
        return

    conn = lib.get_pg_connection(os.environ[POSTGRES_ENV_VAR])
    inserted = 0
    try:
        with conn.cursor() as cur:
            for row in rows:
                cur.execute(UPDATE_LIVE_SQL, row)
                if cur.rowcount == 0:
                    cur.execute(INSERT_LIVE_SQL, row)
                    inserted += 1
        conn.commit()
    finally:
        conn.close()
    print(f"  migrated {len(rows)} row(s) ({inserted} new live row(s))")


def self_check():
    """Offline check of the last-seen-wins grouping and SQL/dict key parity - no sheet, no DB."""
    import re
    global lib
    class _FakeLib:
        @staticmethod
        def get_sheet_values(spreadsheet_id, rng):
            tab = rng.split("!")[0].strip("'")
            data = {
                "HYPHEN": [
                    ["Aug 1, 2026", "Delivery", "Late", "HYP-1", "AWB-1", "Delhivery"],
                    ["Aug 3, 2026", "Delivery", "Late", "HYP-1", "AWB-2", "Bluedart"],  # newer, should win
                ],
                "mCaffeine": [
                    ["Aug 1, 2026", "Delivery", "Late", "MCaff-1", "AWB-3", "Delhivery"],
                ],
            }
            return data.get(tab, [])
    lib = _FakeLib()
    by_order = read_ticket_rows()
    assert by_order["HYP-1"]["awb_number"] == "AWB-2", by_order["HYP-1"]
    assert by_order["HYP-1"]["brand"] == "HYPHEN", by_order["HYP-1"]
    # Brand comes from the order id prefix, not the tab it was read from.
    assert brand_for_order("HYP31900000") == "HYPHEN"
    assert brand_for_order("MCaff9097914") == "mCaffeine"
    assert by_order["MCaff-1"]["brand"] == "mCaffeine", by_order["MCaff-1"]

    placeholders = lambda sql: set(re.findall(r"%\((\w+)\)s", sql))
    row_keys = set(next(iter(by_order.values())).keys())
    for sql in (UPDATE_LIVE_SQL, INSERT_LIVE_SQL):
        missing = placeholders(sql) - row_keys
        assert not missing, f"{sql!r} references undefined keys: {missing}"
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Read and print only, no Postgres writes")
    parser.add_argument("--self-check", action="store_true", help="Run the offline grouping check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    migrate(args.dry_run)


if __name__ == "__main__":
    main()
