#!/usr/bin/env python3
"""One-off DDL + backfill: adds `Shipping_Address_State` and `Pincode` to
PEP_CLS.Delivery_escalation - same cross-schema AWB lookup pattern
backfill_delivery_escalation_shipping_city.py already uses for Shipping_Address_City
(Delivery_escalation.awb_code = Item_level_data.Tracking_Number).

Both are backfilled from Item_level_data's own `Shipping_Address_State` and `Pincode` columns
(per direct confirmation - a stale codebase comment elsewhere claimed no pincode column, that's
wrong).

Batched IN(...) lookups against Item_level_data, not a JOIN across the whole ~50M-row table -
see gen_geo_insights.py's own comment on that table: an unfiltered scan/join against it is what
times out, a targeted IN() on its indexed Tracking_Number is what's fast. Item_level_data has
multiple rows per Tracking_Number (split shipments/re-syncs); ORDER BY Created DESC + first-
row-seen-wins picks the latest, same as the city backfill.

Plain nullable columns, not generated - the source lives in a different schema, out of reach for
a generated column's own-row-only expression.

Dry-run by default; --apply performs the DDL and backfill. Idempotent - skips the ALTER for
whichever column already exists, and the backfill is a plain UPDATE by awb_code so re-running
just refreshes it.
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
SOURCE = "mcaff_prod.Item_level_data"
BATCH_SIZE = 500  # SELECT lookup batch - fine at this size, keyed on Item_level_data's indexed Tracking_Number
UPDATE_CHUNK = 25  # rows per UPDATE transaction - Delivery_escalation is live prod, written by the
# app's own single-row upserts (disposeDeliveryEscalationTicket) while this runs; a small chunk
# keeps each transaction's lock footprint/duration short so it doesn't collide with those
CONNECTION_LOST_ERRNOS = (2013, 2006)  # "Lost connection" / "Gone away" - needs a reconnect
LOCK_WAIT_ERRNO = 1205
MAX_ATTEMPTS = 6  # each attempt already includes MySQL's own ~50s innodb_lock_wait_timeout,
# so this budgets several minutes total before giving up on one chunk

STATE_COLUMN = "Shipping_Address_State"
PINCODE_COLUMN = "Pincode"
# (target column, source column) - same name on both sides for these two
BACKFILL_COLUMNS = [(STATE_COLUMN, STATE_COLUMN), (PINCODE_COLUMN, PINCODE_COLUMN)]


def dedupe_rows(rows):
    """rows: iterable of (Tracking_Number, value) already ORDER BY Created DESC ->
    {awb: value} keeping the first (latest) value seen per AWB."""
    value_by_awb = {}
    for awb, value in rows:
        value_by_awb.setdefault(awb, value)
    return value_by_awb


def connect():
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    return pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        read_timeout=180, write_timeout=180,
    )


def self_check():
    assert dedupe_rows([("AWB1", "MH"), ("AWB1", "KA"), ("AWB2", "DL")]) == {
        "AWB1": "MH", "AWB2": "DL",
    }
    assert dedupe_rows([]) == {}
    print("self-check ok")


def run_with_retry(state, fn):
    """fn(conn, cur) -> result. Retries OperationalErrors up to MAX_ATTEMPTS: reconnects on a
    dropped connection, backs off on anything else (chiefly 1205 lock-wait-timeout from
    colliding with the live app's own writes to this table)."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return fn(state["conn"], state["cur"])
        except pymysql.err.OperationalError as e:
            if attempt == MAX_ATTEMPTS:
                if e.args[0] == LOCK_WAIT_ERRNO:
                    print_lock_diagnostics(state["conn"])
                raise
            if e.args[0] in CONNECTION_LOST_ERRNOS:
                print(f"  connection lost ({e}) - reconnecting...")
                state["conn"] = connect()
                state["cur"] = state["conn"].cursor()
            else:
                wait = min(2 ** attempt, 30)
                print(f"  {e} - retrying in {wait}s...")
                time.sleep(wait)


def print_lock_diagnostics(conn):
    """Best-effort: on final lock-wait failure, show what's actually holding the lock so a human
    can KILL it, instead of a bare traceback with no next step."""
    try:
        with conn.cursor() as c:
            c.execute(
                "SELECT trx_id, trx_started, trx_mysql_thread_id, trx_state, trx_query "
                "FROM information_schema.innodb_trx ORDER BY trx_started"
            )
            rows = c.fetchall()
        if not rows:
            print("\nNo open InnoDB transactions visible (blocker may be on a different account/host).")
            return
        print("\nOpen InnoDB transactions (oldest first - likely blocker is the long-idle one):")
        for trx_id, started, thread_id, trx_state, query in rows:
            print(f"  trx {trx_id} thread {thread_id} state={trx_state} started {started}: {query!r}")
        print("To unblock: `KILL <thread id>;` for the offending one, from a DB admin session.")
    except Exception as diag_err:
        print(f"\n(could not query lock diagnostics: {diag_err})")


def ensure_column(cur, column, ddl_type, apply_):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    if cur.fetchone() is not None:
        print(f"{column} already present on {SCHEMA}.{TABLE}.")
        return
    ddl = f"ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl_type} NULL"
    print(f"{'Applying' if apply_ else 'DRY RUN - would apply'}:\n\n{ddl}\n")
    if apply_:
        cur.execute(ddl)
        cur.connection.commit()
        print(f"Added {column} to {SCHEMA}.{TABLE}.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DDL + backfill (default is a dry run).")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    conn = connect()
    state = {"conn": conn, "cur": conn.cursor()}
    try:
        cur = state["cur"]
        ensure_column(cur, STATE_COLUMN, "VARCHAR(128)", args.apply)
        ensure_column(cur, PINCODE_COLUMN, "VARCHAR(16)", args.apply)

        cur.execute(f"SELECT DISTINCT awb_code FROM `{TABLE}` WHERE awb_code IS NOT NULL AND awb_code <> ''")
        awbs = [r[0] for r in cur.fetchall()]
        print(f"\n{len(awbs)} distinct AWB(s) to look up in {SOURCE}.")

        if not args.apply:
            cols = ", ".join(t for t, _ in BACKFILL_COLUMNS)
            print(f"Would then batch-lookup each AWB in {SOURCE} and UPDATE matching rows' {cols}.")
            print("Re-run with --apply to execute.")
            return

        total_batches = -(-len(awbs) // BATCH_SIZE) if awbs else 0
        for target_col, source_col in BACKFILL_COLUMNS:
            updated = 0
            for i in range(0, len(awbs), BATCH_SIZE):
                batch = awbs[i:i + BATCH_SIZE]
                placeholders = ",".join(["%s"] * len(batch))

                def do_select(conn, cur, source_col=source_col, placeholders=placeholders, batch=batch):
                    cur.execute(
                        f"SELECT Tracking_Number, {source_col} FROM {SOURCE} "
                        f"WHERE Tracking_Number IN ({placeholders}) "
                        f"AND {source_col} IS NOT NULL AND {source_col} <> '' "
                        f"ORDER BY Created DESC",
                        batch,
                    )
                    return dedupe_rows(cur.fetchall())

                value_by_awb = run_with_retry(state, do_select)
                items = list(value_by_awb.items())
                for j in range(0, len(items), UPDATE_CHUNK):
                    chunk = items[j:j + UPDATE_CHUNK]

                    def do_update(conn, cur, target_col=target_col, chunk=chunk):
                        cur.executemany(
                            f"UPDATE `{TABLE}` SET `{target_col}` = %s WHERE awb_code = %s",
                            [(value, awb) for awb, value in chunk],
                        )
                        conn.commit()
                        return cur.rowcount

                    updated += run_with_retry(state, do_update)
                print(f"  [{target_col}] batch {i // BATCH_SIZE + 1}/{total_batches}: {len(value_by_awb)}/{len(batch)} matched")
            print(f"Done - updated ~{updated} row(s)' {target_col} in {SCHEMA}.{TABLE}.")
    finally:
        state["conn"].close()


if __name__ == "__main__":
    main()
