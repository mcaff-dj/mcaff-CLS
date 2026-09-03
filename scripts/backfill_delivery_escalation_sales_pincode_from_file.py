#!/usr/bin/env python3
"""One-off backfill: fills PEP_CLS.Delivery_escalation.sales_Pincode from a hand-provided raw
shipment CSV (e.g. a "45Days_Delivered_Base_File" export - one row per order, not
pre-aggregated), instead of live-querying mcaff_prod.Item_level_data the way
backfill_delivery_escalation_sales_pincode.py does. sales_Pincode's meaning is unchanged - a
COUNT of orders - see that script's own docstring; this one is just a finer grain (per
calendar day + per courier, not per calendar month across all couriers), matching CSV columns
confirmed against a real sample file (2026-09-04, 1.4M rows / 500MB):

  Delivery_Pincode -> Pincode, Brand Name -> brand, order_date (DD/MM/YYYY HH:MM:SS, only the
  date part used) -> order_date, Courier ctso -> delivery_partner. Courier ctso's values (e.g.
  'Pikndel_M_Rapid') are exact matches to raw delivery_partner values already stored - see
  PARTNER_NAME_MAP in app/delivery-escalation/DeliveryEscalationClient.js. The file's own
  'Final Couriers' column (e.g. 'Pikndel Rapid', space not underscore) is a DIFFERENT, display-
  only value and does NOT match what's stored - do not switch to it.

Scoped like the existing backfill script: Delivery_escalation itself only ever has 31k-90k rows
total (see scripts/alter_delivery_escalation_add_indexes.py) - a small fraction of what a
45-day full delivered-shipment export covers (that sample file grouped into ~1.18M distinct
(pincode, brand, date, courier) combos, almost all with no corresponding ticket at all). This
script reads Delivery_escalation's own distinct combos FIRST, then counts matching CSV rows for
only those combos while streaming the file once - never processes the file's own combos that
have no ticket to update.

brand/delivery_partner are matched case-insensitively (a hand-provided CSV might differ in
casing from what's stored) by uppercasing both sides when building/looking up the wanted-combo
dict; the actual UPDATE's WHERE clause uses the exact (Pincode, brand, order_date,
delivery_partner) tuple already read back from Delivery_escalation itself, so it always
addresses real rows regardless of the CSV's own casing.

A combo with no matching CSV row is left untouched (NULL if never set before) rather than
forced to 0 - same "can't compute, don't guess" reasoning as the existing backfill script's own
docstring gives for the identical choice.

ADDITIVE, not overwrite: a combo that already has a sales_Pincode gets this run's count ADDED
to it (`sales_Pincode = COALESCE(sales_Pincode, 0) + count`), by explicit request (2026-09-04).
This is NOT idempotent - re-running this script against the same CSV, or against two CSVs whose
date ranges overlap, double-counts the overlap. There is deliberately no run-tracking/dedup
here; re-running with overlapping data is the caller's responsibility to avoid.

Dry-run by default; --apply performs the writes. Streams the CSV once with csv.DictReader -
never loads the full file into memory - safe for files far larger than the ~90k rows this
table itself has.

Reuses the connect/retry/watchdog plumbing from backfill_delivery_escalation_sales_pincode.py
verbatim (not shared via import - every backfill_delivery_escalation_*.py script in this repo
duplicates its own copy) - see that script's own comments for why each piece exists (a
documented flaky path to this RDS host: silent connection stalls with no exception, needing a
side-thread watchdog rather than trusting pymysql's own timeouts).
"""
import argparse
import csv
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential
import pymysql

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"
UPDATE_CHUNK = 25  # small transactions - live prod table, same reasoning as the other
# backfill_delivery_escalation_*.py scripts' own UPDATE_CHUNK comment
CONNECTION_LOST_ERRNOS = (2013, 2006)
MAX_ATTEMPTS = 20
QUERY_WATCHDOG_SECONDS = 25
CONNECT_WATCHDOG_SECONDS = 20

# CSV header (case-insensitive) -> our field name. Verified against a real sample file - see
# module docstring for why Courier ctso, not Final Couriers, is the delivery_partner source.
CSV_COLUMNS = {
    "delivery_pincode": "pincode",
    "brand name": "brand",
    "order_date": "order_date",
    "courier ctso": "delivery_partner",
}


