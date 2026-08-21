"""One-off: backfills awb_code for every existing PEP_CLS.CLS_RTO_calling row that
predates the awb_code column (see scripts/migrate_cls_rto_calling_schema.py and
api/_lib/db.js's ensureSchema), by looking up each row's order_id against the
RTO 'Data' sheet's AWB Code column (G, index 6 - see scripts/lead_priority.py's
COL_AWB_CODE).

Only touches rows where awb_code IS NULL, and only writes when a match is found
in the sheet - an order_id no longer present in the sheet (e.g. archived) is left
NULL rather than guessed at. Each UPDATE is wrapped so a unique-constraint hit
(two order_ids resolving to the same AWB) is reported and skipped instead of
aborting the whole backfill.

LIVE CYCLES ONLY. This table holds one row per assignment cycle rather than one
per lead (see migrate_cls_rto_calling_schema.py), so both the SELECT and the
UPDATE below are scoped to reassigned_away_at IS NULL. Without that, this would
also stamp an AWB onto retired cycles - and in particular onto the rows folded in
from the old lead_reassignment_attempts table, whose entire content is "this
agent lost this lead" and which never had an AWB of their own. Those are
history, not shipments awaiting a backfill; an unscoped run against the old
Postgres table once picked up 148 rows where only 30 were real targets. The
unscoped UPDATE would also have written every matching cycle at once while
counting it as a single row.
"""
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from mysql_lib import get_credential
from lead_priority import COL_AWB_CODE, COL_ORDER_ID, cell

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"
SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"


def build_awb_by_order_id():
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AD")
    mapping = {}
    for row in values:
        order_id = cell(row, COL_ORDER_ID)
        awb_code = cell(row, COL_AWB_CODE)
        if order_id and awb_code:
            mapping[order_id] = awb_code
    return mapping


def connect():
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    return pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        read_timeout=180, write_timeout=180,
    )


def fetch_missing(conn):
    with conn.cursor() as cur:
        cur.execute(f"SELECT order_id FROM `{TABLE}` WHERE awb_code IS NULL AND reassigned_away_at IS NULL")
        return [row[0] for row in cur.fetchall()]


def main():
    awb_by_order_id = build_awb_by_order_id()
    print(f"Loaded {len(awb_by_order_id)} order_id -> AWB Code mappings from the sheet.")

    updated, not_found, conflicts = 0, 0, []
    seen_not_found = set()

    # Chunk size for the batched executemany below - a few hundred keeps each chunk's UPDATE
    # well inside any max_allowed_packet-equivalent while still collapsing what used to be one
    # round trip per row.
    CHUNK_SIZE = 500

    # The connection can be dropped mid-run (a restart, a network blip) - each chunk commits
    # individually and this whole function is idempotent (only ever touches rows still NULL),
    # so on a dropped connection we just reconnect and pick up wherever the fresh
    # missing-list says to continue, rather than losing already-applied progress.
    conn = connect()
    try:
        while True:
            missing = fetch_missing(conn)
            missing = [oid for oid in missing if oid not in seen_not_found]
            if not missing:
                break

            pairs = []  # (awb_code, order_id)
            for order_id in missing:
                awb_code = awb_by_order_id.get(order_id)
                if not awb_code:
                    not_found += 1
                    seen_not_found.add(order_id)
                    continue
                pairs.append((awb_code, order_id))

            try:
                with conn.cursor() as cur:
                    for start in range(0, len(pairs), CHUNK_SIZE):
                        chunk = pairs[start:start + CHUNK_SIZE]
                        try:
                            cur.executemany(
                                f"UPDATE `{TABLE}` SET awb_code = %s "
                                "WHERE order_id = %s AND awb_code IS NULL "
                                "AND reassigned_away_at IS NULL",
                                chunk,
                            )
                            conn.commit()
                            updated += len(chunk)
                        except pymysql.err.IntegrityError:
                            # Rare: this chunk has at least one order_id whose AWB collides
                            # with another order_id's already-written AWB, which aborts the
                            # WHOLE chunk's transaction (nothing in it committed, same as the
                            # single-row version's per-row rollback used to guarantee) - the
                            # table's live_awb_code generated column carries the unique index
                            # (see migrate_cls_rto_calling_schema.py). Redo just this chunk one
                            # row at a time so only the genuinely conflicting row(s) are
                            # skipped, instead of losing an otherwise-clean batch over one bad row.
                            conn.rollback()
                            for awb_code, order_id in chunk:
                                try:
                                    cur.execute(
                                        f"UPDATE `{TABLE}` SET awb_code = %s "
                                        "WHERE order_id = %s AND awb_code IS NULL "
                                        "AND reassigned_away_at IS NULL",
                                        (awb_code, order_id),
                                    )
                                    conn.commit()
                                    updated += 1
                                except pymysql.err.IntegrityError:
                                    conn.rollback()
                                    conflicts.append((order_id, awb_code))
            except pymysql.err.OperationalError as e:
                print(f"Connection dropped ({e.__class__.__name__}) - reconnecting and resuming...")
                conn = connect()
                continue
    finally:
        conn.close()

    print(f"Backfilled {updated} row(s).")
    print(f"{not_found} row(s) had no matching order_id in the sheet - left NULL.")
    if conflicts:
        print(f"{len(conflicts)} row(s) skipped - AWB Code already used by another order_id:")
        for order_id, awb_code in conflicts:
            print(f"  {order_id} -> {awb_code}")


if __name__ == "__main__":
    main()
