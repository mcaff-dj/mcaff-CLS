"""One-off: reads the escalation Sheet's T:W columns (New Order Id / AWB / Status / Notes) and
writes them into escalation_lead_assignments' resolution columns in Postgres, preserving
historical resolutions before the app stops reading the Sheet (see
docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md's Migration
section). Run once, by hand, before Task 9's cutover - not on a schedule.

Only writes rows the Sheet shows as resolved (column V/status non-blank). Idempotent: COALESCE
in the UPDATE means a second run never clobbers a value already set, so a partial failure can be
safely re-run in full.
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
SHEET_TABS = ["HYPHEN", "mCaffeine"]
# A:Z column order, same as sync_escalation_sheet_to_bq.py's SHEET_COLUMNS.
COL_PARENT_ORDER = 3    # D
COL_NEW_ORDER_ID = 19   # T
COL_NEW_AWB = 20        # U
COL_STATUS = 21         # V
COL_NOTES = 22          # W

# api/_lib/db.js's getPgPool() reads this exact env var (confirmed by reading it, not assumed).
POSTGRES_ENV_VAR = "POSTGRES_URL"


def read_resolved_rows():
    """[(parent_order, new_order_id, new_awb, status, notes), ...] for every sheet row with a
    non-blank status (column V) - "resolved" per the same rule escalationSheet.getEligibleOrders
    used (blank status = still pending, not migrated)."""
    out = []
    for tab in SHEET_TABS:
        values = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!A2:Z")
        for row in values:
            status = row[COL_STATUS] if len(row) > COL_STATUS else ""
            if not status:
                continue
            parent_order = row[COL_PARENT_ORDER] if len(row) > COL_PARENT_ORDER else ""
            if not parent_order:
                continue
            new_order_id = row[COL_NEW_ORDER_ID] if len(row) > COL_NEW_ORDER_ID else ""
            new_awb = row[COL_NEW_AWB] if len(row) > COL_NEW_AWB else ""
            notes = row[COL_NOTES] if len(row) > COL_NOTES else ""
            out.append((parent_order, new_order_id, new_awb, status, notes))
    return out


def migrate(dry_run):
    rows = read_resolved_rows()
    print(f"  {len(rows)} resolved row(s) found in the sheet")
    if dry_run:
        for r in rows[:5]:
            print("   ", r)
        if len(rows) > 5:
            print(f"    ... and {len(rows) - 5} more")
        return

    conn_str = os.environ[POSTGRES_ENV_VAR]
    conn = lib.get_pg_connection(conn_str)
    migrated = 0
    try:
        with conn.cursor() as cur:
            for parent_order, new_order_id, new_awb, status, notes in rows:
                cur.execute(
                    """
                    UPDATE escalation_lead_assignments
                    SET resolved_at = COALESCE(resolved_at, now()),
                        resolution = COALESCE(resolution, %s),
                        agent_remarks = COALESCE(agent_remarks, %s),
                        new_order_id = COALESCE(new_order_id, %s),
                        new_awb = COALESCE(new_awb, %s)
                    WHERE parent_order = %s
                    """,
                    (status, notes, new_order_id, new_awb, parent_order),
                )
                if cur.rowcount == 0:
                    cur.execute(
                        """
                        INSERT INTO escalation_lead_assignments
                          (parent_order, email, resolved_at, resolution, agent_remarks, new_order_id, new_awb)
                        VALUES (%s, NULL, now(), %s, %s, %s, %s)
                        """,
                        (parent_order, status, notes, new_order_id, new_awb),
                    )
                migrated += 1
        conn.commit()
    finally:
        conn.close()
    print(f"  migrated {migrated} row(s)")


def reconcile():
    """Prints resolved-row counts, sheet vs Postgres, so a mismatch is visible before cutover."""
    sheet_resolved = len(read_resolved_rows())
    conn_str = os.environ[POSTGRES_ENV_VAR]
    conn = lib.get_pg_connection(conn_str)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM escalation_lead_assignments WHERE resolved_at IS NOT NULL")
            pg_resolved = cur.fetchone()[0]
    finally:
        conn.close()
    print(f"  sheet resolved rows:    {sheet_resolved}")
    print(f"  postgres resolved rows: {pg_resolved}")
    if sheet_resolved != pg_resolved:
        print("  MISMATCH - do not cut over until this is understood")
        sys.exit(1)
    print("  counts match")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Read and print only, no Postgres writes")
    parser.add_argument("--reconcile", action="store_true", help="Compare resolved-row counts, sheet vs Postgres, and exit")
    args = parser.parse_args()
    if args.reconcile:
        return reconcile()
    migrate(args.dry_run)


if __name__ == "__main__":
    main()