def parse_date_only(raw):
    """'03/09/2026 19:52:09' (day-first, time optional) -> '2026-09-03', or None if the date
    part isn't DD/MM/YYYY."""
    date_part = str(raw or "").strip().split(" ")[0]
    parts = date_part.split("/")
    if len(parts) != 3 or len(parts[0]) != 2 or len(parts[1]) != 2 or len(parts[2]) != 4:
        return None
    d, m, y = parts
    return f"{y}-{m}-{d}"


def normalize_key(pincode, brand, order_date, delivery_partner):
    """Case-insensitive match key - brand/delivery_partner casing in a hand-provided CSV isn't
    guaranteed to match what's stored; pincode/order_date have no such risk (see module
    docstring)."""
    return (str(pincode).strip(), str(brand).strip().upper(), str(order_date).strip(), str(delivery_partner).strip().upper())


def resolve_csv_columns(fieldnames):
    """Case-insensitive header lookup -> {our field name: actual CSV header string}, or raises
    with the missing header(s) named."""
    by_lower = {(h or "").strip().lower(): h for h in fieldnames or []}
    resolved = {}
    missing = []
    for header_lower, field in CSV_COLUMNS.items():
        if header_lower in by_lower:
            resolved[field] = by_lower[header_lower]
        else:
            missing.append(header_lower)
    if missing:
        raise SystemExit(f"CSV is missing required column(s): {', '.join(missing)}")
    return resolved


def count_matching_csv_rows(csv_path, wanted):
    """Streams csv_path once, counting rows whose normalized key is in `wanted` (a dict of
    normalized_key -> [(pincode, brand, order_date, delivery_partner), ...] original DB tuples).
    Returns {normalized_key: count}. Everything not in `wanted` is discarded immediately -
    O(len(wanted)) memory regardless of file size."""
    counts = {}
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        cols = resolve_csv_columns(reader.fieldnames)
        for row in reader:
            pincode = (row.get(cols["pincode"]) or "").strip()
            brand = (row.get(cols["brand"]) or "").strip()
            order_date = parse_date_only(row.get(cols["order_date"]))
            delivery_partner = (row.get(cols["delivery_partner"]) or "").strip()
            if not pincode or not brand or not order_date or not delivery_partner:
                continue
            key = normalize_key(pincode, brand, order_date, delivery_partner)
            if key in wanted:
                counts[key] = counts.get(key, 0) + 1
    return counts


def call_with_timeout(fn, timeout):
    outcome = {}

    def worker():
        try:
            outcome["result"] = fn()
        except Exception as e:  # noqa: BLE001 - re-raised on the calling thread below
            outcome["error"] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"call exceeded {timeout}s with no response")
    if "error" in outcome:
        raise outcome["error"]
    return outcome["result"]


def close_safely(conn, timeout=5):
    try:
        call_with_timeout(conn.close, timeout)
    except Exception:  # noqa: BLE001 - abandoning this connection either way
        pass


def connect():
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    for attempt in range(1, 4):
        try:
            return call_with_timeout(
                lambda: pymysql.connect(
                    host=cred["host"], user=cred["user"], password=cred["password"],
                    database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
                    read_timeout=180, write_timeout=180,
                ),
                CONNECT_WATCHDOG_SECONDS,
            )
        except TimeoutError:
            if attempt == 3:
                raise pymysql.err.OperationalError(
                    2003, f"connect() exceeded {CONNECT_WATCHDOG_SECONDS}s with no response")
            time.sleep(3)
        except (pymysql.err.OperationalError, OSError):
            if attempt == 3:
                raise
            time.sleep(3)


def execute_with_watchdog(conn, cur, sql, params, timeout=QUERY_WATCHDOG_SECONDS):
    try:
        call_with_timeout(lambda: cur.execute(sql, params), timeout)
    except TimeoutError:
        close_safely(conn)
        raise pymysql.err.OperationalError(
            2013, f"watchdog: query exceeded {timeout}s with no response, connection force-closed")


