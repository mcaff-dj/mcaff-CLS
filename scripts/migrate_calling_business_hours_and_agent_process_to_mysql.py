#!/usr/bin/env python3
"""One-time data move: every row of Postgres `calling_business_hours` and
`calling_agent_process` into MySQL PEP_CLS (see api/_lib/db.js's bootstrapSchema) - the same
MySQL-over-Postgres move already made for ndr_lead_assignments/calling_process_dispositions.

Both tables are current-state snapshots (no history, no reassignment cycles - unlike
ndr_lead_assignments), so this is a plain upsert on each table's own primary key:
(process_key, day) for calling_business_hours, (email, process_key) for
calling_agent_process. Re-running after a partial apply, or after the app has already
written a few post-cutover rows into MySQL, just re-upserts the same rows - safe either way.

Dry-run by default (prints counts + a sample of each table); --apply performs the writes,
all in one transaction. Does NOT delete anything from Postgres - verify the counts/spot-check
MySQL first.
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

BUSINESS_HOURS_FETCH_SQL = """
SELECT process_key, day, open_time, close_time, updated_at, updated_by
FROM calling_business_hours
ORDER BY process_key, day
"""
BUSINESS_HOURS_UPSERT_SQL = """
INSERT INTO calling_business_hours (process_key, day, open_time, close_time, updated_at, updated_by)
VALUES (%s, %s, %s, %s, %s, %s)
ON DUPLICATE KEY UPDATE
    open_time = VALUES(open_time), close_time = VALUES(close_time),
    updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)
"""

AGENT_PROCESS_FETCH_SQL = """
SELECT email, process_key, status, max_quota, is_process_admin, prepaid_pct,
       priority_rto_reasons, reassign_payment_mode, attempt_count_filter, ndr_reason_filter,
       ndr_payment_mode_filter, ndr_brand_filter, updated_at, updated_by
FROM calling_agent_process
ORDER BY process_key, email
"""
AGENT_PROCESS_UPSERT_SQL = """
INSERT INTO calling_agent_process
    (email, process_key, status, max_quota, is_process_admin, prepaid_pct,
     priority_rto_reasons, reassign_payment_mode, attempt_count_filter, ndr_reason_filter,
     ndr_payment_mode_filter, ndr_brand_filter, updated_at, updated_by)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON DUPLICATE KEY UPDATE
    status = VALUES(status), max_quota = VALUES(max_quota),
    is_process_admin = VALUES(is_process_admin), prepaid_pct = VALUES(prepaid_pct),
    priority_rto_reasons = VALUES(priority_rto_reasons),
    reassign_payment_mode = VALUES(reassign_payment_mode),
    attempt_count_filter = VALUES(attempt_count_filter),
    ndr_reason_filter = VALUES(ndr_reason_filter),
    ndr_payment_mode_filter = VALUES(ndr_payment_mode_filter),
    ndr_brand_filter = VALUES(ndr_brand_filter),
    updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)
"""


def fetch_postgres_rows():
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(BUSINESS_HOURS_FETCH_SQL)
            hours_rows = cur.fetchall()
            cur.execute(AGENT_PROCESS_FETCH_SQL)
            process_rows = cur.fetchall()
    return hours_rows, process_rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    hours_rows, process_rows = fetch_postgres_rows()
    print(f"Fetched {len(hours_rows)} row(s) from Postgres calling_business_hours.")
    print(f"Fetched {len(process_rows)} row(s) from Postgres calling_agent_process.")

    if hours_rows:
        print("\n  sample calling_business_hours row(s):")
        for r in hours_rows[:3]:
            print(f"      process_key={r[0]!r} day={r[1]!r} open={r[2]!r} close={r[3]!r}")
    if process_rows:
        print("\n  sample calling_agent_process row(s):")
        for r in process_rows[:3]:
            print(f"      email={r[0]!r} process_key={r[1]!r} status={r[2]!r} max_quota={r[3]!r}")

    if not args.apply:
        print(f"\nDRY RUN - nothing written. Re-run with --apply to upsert "
              f"{len(hours_rows)} + {len(process_rows)} row(s).")
        return

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        if hours_rows:
            cur.executemany(BUSINESS_HOURS_UPSERT_SQL, hours_rows)
        if process_rows:
            cur.executemany(AGENT_PROCESS_UPSERT_SQL, process_rows)
        conn.commit()
        print(f"\nApplied {len(hours_rows)} calling_business_hours row(s) and "
              f"{len(process_rows)} calling_agent_process row(s) to {SCHEMA}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
