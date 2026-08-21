#!/usr/bin/env python3
"""One-time data move: every row of Postgres `rto_csv_upload_jobs` into MySQL
PEP_CLS.rto_csv_upload_jobs (see api/_lib/db.js's bootstrapSchema) - the same MySQL-over-
Postgres move already made for the other RTO CRM operational tables.

This table only ever holds SHORT-LIVED job state (a CSV upload's progress, cleared to a
terminal 'done'/'failed' status within minutes) - by the time this runs, every existing row
is expected to already be terminal, so this is a plain one-shot copy keyed by id, not a
merge against live in-flight jobs. Re-running after a partial apply just re-upserts the same
rows.

Dry-run by default (prints counts + a sample); --apply performs the writes, all in one
transaction. Does NOT delete anything from Postgres - verify the counts/spot-check MySQL
first.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import psycopg
import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "rto_csv_upload_jobs"

FETCH_SQL = """
SELECT id, status, created_by, created_at, updated_at, total_rows, prepaid_count,
       checked_count, already_refunded_count, already_punched_count, appended_count,
       duplicate_in_sheet_count, duplicate_in_file_count, missing_awb_count, rows_pending,
       errors, error_message
FROM rto_csv_upload_jobs
ORDER BY id
"""

INSERT_COLUMNS = [
    "id", "status", "created_by", "created_at", "updated_at", "total_rows", "prepaid_count",
    "checked_count", "already_refunded_count", "already_punched_count", "appended_count",
    "duplicate_in_sheet_count", "duplicate_in_file_count", "missing_awb_count", "rows_pending",
    "errors", "error_message",
]
UPSERT_SQL = (
    f"INSERT INTO `{TABLE}` ({', '.join(f'`{c}`' for c in INSERT_COLUMNS)}) "
    f"VALUES ({', '.join(['%s'] * len(INSERT_COLUMNS))}) "
    "ON DUPLICATE KEY UPDATE "
    + ", ".join(f"`{c}` = VALUES(`{c}`)" for c in INSERT_COLUMNS if c != "id")
)


def fetch_postgres_rows():
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(FETCH_SQL)
            return cur.fetchall()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    pg_rows = fetch_postgres_rows()
    print(f"Fetched {len(pg_rows)} row(s) from Postgres rto_csv_upload_jobs.")
    non_terminal = [r for r in pg_rows if r[1] not in ("done", "failed")]
    if non_terminal:
        print(f"\n  WARNING: {len(non_terminal)} row(s) are NOT in a terminal status "
              f"(done/failed) - a job still running against Postgres at cutover time will not "
              f"be picked up by the MySQL-reading worker after this deploy. IDs: "
              f"{[r[0] for r in non_terminal]}")

    if pg_rows:
        print("\n  sample row(s):")
        for r in pg_rows[:3]:
            print(f"      id={r[0]!r} status={r[1]!r} created_by={r[2]!r} total_rows={r[5]!r}")

    if not args.apply:
        print(f"\nDRY RUN - nothing written. Re-run with --apply to upsert {len(pg_rows)} row(s).")
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
        rows = [
            tuple(
                json.dumps(v) if col in ("rows_pending", "errors") and v is not None else v
                for col, v in zip(INSERT_COLUMNS, r)
            )
            for r in pg_rows
        ]
        if rows:
            cur.executemany(UPSERT_SQL, rows)
        conn.commit()
        print(f"\nApplied {len(rows)} row(s) to {SCHEMA}.{TABLE}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
