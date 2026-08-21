#!/usr/bin/env python3
"""One-time data move: every row of Postgres `order_punch_jobs`, `order_punch_job_rows`, and
`order_punch_settings` into MySQL PEP_CLS (see api/_lib/db.js's bootstrapSchema) - the same
MySQL-over-Postgres move already made for the other RTO CRM operational tables.

order_punch_jobs/order_punch_job_rows are short-lived job state, same reasoning as
migrate_rto_csv_upload_jobs_to_mysql.py - by the time this runs, existing jobs are expected to
already be terminal ('done'/'failed'/'stopped'). order_punch_settings is small, admin-edited
config - upserted so an admin's Postgres-side edit made after this script's Postgres read but
before deploy isn't silently reverted by re-running with --apply a second time (idempotent).

Jobs and rows are inserted together, in submission order, preserving each job's original id
(so a job URL/reference already shared stays valid) - IDs are trusted to not collide since
MySQL's AUTO_INCREMENT starts fresh and this is a one-time move before any MySQL-side job is
ever created.

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

JOBS_FETCH_SQL = """
SELECT id, status, created_by, created_at, updated_at, total_rows, processed_count,
       success_count, error_count, skipped_count, stop_requested, error_message
FROM order_punch_jobs ORDER BY id
"""
JOBS_INSERT_COLUMNS = [
    "id", "status", "created_by", "created_at", "updated_at", "total_rows", "processed_count",
    "success_count", "error_count", "skipped_count", "stop_requested", "error_message",
]
JOBS_UPSERT_SQL = (
    "INSERT INTO order_punch_jobs (" + ", ".join(f"`{c}`" for c in JOBS_INSERT_COLUMNS) + ") "
    "VALUES (" + ", ".join(["%s"] * len(JOBS_INSERT_COLUMNS)) + ") "
    "ON DUPLICATE KEY UPDATE "
    + ", ".join(f"`{c}` = VALUES(`{c}`)" for c in JOBS_INSERT_COLUMNS if c != "id")
)

ROWS_FETCH_SQL = """
SELECT job_id, row_index, display_order_code, reason, facility_code, status, so_code,
       target_channel, error_message, updated_at
FROM order_punch_job_rows ORDER BY job_id, row_index
"""
ROWS_INSERT_COLUMNS = [
    "job_id", "row_index", "display_order_code", "reason", "facility_code", "status",
    "so_code", "target_channel", "error_message", "updated_at",
]
ROWS_UPSERT_SQL = (
    "INSERT INTO order_punch_job_rows (" + ", ".join(f"`{c}`" for c in ROWS_INSERT_COLUMNS) + ") "
    "VALUES (" + ", ".join(["%s"] * len(ROWS_INSERT_COLUMNS)) + ") "
    "ON DUPLICATE KEY UPDATE "
    + ", ".join(f"`{c}` = VALUES(`{c}`)" for c in ROWS_INSERT_COLUMNS if c not in ("job_id", "row_index"))
)

SETTINGS_FETCH_SQL = "SELECT key, value, updated_at, updated_by FROM order_punch_settings"
SETTINGS_UPSERT_SQL = """
INSERT INTO order_punch_settings (`key`, value, updated_at, updated_by) VALUES (%s, %s, %s, %s)
ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)
"""


def fetch_postgres():
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(JOBS_FETCH_SQL)
            jobs = cur.fetchall()
            cur.execute(ROWS_FETCH_SQL)
            rows = cur.fetchall()
            cur.execute(SETTINGS_FETCH_SQL)
            settings = cur.fetchall()
    return jobs, rows, settings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    jobs, rows, settings = fetch_postgres()
    print(f"Fetched {len(jobs)} order_punch_jobs row(s), {len(rows)} order_punch_job_rows "
          f"row(s), {len(settings)} order_punch_settings row(s) from Postgres.")
    non_terminal = [j for j in jobs if j[1] not in ("done", "failed", "stopped")]
    if non_terminal:
        print(f"\n  WARNING: {len(non_terminal)} job(s) are NOT in a terminal status - a job "
              f"still running against Postgres at cutover time will not be picked up by the "
              f"MySQL-reading worker after this deploy. IDs: {[j[0] for j in non_terminal]}")

    if not args.apply:
        print(f"\nDRY RUN - nothing written. Re-run with --apply to upsert "
              f"{len(jobs)} + {len(rows)} + {len(settings)} row(s).")
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
        if jobs:
            cur.executemany(JOBS_UPSERT_SQL, jobs)
        if rows:
            cur.executemany(ROWS_UPSERT_SQL, rows)
        if settings:
            settings_rows = [
                (key, json.dumps(value) if not isinstance(value, str) else value, updated_at, updated_by)
                for key, value, updated_at, updated_by in settings
            ]
            cur.executemany(SETTINGS_UPSERT_SQL, settings_rows)
        conn.commit()
        print(f"\nApplied {len(jobs)} job(s), {len(rows)} row(s), {len(settings)} setting(s) to {SCHEMA}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
