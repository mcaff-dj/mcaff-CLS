#!/usr/bin/env python3
"""One-off DDL: adds the columns sync_delivery_tickets_to_sheet.py needs to mirror its
job-inserted rows into PEP_CLS.Delivery_escalation (ticket_number, added_date, order_date,
order_month, query_date, query_month) - the same 6 fields that script writes into the sheet's
A/G/H/I/J columns and Z, alongside the ones the table already has (brand, order_id, awb_code,
delivery_partner, query_class, query_category, wh_name - see create_delivery_escalation_table.py).

Nothing here touches the dispose-flow columns (agent_email, assigned_at, disposed_at, outcome,
agent_remarks, resolved_date, status_as_per_awb, tat) - those stay exactly as
api/_lib/db.js's disposeDeliveryEscalationTicket already uses them.

Dry-run by default; --apply performs the DDL. Idempotent - skips any column already present.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"

NEW_COLUMNS = [
    ("ticket_number", "VARCHAR(64) NULL"),
    ("added_date", "DATE NULL"),
    ("order_date", "DATE NULL"),
    ("order_month", "VARCHAR(16) NULL"),
    ("query_date", "DATE NULL"),
    ("query_month", "VARCHAR(16) NULL"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DDL (default is a dry run).")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s",
            (SCHEMA, TABLE),
        )
        existing = {r[0] for r in cur.fetchall()}
        missing = [(name, ddl) for name, ddl in NEW_COLUMNS if name not in existing]
        if not missing:
            print(f"All sync columns already present on {SCHEMA}.{TABLE} - nothing to do.")
            return

        add_clause = ", ".join(f"ADD COLUMN `{name}` {ddl}" for name, ddl in missing)
        stmt = f"ALTER TABLE `{TABLE}` {add_clause}"
        print(f"{'Applying' if args.apply else 'DRY RUN - would apply'}:\n\n{stmt}\n")
        if not args.apply:
            print("Re-run with --apply to execute.")
            return

        cur.execute(stmt)
        conn.commit()
        print(f"Added {', '.join(name for name, _ in missing)} to {SCHEMA}.{TABLE}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
