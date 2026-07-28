"""One-off: lead_assignments.delivery_partner was found to be a GENERATED ALWAYS
STORED column on the live Postgres DB, which broke assign_leads.py's
record_lead_assignments() - it explicitly writes delivery_partner (derived via
lead_priority.prefix_rule_partner) on every assignment, and Postgres rejects
any explicit value for a generated column ("cannot insert a non-DEFAULT value
into column \"delivery_partner\"").

Nothing in this repo's history ever defined delivery_partner as generated (see
api/_lib/db.js's ensureSchema, which documents it as a plain column populated
by app code) - it must have been altered directly on the DB outside this
codebase. This restores it to a plain column, preserving already-stored values
(DROP EXPRESSION keeps the last-computed value as a static value going
forward; nothing here re-derives it).
"""
import os

import psycopg


def main(conn_str):
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT is_generated, generation_expression
                FROM information_schema.columns
                WHERE table_name = 'lead_assignments' AND column_name = 'delivery_partner'
                """
            )
            row = cur.fetchone()
            if row is None:
                print("delivery_partner column not found on lead_assignments - nothing to do.")
                return
            is_generated, generation_expression = row
            print(f"Current state: is_generated={is_generated!r}, generation_expression={generation_expression!r}")

            if is_generated != "ALWAYS":
                print("Column is already a plain column - nothing to do.")
                return

            cur.execute("ALTER TABLE lead_assignments ALTER COLUMN delivery_partner DROP EXPRESSION IF EXISTS")
        conn.commit()
        print("Dropped the generated expression - delivery_partner is now a plain column.")

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT is_generated, generation_expression
                FROM information_schema.columns
                WHERE table_name = 'lead_assignments' AND column_name = 'delivery_partner'
                """
            )
            is_generated, generation_expression = cur.fetchone()
            print(f"Confirmed state: is_generated={is_generated!r}, generation_expression={generation_expression!r}")


if __name__ == "__main__":
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    main(conn_str)
