#!/usr/bin/env python3
"""Backfill: populates `new_order_AWB` on PEP_CLS.Delivery_escalation for New Order Placed
tickets (outcome = 'Escalated > New order placed' - same DE_NEW_ORDER_PLACED_WHERE root
api/_lib/db.js uses) from mcaff_prod.lmd_courier_tracking.

Logic, confirmed against order HYP44044680 (2026-09-09): a reshipped order gets its OWN row in
lmd_courier_tracking under the same uni_Display_Order_Code but a different awb_number and a
later uni_Order_Date - the original RTO'd leg's row doesn't get overwritten in place. So for
each ticket's order_id, take the lmd_courier_tracking row with the latest uni_Order_Date; if
its awb_number differs from the ticket's own awb_code, that's the replacement shipment ->
new_order_AWB. If it's the SAME awb_code (no reshipment has happened, or this ticket's AWB
already IS the latest one), new_order_AWB stays NULL - `<>` in the dedupe below does both jobs
at once, same as the SQL-JOIN version of this query would via its WHERE clause.

Batched IN(...) lookups against lmd_courier_tracking by order_id, not a full cross-schema JOIN -
same reasoning as backfill_delivery_escalation_shipping_city.py's own comment on Item_level_data:
a targeted IN() on an indexed column is fast, an unfiltered join across schemas on a large table
is what risks a timeout.

Dry-run by default; --apply performs the backfill. Idempotent - a plain UPDATE by id, safe to
re-run (e.g. from the 2-hourly sync-delivery-tickets.yml cron) as new reshipments land in
lmd_courier_tracking.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential
import pymysql

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"
COLUMN = "new_order_AWB"
SOURCE = "mcaff_prod.lmd_courier_tracking"
NEW_ORDER_PLACED_OUTCOME = "Escalated > New order placed"
BATCH_SIZE = 500


def latest_awb_by_order_id(rows):
    """rows: iterable of (uni_Display_Order_Code, awb_number) already ORDER BY uni_Order_Date
    DESC, created_at DESC -> {order_id: latest_awb}, keeping the first (latest) awb seen per
    order_id - same first-row-seen-wins dedupe as backfill_delivery_escalation_shipping_city.py's
    dedupe_city_rows."""
    latest = {}
    for order_id, awb in rows:
        latest.setdefault(order_id, awb)
    return latest


def connect():
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    # read_timeout is generous (not the pymysql default) because lmd_courier_tracking has no
    # index on uni_Display_Order_Code (3.7M rows, no ALTER rights on that table to add one - see
    # add_index_lmd_courier_tracking_order_code.py's own comment) - each batched IN() lookup is a
    # full table scan, not an indexed one.
    return pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        read_timeout=900, write_timeout=900,
    )


def self_check():
    assert latest_awb_by_order_id([("HYP1", "NEW_AWB"), ("HYP1", "OLD_AWB"), ("HYP2", "X")]) == {
        "HYP1": "NEW_AWB", "HYP2": "X",
    }
    assert latest_awb_by_order_id([]) == {}
    print("self-check ok")


MAX_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 5


def execute_with_retry(conn, sql, params):
    """Runs one query, reconnecting and retrying on a lost connection - lmd_courier_tracking has
    no index on uni_Display_Order_Code (see connect()'s own comment), so each batch lookup is a
    full 3.7M-row scan that occasionally outlives the connection even with a generous
    read_timeout (caught live 2026-09-10: pymysql.err.OperationalError 2013 'Lost connection to
    MySQL server during query', mid-scan - well within read_timeout's own 900s, so this is the
    server/network dropping an idle-looking-but-still-scanning connection, not a client timeout).
    Returns (rows, conn): a retry replaces conn with a fresh connection, and the caller must keep
    using the one this returns, including for its own eventual close()."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            cur = conn.cursor()
            cur.execute(sql, params)
            return cur.fetchall(), conn
        except pymysql.err.OperationalError as e:
            if attempt == MAX_ATTEMPTS:
                raise
            print(f"  query failed ({e}) - reconnecting and retrying (attempt {attempt + 1}/{MAX_ATTEMPTS})")
            try:
                conn.close()
            except Exception:
                pass
            time.sleep(RETRY_DELAY_SECONDS)
            conn = connect()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the backfill (default is a dry run).")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    conn = connect()
    try:
        tickets, conn = execute_with_retry(
            conn,
            f"SELECT id, order_id, awb_code FROM `{TABLE}` "
            f"WHERE outcome = %s AND order_id IS NOT NULL AND order_id <> ''",
            (NEW_ORDER_PLACED_OUTCOME,),
        )
        order_ids = sorted({t[1] for t in tickets})
        print(f"{len(tickets)} New Order Placed ticket(s) across {len(order_ids)} distinct order_id(s).")

        if not args.apply:
            print(f"Would batch-lookup each order_id in {SOURCE} and UPDATE `{COLUMN}` where the "
                  f"latest awb_number differs from the ticket's own awb_code.")
            print("Re-run with --apply to execute.")
            return

        latest_by_order = {}
        total_batches = -(-len(order_ids) // BATCH_SIZE) if order_ids else 0
        for i in range(0, len(order_ids), BATCH_SIZE):
            batch = order_ids[i:i + BATCH_SIZE]
            placeholders = ",".join(["%s"] * len(batch))
            rows, conn = execute_with_retry(
                conn,
                f"SELECT uni_Display_Order_Code, awb_number FROM {SOURCE} "
                f"WHERE uni_Display_Order_Code IN ({placeholders}) "
                f"AND awb_number IS NOT NULL AND awb_number <> '' "
                f"ORDER BY uni_Order_Date DESC, created_at DESC",
                batch,
            )
            latest_by_order.update(latest_awb_by_order_id(rows))
            print(f"  lookup batch {i // BATCH_SIZE + 1}/{total_batches}: "
                  f"{len(latest_by_order)} order_id(s) resolved so far")

        to_update = [
            (latest_by_order[order_id], ticket_id)
            for (ticket_id, order_id, awb_code) in tickets
            if latest_by_order.get(order_id) and latest_by_order[order_id] != awb_code
        ]
        print(f"\n{len(to_update)} ticket(s) have a newer AWB than their own awb_code.")
        if to_update:
            cur = conn.cursor()
            cur.executemany(f"UPDATE `{TABLE}` SET `{COLUMN}` = %s WHERE id = %s", to_update)
            conn.commit()
        print(f"Done - updated {len(to_update)} row(s) in {SCHEMA}.{TABLE}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
