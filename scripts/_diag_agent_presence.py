"""Temporary read-only diagnostic: dump agent_presence for inspection."""
import os

import psycopg


def main(conn_str):
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT email, name, status, updated_at, now() - updated_at AS age,
                       now() AS server_now
                FROM agent_presence
                ORDER BY updated_at DESC
                """
            )
            cols = [d.name for d in cur.description]
            print(" | ".join(cols))
            for row in cur.fetchall():
                print(" | ".join(str(v) for v in row))


if __name__ == "__main__":
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    main(conn_str)