def run_with_retry(state, fn):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return fn(state["conn"], state["cur"])
        except pymysql.err.OperationalError as e:
            if attempt == MAX_ATTEMPTS:
                raise
            if e.args[0] in CONNECTION_LOST_ERRNOS:
                print(f"  connection lost ({e}) - reconnecting...")
                time.sleep(2)
                state["conn"] = connect()
                state["cur"] = state["conn"].cursor()
            else:
                wait = min(2 ** attempt, 30)
                print(f"  {e} - retrying in {wait}s...")
                time.sleep(wait)


def self_check():
    assert parse_date_only("03/09/2026 19:52:09") == "2026-09-03"
    assert parse_date_only("03/09/2026") == "2026-09-03"
    assert parse_date_only("2026-09-03") is None
    assert parse_date_only("") is None
    assert parse_date_only(None) is None

    assert normalize_key("110086", "Mcaffeine", "2026-09-03", "Pikndel_M_Rapid") == \
        ("110086", "MCAFFEINE", "2026-09-03", "PIKNDEL_M_RAPID")

    resolved = resolve_csv_columns(["Delivery_Pincode", "Brand Name", "order_date", "Courier ctso", "Final Couriers"])
    assert resolved == {
        "pincode": "Delivery_Pincode", "brand": "Brand Name",
        "order_date": "order_date", "delivery_partner": "Courier ctso",
    }
    try:
        resolve_csv_columns(["Delivery_Pincode"])
        raise AssertionError("expected SystemExit for missing columns")
    except SystemExit:
        pass

    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="Path to the raw per-shipment CSV.")
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()
    if not args.csv:
        raise SystemExit("--csv is required (or --self-check).")

    conn = connect()
    state = {"conn": conn, "cur": conn.cursor()}
    try:
        def do_select_combos(conn, cur):
            execute_with_watchdog(
                conn, cur,
                f"SELECT DISTINCT Pincode, brand, order_date, delivery_partner FROM `{TABLE}` "
                f"WHERE Pincode IS NOT NULL AND Pincode <> '' AND brand IS NOT NULL "
                f"AND order_date IS NOT NULL "
                f"AND delivery_partner IS NOT NULL AND delivery_partner <> ''",
                (),
            )
            return cur.fetchall()

        combos = run_with_retry(state, do_select_combos)
        print(f"{len(combos)} distinct (pincode, brand, order_date, delivery_partner) combo(s) in {SCHEMA}.{TABLE}.")

        wanted = {}
        for pincode, brand, order_date, delivery_partner in combos:
            key = normalize_key(pincode, brand, order_date.isoformat(), delivery_partner)
            wanted.setdefault(key, []).append((pincode, brand, order_date, delivery_partner))

        print(f"Scanning {args.csv} for matching rows...")
        counts = count_matching_csv_rows(args.csv, wanted)
        print(f"{len(counts)}/{len(wanted)} combo(s) found in the CSV.")

        items = [(orig, counts[key]) for key, origs in wanted.items() if key in counts for orig in origs]

        if not args.apply:
            print(f"\nDRY RUN - would update {len(items)} row group(s). Re-run with --apply to execute.")
            return

        updated = 0
        for i in range(0, len(items), UPDATE_CHUNK):
            chunk = items[i:i + UPDATE_CHUNK]

            def do_update(conn, cur, chunk=chunk):
                n = 0
                for (pincode, brand, order_date, delivery_partner), count in chunk:
                    execute_with_watchdog(
                        conn, cur,
                        f"UPDATE `{TABLE}` SET sales_Pincode = COALESCE(sales_Pincode, 0) + %s "
                        f"WHERE Pincode = %s AND brand = %s AND order_date = %s AND delivery_partner = %s",
                        (count, pincode, brand, order_date, delivery_partner),
                    )
                    n += cur.rowcount
                conn.commit()
                return n

            updated += run_with_retry(state, do_update)
            print(f"  batch {i // UPDATE_CHUNK + 1}/{-(-len(items) // UPDATE_CHUNK)}: done")

        print(f"\nDone - updated ~{updated} row(s) in {SCHEMA}.{TABLE}.")
    finally:
        close_safely(state["conn"])


if __name__ == "__main__":
    main()
