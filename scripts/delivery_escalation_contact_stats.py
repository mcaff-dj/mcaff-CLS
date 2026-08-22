#!/usr/bin/env python3
"""Adds and maintains PEP_CLS.Delivery_escalation's repeat-contact columns:

  contact_count     - how many tickets share this row's (awb_code, brand), i.e. how many times
                      the customer came back about the same parcel - scoped to brand because
                      the same awb_code string can be reused by different brands' couriers
  first_added_date  - the EARLIEST added_date across those tickets, i.e. when they first
                      reached out (the row's own added_date is when THAT ticket was raised)

Both are plain columns recomputed in bulk, NOT generated columns: a generated column's
expression may only reference its own row, and these are aggregates over every row sharing an
AWB. They also can't be computed in the page query itself - a window function there would be
evaluated after the view's WHERE, so a Fresh-tab row would count only its Fresh siblings rather
than all of the customer's contacts.

Staleness is bounded to zero in practice: the ONLY thing that changes either value is a new
ticket arriving, which only happens through the 2-hourly cron mirror
(sync_delivery_tickets_to_sheet.py) - and that calls recompute() at the end of every run. An
agent disposing a ticket never changes them.

Rows with no awb_code are left NULL: with nothing to group on, their repeat count is unknowable
rather than 1.

Run directly to add the columns (if missing) and populate: --apply, dry-run by default.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"

NEW_COLUMNS = [
    ("contact_count", "INT NULL"),
    ("first_added_date", "DATE NULL"),
]

# The derived table is materialised before the UPDATE runs, which is what makes it legal to
# aggregate over the same table being written (a bare correlated subquery on the target table
# would be rejected with "You can't specify target table for update in FROM clause").
RECOMPUTE_SQL = f"""
UPDATE {TABLE} d
JOIN (
    SELECT awb_code, brand,
           COUNT(*) AS n,
           MIN(added_date) AS first_added
    FROM {TABLE}
    WHERE awb_code IS NOT NULL AND awb_code <> ''
    GROUP BY awb_code, brand
) agg ON agg.awb_code = d.awb_code AND agg.brand = d.brand
SET d.contact_count = agg.n,
    d.first_added_date = agg.first_added
"""


def recompute(conn):
    """Refresh both columns for every row with an AWB. Caller owns the connection/commit."""
    cur = conn.cursor()
    cur.execute(RECOMPUTE_SQL)
    conn.commit()
    return cur.rowcount


def connect():
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    return pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        read_timeout=240, write_timeout=240,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Add columns if missing and populate (default: dry run).")
    args = ap.parse_args()

    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s",
            (SCHEMA, TABLE),
        )
        existing = {r[0] for r in cur.fetchall()}
        missing = [(n, d) for n, d in NEW_COLUMNS if n not in existing]

        if missing:
            stmt = f"ALTER TABLE `{TABLE}` " + ", ".join(f"ADD COLUMN `{n}` {d}" for n, d in missing)
            print(f"{'Applying' if args.apply else 'DRY RUN - would apply'}:\n  {stmt}\n")
        else:
            print("Both columns already present.")

        if not args.apply:
            print("Would then recompute contact_count / first_added_date for every row.")
            print("Re-run with --apply to execute.")
            return

        if missing:
            cur.execute(stmt)
            conn.commit()
            print(f"Added {', '.join(n for n, _ in missing)}.")

        updated = recompute(conn)
        print(f"Recomputed {updated} row(s).")

        cur.execute(f"""
            SELECT CASE WHEN contact_count = 1 THEN '1'
                        WHEN contact_count BETWEEN 2 AND 4 THEN '2-4'
                        WHEN contact_count BETWEEN 5 AND 9 THEN '5-9'
                        ELSE '10+' END AS bucket,
                   COUNT(DISTINCT awb_code) AS customers
            FROM {TABLE} WHERE contact_count IS NOT NULL
            GROUP BY bucket ORDER BY MIN(contact_count)
        """)
        print("\nRepeat-contact spread (distinct AWBs):")
        for bucket, customers in cur.fetchall():
            print(f"  {bucket:>4} time(s): {customers}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
