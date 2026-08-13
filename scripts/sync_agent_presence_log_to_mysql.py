"""Mirrors Postgres's agent_presence_log (see api/_lib/db.js's ensurePgSchema - the
append-only history of every agent status transition, written by upsertAgentPresence)
into MySQL's PEP_CLS.agent_presence_log: Postgres stays the live/working copy, MySQL is
where this data survives long-term for reporting.

There's no "yesterday" business window to key off - a status change is an event, not
something with its own retention date - so this instead tracks progress with a plain
high-water mark: the largest `id` already in MySQL. Every run pulls whatever's newer than
that from Postgres and appends it. Rows are never updated once written (a status
transition is immutable history), so this is a plain INSERT IGNORE, not an upsert - and
nothing is ever deleted from Postgres's agent_presence_log by this script; it's low-volume
(one row per real status change, not per heartbeat) so there's no bloat pressure to purge it.
"""
import os
import sys
from pathlib import Path

import psycopg
import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "agent_presence_log"

COLUMNS = ["id", "email", "name", "status", "changed_at"]

CREATE_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS `{TABLE}` (
    `id` INT PRIMARY KEY,
    `email` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255),
    `status` VARCHAR(50) NOT NULL,
    `changed_at` DATETIME NOT NULL,
    INDEX `email_changed_at_idx` (`email`, `changed_at`)
)
"""

FETCH_NEW_SQL = """
SELECT id, email, name, status, changed_at
FROM agent_presence_log
WHERE id > %s
ORDER BY id
"""


def fetch_new_rows(pg_conn_str, since_id):
    with psycopg.connect(pg_conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(FETCH_NEW_SQL, (since_id,))
            return cur.fetchall()


def main():
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
        cur = mysql_conn.cursor()
        cur.execute(CREATE_TABLE_SQL)
        mysql_conn.commit()

        cur.execute(f"SELECT COALESCE(MAX(`id`), 0) FROM `{TABLE}`")
        last_id = cur.fetchone()[0]
        print(f"MySQL {SCHEMA}.{TABLE} is currently at id {last_id}.")

        new_rows = fetch_new_rows(pg_conn_str, last_id)
        if not new_rows:
            print("Nothing new to sync.")
            return

        col_names = ", ".join(f"`{c}`" for c in COLUMNS)
        placeholders = ", ".join(["%s"] * len(COLUMNS))
        cur.executemany(
            f"INSERT IGNORE INTO `{TABLE}` ({col_names}) VALUES ({placeholders})",
            new_rows,
        )
        mysql_conn.commit()
        print(f"Synced {len(new_rows)} new row(s) into {SCHEMA}.{TABLE}.")
    finally:
        mysql_conn.close()


if __name__ == "__main__":
    main()
