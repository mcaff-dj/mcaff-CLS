"""One-off: backfills rto_reason for Postgres lead_assignments rows left NULL because
assign_leads.py did not stamp it at assignment time until commit 25be910
(2026-07-28) - every row assigned before that landed with no rto_reason at all, and
the disposal-time fallback (api/_lib/db.js's recordLeadDisposition, COALESCE onto
whatever the disposing client sent) evidently did not fill the gap for most of them
either. 1670 of 3551 live rows were affected as of 2026-07-30.

Looks each row's order_id up against the RTO 'Data' sheet's RTO Reason column (D,
index 3 - see scripts/lead_priority.py's COL_RTO_REASON), the same source
assign_leads.py itself reads from at assignment time.

THIS IS A PROXY, NOT A RECOVERY. The sheet only has TODAY's value; there is no
historical record of what Column D said back when each of these leads was assigned,
and Postgres has never stored it either. rto_reason is documented (COL_RTO_REASON's
own comment) as "the ORIGINAL system/courier RTO reason" - a fact about the order
from the courier/return system, not something that changes with which agent is
calling - so today's value is expected to still be correct, but that is an
assumption this script is making on your behalf, not something it can verify.

NOT SCOPED to live cycles only (contrast backfill_awb_code.py). rto_reason carries
no uniqueness constraint, and being an order-level fact rather than a per-agent-
attempt one, the same sheet value is written to every row - live or retired - still
missing it for that order_id, including the legacy rows folded in from the old
lead_reassignment_attempts table.

Only writes when a match is found in the sheet - an order_id no longer present
(e.g. archived) is left NULL rather than guessed at.
"""
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from lead_priority import COL_ORDER_ID, COL_RTO_REASON, cell

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"


def build_rto_reason_by_order_id():
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AD")
    mapping = {}
    for row in values:
        order_id = cell(row, COL_ORDER_ID)
        rto_reason = cell(row, COL_RTO_REASON)
        if order_id and rto_reason:
            mapping[order_id] = rto_reason
    return mapping


def fetch_missing(conn_str):
    with psycopg.connect(conn_str, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT order_id FROM lead_assignments WHERE rto_reason IS NULL")
            return [row[0] for row in cur.fetchall()]


def main(conn_str):
    rto_reason_by_order_id = build_rto_reason_by_order_id()
    print(f"Loaded {len(rto_reason_by_order_id)} order_id -> RTO Reason mappings from the sheet.")

    missing = fetch_missing(conn_str)
    print(f"Found {len(missing)} distinct order_id(s) in Postgres with rto_reason still NULL.")

    updated_orders, updated_rows, not_found = 0, 0, 0

    # prepare_threshold=None: POSTGRES_URL is Supabase's pooled (PgBouncer transaction-mode)
    # endpoint - psycopg3's default server-side prepared-statement caching can collide with
    # another session's leftover statement on the same pooled backend
    # (psycopg.errors.DuplicatePreparedStatement). See backfill_delivery_partner.py, which hit
    # this for real.
    with psycopg.connect(conn_str, prepare_threshold=None) as conn:
        for order_id in missing:
            rto_reason = rto_reason_by_order_id.get(order_id)
            if not rto_reason:
                not_found += 1
                continue
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE lead_assignments SET rto_reason = %s "
                    "WHERE order_id = %s AND rto_reason IS NULL",
                    (rto_reason, order_id),
                )
                updated_rows += cur.rowcount
            conn.commit()
            updated_orders += 1

    print(f"Backfilled {updated_rows} row(s) across {updated_orders} distinct order_id(s).")
    print(f"{not_found} order_id(s) had no RTO Reason in the sheet (or are no longer present) - left NULL.")


if __name__ == "__main__":
    import os
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    main(conn_str)
