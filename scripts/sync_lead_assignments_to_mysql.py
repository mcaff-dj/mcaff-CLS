"""Pulls yesterday's disposed RTO calling leads from the Postgres
lead_assignments_current view (the same DB rto-crm.html's admin/auth panel and
assign_leads.py use) and upserts them into PEP_CLS.CLS_RTO_calling in MySQL.
Runs daily at 9am IST via GitHub Actions (see
.github/workflows/sync-lead-assignments.yml).

"Yesterday" is computed in Asia/Kolkata regardless of the Postgres server's own
session timezone, since assigned_at/disposed_at are timestamptz and the 9am
trigger is an IST business-day boundary, not a UTC one.

lead_assignments holds one row per assignment CYCLE, so a lead passed between
agents has a row for each of them (see api/_lib/db.js's ensurePgSchema).
lead_assignments_current is the live cycle of each lead - one row per order_id,
which is the grain this sync needs, since CLS_RTO_calling is itself keyed on
order_id and can only hold one row per lead.

Rows disposed more than RETENTION_DAYS ago are also re-upserted (a cheap no-op
if already synced by a prior run) and then deleted from Postgres by that exact
same row `id` list - never by order_id, and never by re-running a date filter,
so a row can never be deleted without this run itself having just confirmed it
landed in MySQL, and deleting it can never take a retired cycle of the same lead
along with it. Those retired rows are never purged here at all: assign_leads.py
reads them to enforce "an agent who already failed to connect never gets this
lead again", which has to hold for the life of the lead, exactly as the old
lead_reassignment_attempts table was also never expired. The retention window
matches rto-crm.html's recentAssignments feature (see api/_lib/db.js), which
reads lead_assignments_current for up to 30 days, so disposed leads stay visible
there for their full lookback window before cleanup.
"""
import os
import sys
from pathlib import Path

import psycopg
import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"
RETENTION_DAYS = 30

COLUMNS = [
    "order_id", "email", "assigned_at", "disposed_at",
    "disposition", "agent_remarks", "connected", "attempt", "refund_amount", "awb_code",
]

# Leading `id` is the row's own surrogate key in the underlying lead_assignments table -
# carried through fetch_rows()/main() only to target DELETE_SQL precisely, then dropped
# before the row is upserted into MySQL (see COLUMNS above, which has no `id`).
FETCH_YESTERDAY_SQL = """
SELECT id, order_id, email, assigned_at, disposed_at, disposition, agent_remarks, connected, attempt, refund_amount, awb_code
FROM lead_assignments_current
WHERE (disposed_at AT TIME ZONE 'Asia/Kolkata')::date
      = ((now() AT TIME ZONE 'Asia/Kolkata')::date - interval '1 day')
"""

FETCH_AGED_SQL = f"""
SELECT id, order_id, email, assigned_at, disposed_at, disposition, agent_remarks, connected, attempt, refund_amount, awb_code
FROM lead_assignments_current
WHERE disposed_at IS NOT NULL
      AND disposed_at < now() - interval '{RETENTION_DAYS} days'
"""

# By `id`, not `order_id`: order_id is not unique in the underlying table (one row per
# assignment cycle), so deleting by order_id would also wipe the retired cycles that
# assign_leads.py relies on. Targeting the exact `id` this run just fetched-and-synced only
# ever removes the one row now safely in MySQL, leaving that lead's history untouched.
DELETE_SQL = "DELETE FROM lead_assignments WHERE id = ANY(%s)"


def fetch_rows(sql):
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            return cur.fetchall()


def delete_rows(ids):
    conn_str = os.environ["POSTGRES_URL"]
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(DELETE_SQL, (ids,))
        conn.commit()


def upsert_rows(rows):
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s AND column_name = 'awb_code'",
            (SCHEMA, TABLE),
        )
        if cur.fetchone()[0] == 0:
            cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `awb_code` VARCHAR(255) NULL")
            conn.commit()

        col_names = ", ".join(f"`{c}`" for c in COLUMNS)
        placeholders = ", ".join(["%s"] * len(COLUMNS))
        update_clause = ", ".join(f"`{c}` = VALUES(`{c}`)" for c in COLUMNS if c != "order_id")
        upsert_sql = (
            f"INSERT INTO `{TABLE}` ({col_names}) VALUES ({placeholders}) "
            f"ON DUPLICATE KEY UPDATE {update_clause}"
        )
        cur.executemany(upsert_sql, rows)
        conn.commit()
    finally:
        conn.close()


def main():
    fresh_rows = fetch_rows(FETCH_YESTERDAY_SQL)
    print(f"Fetched {len(fresh_rows)} row(s) disposed yesterday (IST) from Postgres lead_assignments_current.")

    aged_rows = fetch_rows(FETCH_AGED_SQL)
    print(f"Fetched {len(aged_rows)} row(s) disposed more than {RETENTION_DAYS} days ago (due for cleanup).")

    all_rows = fresh_rows + aged_rows
    if not all_rows:
        print("Nothing to push.")
        return

    # Drop the leading `id` (see FETCH_*_SQL's comment) - MySQL only ever wants the
    # COLUMNS fields, keyed on its own order_id unique key.
    upsert_rows([row[1:] for row in all_rows])
    print(f"Upserted {len(all_rows)} row(s) into {SCHEMA}.{TABLE}.")

    aged_ids = [r[0] for r in aged_rows]
    if aged_ids:
        delete_rows(aged_ids)
        print(f"Deleted {len(aged_ids)} row(s) older than {RETENTION_DAYS} days from Postgres lead_assignments.")


if __name__ == "__main__":
    main()
