"""One-off: backfills awb_code for every existing Postgres lead_assignments row
that predates the awb_code column (see scripts/sync_lead_assignments_to_mysql.py
and api/_lib/db.js's ensureSchema), by looking up each row's order_id against the
RTO 'Data' sheet's AWB Code column (G, index 6 - see scripts/lead_priority.py's
COL_AWB_CODE).

Only touches rows where awb_code IS NULL, and only writes when a match is found
in the sheet - an order_id no longer present in the sheet (e.g. archived) is left
NULL rather than guessed at. Each UPDATE is wrapped so a unique-constraint hit
(two order_ids resolving to the same AWB) is reported and skipped instead of
aborting the whole backfill.

LIVE CYCLES ONLY. lead_assignments now holds one row per assignment cycle rather
than one per lead (see api/_lib/db.js's ensurePgSchema), so both the SELECT and
the UPDATE below are scoped to reassigned_away_at IS NULL. Without that, this
would also stamp an AWB onto retired cycles - and in particular onto the rows
folded in from the old lead_reassignment_attempts table, whose entire content is
"this agent lost this lead" and which never had an AWB of their own. Those are
history, not shipments awaiting a backfill; an unscoped run picked up 148 rows
where only 30 were real targets. The unscoped UPDATE would also have written
every matching cycle at once while counting it as a single row.
"""
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from lead_priority import COL_AWB_CODE, COL_ORDER_ID, cell

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"


def build_awb_by_order_id():
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AD")
    mapping = {}
    for row in values:
        order_id = cell(row, COL_ORDER_ID)
        awb_code = cell(row, COL_AWB_CODE)
        if order_id and awb_code:
            mapping[order_id] = awb_code
    return mapping


def fetch_missing(conn_str):
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT order_id FROM lead_assignments "
                "WHERE awb_code IS NULL AND reassigned_away_at IS NULL"
            )
            return [row[0] for row in cur.fetchall()]


def main(conn_str):
    awb_by_order_id = build_awb_by_order_id()
    print(f"Loaded {len(awb_by_order_id)} order_id -> AWB Code mappings from the sheet.")

    updated, not_found, conflicts = 0, 0, []
    seen_not_found = set()

    # The pooled endpoint has been observed killing the connection mid-run (after a
    # couple hundred round trips) - each UPDATE commits individually and this whole
    # function is idempotent (only ever touches rows still NULL), so on a dropped
    # connection we just reconnect and pick up wherever the fresh missing-list says
    # to continue, rather than losing already-applied progress.
    while True:
        missing = fetch_missing(conn_str)
        missing = [oid for oid in missing if oid not in seen_not_found]
        if not missing:
            break
        try:
            with psycopg.connect(conn_str) as conn:
                for order_id in missing:
                    awb_code = awb_by_order_id.get(order_id)
                    if not awb_code:
                        not_found += 1
                        seen_not_found.add(order_id)
                        continue
                    try:
                        with conn.cursor() as cur:
                            cur.execute(
                                "UPDATE lead_assignments SET awb_code = %s "
                                "WHERE order_id = %s AND awb_code IS NULL "
                                "AND reassigned_away_at IS NULL",
                                (awb_code, order_id),
                            )
                        conn.commit()
                        updated += 1
                    except psycopg.errors.UniqueViolation:
                        conn.rollback()
                        conflicts.append((order_id, awb_code))
        except psycopg.OperationalError as e:
            print(f"Connection dropped ({e.__class__.__name__}) - reconnecting and resuming...")
            continue

    print(f"Backfilled {updated} row(s).")
    print(f"{not_found} row(s) had no matching order_id in the sheet - left NULL.")
    if conflicts:
        print(f"{len(conflicts)} row(s) skipped - AWB Code already used by another order_id:")
        for order_id, awb_code in conflicts:
            print(f"  {order_id} -> {awb_code}")


if __name__ == "__main__":
    import os
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    main(conn_str)
