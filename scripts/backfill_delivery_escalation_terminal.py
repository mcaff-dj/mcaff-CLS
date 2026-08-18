#!/usr/bin/env python3
"""One-off backfill: every existing HYPHEN/mCaffeine sheet row already marked Delivered or RTO
by logistics (column Q, "Update from Logistcs front(as per order id)" - the ONLY column that
actually distinguishes Delivered from RTO; "Status as per AWB" never has RTO, see the
conversation that led here) gets a row in MySQL PEP_CLS.Delivery_escalation, the same table
DeliveryEscalationClient.js's saveAction writes to for a live terminal dispose.

Historical, not agent-worked: none of these ~28k rows were ever claimed or resolved through
this app, so agent_email/assigned_at/disposed_at are left NULL rather than inventing an
attribution or a disposal timestamp this data doesn't have. outcome is set to column Q's own
value ("Delivered" or "RTO") verbatim - the same string TERMINAL_OUTCOMES in
DeliveryEscalationClient.js checks against.

Deliberately does NOT touch the Google Sheet itself (no Agent Name/Outcome/Remarks written to
AA-AD) - this is a MySQL-only backfill, per explicit instruction. Rows with a blank order_id
are skipped (would violate Delivery_escalation's NOT NULL order_id) and counted, not silently
dropped.

Ticket Number (sheet column Z) is blank on a real chunk of rows - 4,075/17,097 HYPHEN, 5,346/
10,870 mCaffeine, verified against the live sheet. Since scripts/alter_delivery_escalation_
dedup_key.py keys uniqueness off (brand, ticket_number) [falling back to (brand, awb_code) only
when ticket_number is genuinely blank], a blank ticket_number would otherwise collapse every
query on that AWB into one row - the opposite of "keep every ticket". So a blank one gets a
SYNTHETIC ticket number instead: SYN-<16 hex chars> of a SHA1 over this row's own stable fields
(tab, order_id, awb, added/query dates, query category, status as per AWB, delivered date, solv
date, TAT). Deterministic - the same sheet row produces the same synthetic id on every re-run,
so re-running this script stays a safe upsert, not a pile of new duplicate rows. Verified
zero collisions among all 9,421 blank-ticket-number rows before this was wired in.

Dry-run by default (prints counts + a sample); --apply performs the upserts, chunked via
executemany.
"""
import argparse
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import get_sheet_rows_chunked
from mysql_lib import get_credential

SHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
TABS = ["HYPHEN", "mCaffeine"]
LAST_COL = "Z"
TERMINAL_OUTCOMES = {"Delivered", "RTO"}

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"

UPSERT_SQL = f"""
INSERT INTO `{TABLE}`
  (brand, order_id, ticket_number, awb_code, delivery_partner, query_class, query_category,
   wh_name, status_as_per_awb, tat, outcome)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id),
  ticket_number = VALUES(ticket_number),
  delivery_partner = VALUES(delivery_partner),
  query_class = VALUES(query_class),
  query_category = VALUES(query_category),
  wh_name = VALUES(wh_name),
  status_as_per_awb = VALUES(status_as_per_awb),
  tat = VALUES(tat),
  outcome = VALUES(outcome)
"""


def v(row, i):
    return row[i].strip() if i < len(row) and row[i] is not None else ""


def synthetic_ticket_number(tab, row):
    basis = "|".join([
        tab, v(row, 3), v(row, 4), v(row, 0), v(row, 8), v(row, 2),
        v(row, 13), v(row, 12), v(row, 14), v(row, 15),
    ])
    return "SYN-" + hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


def collect_rows(tab):
    """Returns (upsert_tuples, skipped_blank_order_id, synthetic_ticket_count)."""
    raw_rows = get_sheet_rows_chunked(SHEET_ID, tab, LAST_COL)
    out, skipped_order, synthetic_count = [], 0, 0
    for row in raw_rows:
        logistics = v(row, 16)
        if logistics not in TERMINAL_OUTCOMES:
            continue
        order_id = v(row, 3)
        if not order_id:
            skipped_order += 1
            continue
        awb = v(row, 4) or None
        ticket_number = v(row, 25)
        if not ticket_number:
            ticket_number = synthetic_ticket_number(tab, row)
            synthetic_count += 1
        out.append((
            tab, order_id, ticket_number, awb, v(row, 5) or None, v(row, 1) or None,
            v(row, 2) or None, v(row, 10) or None, v(row, 13) or None, v(row, 15) or None,
            logistics,
        ))
    return out, skipped_order, synthetic_count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the upserts (default is a dry run).")
    ap.add_argument("--chunk-size", type=int, default=1000)
    args = ap.parse_args()

    all_rows = []
    for tab in TABS:
        print(f"\nReading {tab}...")
        rows, skipped_order, synthetic_count = collect_rows(tab)
        print(f"  {tab}: {len(rows)} Delivered/RTO row(s) to upsert"
              f" ({skipped_order} skipped for blank order_id, {synthetic_count} given a synthetic ticket_number)")
        by_outcome = {}
        for r in rows:
            by_outcome[r[-1]] = by_outcome.get(r[-1], 0) + 1
        print(f"    breakdown: {by_outcome}")
        all_rows.extend(rows)

    print(f"\n{len(all_rows)} row(s) total across both tabs.")
    if all_rows:
        print("\nSample row that would be upserted:")
        cols = ["brand", "order_id", "ticket_number", "awb_code", "delivery_partner",
                "query_class", "query_category", "wh_name", "status_as_per_awb", "tat", "outcome"]
        for col, val in zip(cols, all_rows[0]):
            print(f"    {col}: {val!r}")

    if not args.apply:
        print("\nDRY RUN - nothing written. Re-run with --apply to upsert into MySQL.")
        return

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        read_timeout=180, write_timeout=180,
    )
    try:
        cur = conn.cursor()
        written = 0
        for i in range(0, len(all_rows), args.chunk_size):
            chunk = all_rows[i:i + args.chunk_size]
            cur.executemany(UPSERT_SQL, chunk)
            conn.commit()
            written += len(chunk)
            print(f"  upserted {written}/{len(all_rows)}")
        print(f"\nDone - upserted {written} row(s) into {SCHEMA}.{TABLE}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
