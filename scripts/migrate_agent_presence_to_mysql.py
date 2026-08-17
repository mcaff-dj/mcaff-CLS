#!/usr/bin/env python3
"""One-time (repeatable) data move: Postgres agent_presence (full copy, upsert) and
agent_presence_log (new rows only, past MySQL's current high-water mark) into MySQL
PEP_CLS - the same role migrate_lead_assignments_to_cls_rto_calling.py played for
lead_assignments. This script replaces scripts/sync_agent_presence_log_to_mysql.py, which
only ever handled the log half one-way; this handles both, and is meant to be run more than
once (idempotent) - once early to warm up the MySQL copy, then one final time immediately
before the app cuts over to writing/reading MySQL directly, to shrink the gap to as close to
zero as achievable without a maintenance window.

Dry-run by default (prints counts); --apply performs the writes.
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

FETCH_PRESENCE_SQL = "SELECT email, name, status, updated_at FROM agent_presence"
UPSERT_PRESENCE_SQL = """
INSERT INTO agent_presence (email, name, status, updated_at) VALUES (%s, %s, %s, %s)
ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status), updated_at = VALUES(updated_at)
"""

FETCH_LOG_SQL = """
SELECT id, email, name, status, changed_at
FROM agent_presence_log
WHERE id > %s
ORDER BY id
"""
INSERT_LOG_SQL = """
INSERT IGNORE INTO agent_presence_log (id, email, name, status, changed_at)
VALUES (%s, %s, %s, %s, %s)
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    pg_conn_str = os.environ.get("POSTGRES_URL")
    if not pg_conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    mysql_conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        mysql_cur = mysql_conn.cursor()
        with psycopg.connect(pg_conn_str) as pg_conn:
            with pg_conn.cursor() as pg_cur:
                pg_cur.execute(FETCH_PRESENCE_SQL)
                presence_rows = pg_cur.fetchall()

                mysql_cur.execute("SELECT COALESCE(MAX(id), 0) FROM agent_presence_log")
                last_id = mysql_cur.fetchone()[0]
                pg_cur.execute(FETCH_LOG_SQL, (last_id,))
                log_rows = pg_cur.fetchall()

        print(f"agent_presence: {len(presence_rows)} row(s) to upsert.")
        print(f"agent_presence_log: {len(log_rows)} new row(s) past id {last_id}.")

        if not args.apply:
            print("\nDry run - re-run with --apply to write.")
            return

        mysql_cur.executemany(UPSERT_PRESENCE_SQL, presence_rows)
        mysql_cur.executemany(INSERT_LOG_SQL, log_rows)
        mysql_conn.commit()
        print(f"\nApplied: {len(presence_rows)} agent_presence row(s), {len(log_rows)} "
              f"agent_presence_log row(s).")
    finally:
        mysql_conn.close()


if __name__ == "__main__":
    main()
