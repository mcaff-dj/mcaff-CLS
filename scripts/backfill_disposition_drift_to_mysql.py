#!/usr/bin/env python3
"""One-off: backfills CLS_RTO_calling rows where the sheet already shows a disposition
(Column T) but MySQL's live cycle for that order_id still has disposed_at NULL -
recordLeadDisposition's DB-side write never landed, even though the sheet write (which
always happens first and independently, see RtoCrmClient.js's submitDisp) succeeded.

Found via manual investigation on 2026-08-14 (agents reporting stale quota/assignment
behavior): 51 of 294 live-pending MySQL rows across 7 agents were actually already
disposed in the sheet. Confirmed PRE-EXISTING, not caused by the Postgres->MySQL
migration - the same gap existed in Postgres for these same order_ids (checked directly),
dating back to Aug 1-8. submitDisp already retries the DB write once and shows the agent
a "database sync failed" toast on failure (see its own comment) - this backfill covers
rows disposed before that safety net existed, or where the agent saw the toast and moved
on without retrying.

THIS IS A BACKFILL, NOT A RECOVERY: the true historical disposed_at is unrecoverable (the
sheet doesn't store one), so it's stamped as the time this script ran - an explicit
approximation, not fabricated history, same convention as the NDR backfill that fixed an
equivalent gap (see lambda/README.md's incident note). refund_amount is deliberately left
untouched: dispTkt.orderAmount (the sheet's order-amount field) isn't in this script's
column set and financial data isn't worth guessing at.

Only writes when the sheet's own Column T is non-blank - an order_id whose row is missing
now, or genuinely still undisposed, is left alone.

Dry-run by default; --apply performs the writes, all in one transaction.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import pymysql
from lead_priority import (
    COL_ATTEMPT, COL_AWB_CODE, COL_CONNECTED, COL_DISPOSITION, COL_NEW_ORDER_ID,
    COL_ORDER_ID, COL_REMARKS, COL_RTO_REASON, cell, prefix_rule_partner,
)
from mysql_lib import get_credential

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"
SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"

UPDATE_SQL = f"""
UPDATE `{TABLE}` SET
    disposed_at = NOW(),
    disposition = %s,
    agent_remarks = %s,
    connected = %s,
    attempt = %s,
    awb_code = COALESCE(awb_code, %s),
    rto_reason = COALESCE(rto_reason, %s),
    delivery_partner = COALESCE(delivery_partner, %s),
    new_order_id = COALESCE(new_order_id, %s)
WHERE order_id = %s AND reassigned_away_at IS NULL AND disposed_at IS NULL
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT order_id, agent_email FROM `{TABLE}` WHERE reassigned_away_at IS NULL AND disposed_at IS NULL")
        mysql_pending = dict(cur.fetchall())
        print(f"{len(mysql_pending)} live-pending row(s) in MySQL across all agents.")

        values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AD")
        updates = []
        for row in values:
            order_id = cell(row, COL_ORDER_ID)
            if order_id not in mysql_pending:
                continue
            disposition = cell(row, COL_DISPOSITION)
            if not disposition:
                continue
            awb_code = cell(row, COL_AWB_CODE) or None
            updates.append((
                disposition,
                cell(row, COL_REMARKS) or None,
                cell(row, COL_CONNECTED) or None,
                cell(row, COL_ATTEMPT) or None,
                awb_code,
                cell(row, COL_RTO_REASON) or None,
                prefix_rule_partner(awb_code) or None,
                cell(row, COL_NEW_ORDER_ID) or None,
                order_id,
            ))

        print(f"\n{len(updates)} drifted row(s) found (sheet disposed, MySQL still pending):")
        from collections import Counter
        by_agent = Counter(mysql_pending[u[-1]] for u in updates)
        for agent, count in by_agent.most_common():
            print(f"    {agent}: {count}")

        if not updates:
            print("\nNothing to backfill.")
            return

        if not args.apply:
            print(f"\nDRY RUN - nothing written. Re-run with --apply to backfill {len(updates)} row(s).")
            return

        cur.executemany(UPDATE_SQL, updates)
        affected = cur.rowcount
        conn.commit()
        print(f"\nBackfilled {affected} row(s) in {SCHEMA}.{TABLE} (attempted {len(updates)}).")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
