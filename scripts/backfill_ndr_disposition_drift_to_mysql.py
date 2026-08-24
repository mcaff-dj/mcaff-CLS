#!/usr/bin/env python3
"""NDR's own equivalent of backfill_disposition_drift_to_mysql.py (that one's RTO-only -
see its docstring for the original incident). Same gap, different table: the sheet's
Connected column (T) already shows a lead as worked, but ndr_lead_assignments still has
disposed_at NULL for it - either disposeNdrLead's UPDATE matched zero rows (no live row
ever existed, e.g. a pre-existing sheet assignment from before this app/table existed, so
claimNdrLead's INSERT never ran for it), or the DB write was fired-and-forgotten and
silently failed (recordNdrLeadAssignment never throws - see NdrCallingClient.js's own
comment on that call).

THIS IS A BACKFILL, NOT A RECOVERY: the sheet has no historical disposed_at, so it's
stamped as the time this script ran. disposition is reconstructed from the sheet's own
Outcome column (U) when present (the most specific category the sheet actually records),
falling back to the Connected value (T) otherwise - not the exact top-level category the
Call modal's own disposeNdrLead call would have sent, since the sheet doesn't retain that,
but enough to tell a real disposition apart from "still open" when querying MySQL.

Only writes when the sheet's own Column T (Connected) is non-blank - a row missing from
the sheet now, or genuinely still undisposed, is left alone.

Dry-run by default; --apply performs the writes, all in one transaction.
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import pymysql
from mysql_lib import get_credential

SPREADSHEET_ID = "12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI"
SHEET_TAB = "Latest NDR "
SCHEMA = "PEP_CLS"
TABLE = "ndr_lead_assignments"

COL_AWB = 4
COL_CONNECTED = 19
COL_OUTCOME = 20
COL_REMARKS = 27

UPDATE_SQL = f"""
UPDATE `{TABLE}` SET
    disposed_at = NOW(),
    disposition = %s,
    agent_remarks = %s
WHERE awb_number = %s AND reassigned_away_at IS NULL AND disposed_at IS NULL
"""


def cell(row, idx):
    return row[idx].strip() if idx < len(row) and row[idx] else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    ap.add_argument("--email", help="Only backfill rows currently held by this agent email.")
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
        where_email = "AND email = %s" if args.email else ""
        params = (args.email,) if args.email else ()
        cur.execute(
            f"SELECT awb_number, email FROM `{TABLE}` WHERE reassigned_away_at IS NULL AND disposed_at IS NULL {where_email}",
            params,
        )
        mysql_pending = dict(cur.fetchall())
        print(f"{len(mysql_pending)} live-pending row(s) in MySQL" + (f" for {args.email}" if args.email else " across all agents") + ".")

        values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AD1000000")
        updates = []
        for row in values:
            awb = cell(row, COL_AWB)
            if awb not in mysql_pending:
                continue
            connected = cell(row, COL_CONNECTED)
            if not connected:
                continue
            disposition = cell(row, COL_OUTCOME) or connected
            updates.append((disposition, cell(row, COL_REMARKS) or None, awb))

        print(f"\n{len(updates)} drifted row(s) found (sheet disposed, MySQL still pending):")
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
