"""One-off: backfills rto_reason for PEP_CLS.CLS_RTO_calling rows left NULL because
assign_leads.py did not stamp it at assignment time until commit 25be910
(2026-07-28) - every row assigned before that landed with no rto_reason at all, and
the disposal-time fallback (api/_lib/db.js's recordLeadDisposition, COALESCE onto
whatever the disposing client sent) evidently did not fill the gap for most of them
either. 1670 of 3551 live rows were affected as of 2026-07-30, back when this data
still lived on Postgres lead_assignments (see migrate_lead_assignments_to_cls_rto_calling.py).

Looks each row's order_id up against the RTO 'Data' sheet's RTO Reason column (D,
index 3 - see scripts/lead_priority.py's COL_RTO_REASON), the same source
assign_leads.py itself reads from at assignment time.

THIS IS A PROXY, NOT A RECOVERY. The sheet only has TODAY's value; there is no
historical record of what Column D said back when each of these leads was assigned,
and this table has never stored it either. rto_reason is documented (COL_RTO_REASON's
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib
from lead_priority import COL_ORDER_ID, COL_RTO_REASON, cell

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"
SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"


def build_rto_reason_by_order_id():
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AD")
    mapping = {}
    for row in values:
        order_id = cell(row, COL_ORDER_ID)
        rto_reason = cell(row, COL_RTO_REASON)
        if order_id and rto_reason:
            mapping[order_id] = rto_reason
    return mapping


def fetch_missing():
    rows = mysql_lib.query(f"SELECT DISTINCT order_id FROM `{TABLE}` WHERE rto_reason IS NULL", database=SCHEMA)
    return [row[0] for row in rows]


def main():
    if mysql_lib.get_credential() is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    rto_reason_by_order_id = build_rto_reason_by_order_id()
    print(f"Loaded {len(rto_reason_by_order_id)} order_id -> RTO Reason mappings from the sheet.")

    missing = fetch_missing()
    print(f"Found {len(missing)} distinct order_id(s) in {SCHEMA}.{TABLE} with rto_reason still NULL.")

    # Resolved against the sheet up front, same as before - only the write below changed.
    pairs = []  # (rto_reason, order_id)
    not_found = 0
    for order_id in missing:
        rto_reason = rto_reason_by_order_id.get(order_id)
        if not rto_reason:
            not_found += 1
            continue
        pairs.append((rto_reason, order_id))

    # Batched via executemany instead of one UPDATE + one commit per order_id - on a table
    # with thousands of NULL rows, the per-row round trip (plus fsync per commit) was the
    # entire cost of this script. CHUNK_SIZE keeps each transaction a bounded size rather
    # than one all-or-nothing commit for the whole backfill, so a mid-run failure only loses
    # the current chunk's progress, not everything already written.
    CHUNK_SIZE = 500
    updated_orders = 0
    for start in range(0, len(pairs), CHUNK_SIZE):
        chunk = pairs[start:start + CHUNK_SIZE]
        mysql_lib.executemany(
            f"UPDATE `{TABLE}` SET rto_reason = %s WHERE order_id = %s AND rto_reason IS NULL",
            chunk,
            database=SCHEMA,
        )
        updated_orders += len(chunk)

    # Row count (as opposed to order_id count) isn't tracked anymore - rto_reason is
    # order-level (see this script's own docstring: the same value can land on several
    # physical rows sharing an order_id), and executemany's rowcount only reflects the last
    # statement in a batch, not an aggregate - getting a precise row total back would cost
    # an extra query per order_id, not worth it for a print statement in a one-off script.
    print(f"Backfilled rto_reason for {updated_orders} order_id(s).")
    print(f"{not_found} order_id(s) had no RTO Reason in the sheet (or are no longer present) - left NULL.")


if __name__ == "__main__":
    main()
