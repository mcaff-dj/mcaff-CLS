#!/usr/bin/env python3
"""One-time data move: every row of Postgres `lead_assignments` (live cycles AND retired
history alike) into MySQL PEP_CLS.CLS_RTO_calling, now that migrate_cls_rto_calling_schema.py
has given it the same per-cycle shape. Run that schema script (and confirm it printed "already
fully migrated") before this one.

Dedup against what's already there: CLS_RTO_calling has held one row per order_id since the
old daily sync (scripts/sync_lead_assignments_to_mysql.py), upserting each lead's LATEST
disposed cycle and overwriting whatever was there before - so for any order_id already present
in MySQL, the Postgres row with disposed_at set is the SAME logical row, not a new one. That
row is UPDATEd in place (filling reassigned_away_at/rto_reason/new_order_id/delivery_partner,
which the old sync never carried) rather than re-inserted, or the live_order_id unique index
would reject the duplicate outright. Every OTHER Postgres row for that lead - a retired earlier
cycle, or the live still-being-worked cycle - has no MySQL counterpart at all and is a plain
INSERT.

Known, pre-existing limitation this migration cannot fix: the old sync's upsert only ever kept
a lead's LATEST disposed cycle - if a lead was somehow disposed, reassigned, and disposed again
before this ran, MySQL only ever saw the second disposal, and the first was already overwritten
long before this script exists. Nothing here can recover data the old upsert already discarded.

Dry-run by default (prints counts + a sample of each bucket); --apply performs the writes, all
in one transaction (nothing is committed if any row fails, so a partial run can't corrupt
history). Does NOT delete anything from Postgres - verify the counts/spot-check MySQL first;
retiring the Postgres table is a separate, deliberate step once the app is confirmed to be
reading/writing MySQL exclusively.
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
TABLE = "CLS_RTO_calling"

FETCH_ALL_SQL = """
SELECT order_id, email, assigned_at, reassigned_away_at, disposed_at, disposition,
       agent_remarks, connected, attempt, refund_amount, awb_code, rto_reason, new_order_id,
       delivery_partner
FROM lead_assignments
ORDER BY order_id, assigned_at
"""

UPDATE_SQL = f"""
UPDATE `{TABLE}` SET
    reassigned_away_at = %s, rto_reason = %s, new_order_id = %s, delivery_partner = %s
WHERE order_id = %s
"""

INSERT_COLUMNS = [
    "order_id", "agent_email", "assigned_at", "reassigned_away_at", "disposed_at",
    "disposition", "agent_remarks", "connected", "attempt", "refund_amount", "awb_code",
    "rto_reason", "new_order_id", "delivery_partner",
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
    print(f"Fetched {len(pg_rows)} row(s) from Postgres lead_assignments.")

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT order_id FROM `{TABLE}`")
        already_archived = {r[0] for r in cur.fetchall()}
        print(f"{len(already_archived)} order_id(s) already present in {SCHEMA}.{TABLE}.")

        to_update, to_insert = [], []
        for row in pg_rows:
            (order_id, email, assigned_at, reassigned_away_at, disposed_at, disposition,
             agent_remarks, connected, attempt, refund_amount, awb_code, rto_reason,
             new_order_id, delivery_partner) = row
            if disposed_at is not None and order_id in already_archived:
                to_update.append((reassigned_away_at, rto_reason, new_order_id, delivery_partner, order_id))
            else:
                to_insert.append((
                    order_id, email, assigned_at, reassigned_away_at, disposed_at, disposition,
                    agent_remarks, connected, attempt, refund_amount, awb_code, rto_reason,
                    new_order_id, delivery_partner,
                ))

        print(f"\n  already archived, backfilling new columns : {len(to_update)}")
        print(f"  new rows to insert (live + retired history) : {len(to_insert)}")
        if to_insert:
            print("\n  sample of rows to insert:")
            for r in to_insert[:5]:
                print(f"      order_id={r[0]!r} agent={r[1]!r} assigned_at={r[2]} "
                      f"reassigned_away_at={r[3]} disposed_at={r[4]}")

        if not args.apply:
            print(f"\nDRY RUN - nothing written. Re-run with --apply to write "
                  f"{len(to_update)} update(s) and {len(to_insert)} insert(s).")
            return

        if to_update:
            cur.executemany(UPDATE_SQL, to_update)
        if to_insert:
            cur.executemany(INSERT_SQL, to_insert)
        conn.commit()
        print(f"\nApplied {len(to_update)} update(s) and {len(to_insert)} insert(s) to {SCHEMA}.{TABLE}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
