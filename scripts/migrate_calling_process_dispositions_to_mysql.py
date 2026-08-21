#!/usr/bin/env python3
"""One-time data move: every row of Postgres `calling_process_dispositions` into MySQL
PEP_CLS.calling_process_dispositions (see api/_lib/db.js's bootstrapSchema) - the same
MySQL-over-Postgres move already made for ndr_lead_assignments (see
migrate_ndr_lead_assignments_to_mysql.py). Only Postgres has ever been written to, so - as
with that migration - there is no live dual-write cutover race: run this once, right after
deploying the code change that points get/add/update/delete/reorderProcessDisposition at
MySQL, and every row moves over as-is.

parent_id is self-referencing, so rows are inserted in TWO passes: every root (parent_id IS
NULL) first, then every child, once every root's OLD Postgres id can be mapped to its NEW
MySQL id (ids can't be preserved as-is - MySQL AUTO_INCREMENT assigns its own). A second
level of children (grandchildren) is handled by looping passes until nothing is left
unresolved, so nesting depth doesn't have to be assumed.

Dedup by (process_key, label, COALESCE(old parent's already-migrated new id, NULL)) - there's
no natural unique key on this table, so a re-run after a partial apply matches on the same
tuple the app itself would treat as "the same option" rather than re-inserting duplicates.

Dry-run by default (prints counts + a sample); --apply performs the writes, all in one
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
TABLE = "calling_process_dispositions"

FETCH_ALL_SQL = """
SELECT id, process_key, parent_id, label, description, sort_order, children_input_type,
       created_at, created_by
FROM calling_process_dispositions
ORDER BY (parent_id IS NOT NULL), sort_order, id
"""


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
    print(f"Fetched {len(pg_rows)} row(s) from Postgres calling_process_dispositions.")

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT id, process_key, parent_id, label FROM `{TABLE}`")
        existing_rows = cur.fetchall()
        # old_id_by_new_id lets an already-migrated child be matched to its already-migrated
        # parent purely by (process_key, label) - the new-side parent_id, not the old one.
        existing_by_key = {(r[1], r[3], r[2]) for r in existing_rows}

        old_to_new_id = {}  # old Postgres id -> new MySQL id, filled in as each row lands
        inserted = []       # (process_key, new_parent, label, sort_order) - for the printed sample
        pending = list(pg_rows)
        # Loop passes: a row can only be placed once its parent (if any) already has a new id.
        # A placed row is inserted immediately (or, on a dry run, given a fake negative id) so
        # its own new id is available for its children to resolve against in a later pass -
        # the new id doesn't exist until the row lands, so resolution and insertion can't be
        # split into separate phases the way a flat list of "rows to insert" would suggest.
        next_fake_id = -1
        while pending:
            placed_this_pass = []
            still_pending = []
            for row in pending:
                (old_id, process_key, parent_id, label, description, sort_order,
                 children_input_type, created_at, created_by) = row
                if parent_id is None or parent_id in old_to_new_id:
                    new_parent = old_to_new_id.get(parent_id) if parent_id is not None else None
                    key = (process_key, label, new_parent)
                    if key in existing_by_key:
                        # Already migrated in an earlier --apply run - map its id so any of
                        # ITS children can still resolve, but don't insert it again.
                        match = next((r[0] for r in existing_rows if (r[1], r[3], r[2]) == key), None)
                        if match is not None:
                            old_to_new_id[old_id] = match
                        placed_this_pass.append(old_id)
                        continue
                    inserted.append((process_key, new_parent, label, sort_order))
                    if args.apply:
                        cur.execute(
                            f"INSERT INTO `{TABLE}` "
                            "(process_key, parent_id, label, description, sort_order, "
                            " children_input_type, created_at, created_by) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                            (process_key, new_parent, label, description, sort_order,
                             children_input_type, created_at, created_by),
                        )
                        old_to_new_id[old_id] = cur.lastrowid
                    else:
                        old_to_new_id[old_id] = next_fake_id
                        next_fake_id -= 1
                    placed_this_pass.append(old_id)
                else:
                    still_pending.append(row)
            if not placed_this_pass:
                unresolved = [r[0] for r in still_pending]
                raise SystemExit(f"Could not resolve parent_id for old id(s) {unresolved} - "
                                  "orphaned parent_id (points at a row not in this fetch)?")
            pending = still_pending

        print(f"\n  new rows to insert : {len(inserted)}")
        if inserted:
            print("\n  sample of rows to insert:")
            for r in inserted[:5]:
                print(f"      process_key={r[0]!r} parent(new)={r[1]!r} label={r[2]!r} sort_order={r[3]}")

        if not args.apply:
            print(f"\nDRY RUN - nothing written. Re-run with --apply to write {len(inserted)} insert(s).")
            return

        conn.commit()
        print(f"\nApplied {len(inserted)} insert(s) to {SCHEMA}.{TABLE}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
