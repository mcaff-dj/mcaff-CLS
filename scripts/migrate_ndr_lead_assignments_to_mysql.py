#!/usr/bin/env python3
"""One-time data move: every row of Postgres `ndr_lead_assignments` into MySQL
PEP_CLS.ndr_lead_assignments (see api/_lib/db.js's bootstrapSchema), the same MySQL-over-
Postgres move lead_assignments already made onto CLS_RTO_calling (see
migrate_lead_assignments_to_cls_rto_calling.py) - but simpler, because unlike that table NDR
has only ever been written to Postgres. There is no live dual-write cutover race to reconcile
here: run this once, right after deploying the code change that points claimNdrLead/
disposeNdrLead/fetchAllNdrLeadDates/scripts/assign_ndr_leads.py's record_new_assignments at
MySQL, and every row moves over exactly as it was.

A lead CAN have more than one row (scripts/assign_ndr_leads.py's record_new_assignments
retires a lead's old live cycle before writing its new one on reassignment), so dedup is by
(awb_number, email, assigned_at) - the same natural key a retired-plus-live pair still
differs on - not by awb_number alone, which would silently drop every earlier cycle of a
reassigned lead.

Dry-run by default (prints counts + a sample); --apply performs the insert, in one
transaction. Does NOT delete anything from Postgres - verify the counts/spot-check MySQL
first.
"""
import argparse
import os
import sys
from pathlib import Path

import psycopg
import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "ndr_lead_assignments"

FETCH_ALL_SQL = """
SELECT awb_number, email, assigned_at, reassigned_away_at, disposed_at, disposition, agent_remarks
FROM ndr_lead_assignments
ORDER BY awb_number, assigned_at
"""

INSERT_COLUMNS = [
    "awb_number", "email", "assigned_at", "reassigned_away_at", "disposed_at",
    "disposition", "agent_remarks",
]
INSERT_SQL = (
    f"INSERT INTO `{TABLE}` ({', '.join(f'`{c}`' for c in INSERT_COLUMNS)}) "
    f"VALUES ({', '.join(['%s'] * len(INSERT_COLUMNS))})"
)


def fetch_postgres_rows():
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(FETCH_ALL_SQL)
            return cur.fetchall()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    pg_rows = fetch_postgres_rows()
    print(f"Fetched {len(pg_rows)} row(s) from Postgres ndr_lead_assignments.")

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT awb_number, email, assigned_at FROM `{TABLE}`")
        existing = set(cur.fetchall())
        print(f"{len(existing)} row(s) already present in {SCHEMA}.{TABLE}.")

        to_insert = [row for row in pg_rows if (row[0], row[1], row[2]) not in existing]
        print(f"\n  new rows to insert : {len(to_insert)}")
        if to_insert:
            print("\n  sample of rows to insert:")
            for r in to_insert[:5]:
                print(f"      awb_number={r[0]!r} email={r[1]!r} assigned_at={r[2]} disposed_at={r[4]}")

        if not args.apply:
            print(f"\nDRY RUN - nothing written. Re-run with --apply to write {len(to_insert)} insert(s).")
            return

        if to_insert:
            cur.executemany(INSERT_SQL, to_insert)
        conn.commit()
        print(f"\nApplied {len(to_insert)} insert(s) to {SCHEMA}.{TABLE}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
