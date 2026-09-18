#!/usr/bin/env python3
"""Adds PEP_CLS.calling_agent_process.detractor_product_filter (TEXT NULL) - a per-agent hard
filter restricting which NPS-Calling (process_key='detractor') leads they may claim to ones
whose product matches one of the agent's own selected product names, comma-joined (same "free
text, no fixed value set" shape as priority_rto_reasons/ndr_reason_filter already on this same
table - see that column's own comment in api/_lib/db.js). '' or NULL = unrestricted, the
pre-existing behavior for every agent who never had this set.

Applies to BOTH pools this process draws from:
  - nps_delivery: matched against product_name_list (an order's own comma-joined product list)
  - nps_product: matched against product_name (one value per rated product_slot)
See getDetractorProductFilterFor / its use in peekDeliveryDetractorCandidates and
peekProductDetractorCandidates in api/_lib/db.js.

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER TABLE
anywhere in api/ - a new COLUMN cannot ship itself with the Lambda deploy the way a new TABLE can
(same reasoning as every other migrate_*.py script that has touched this table). Running this
BEFORE that deploy is not optional: api/ code selecting a missing column throws
ER_BAD_FIELD_ERROR inside getCallingProcessAgents, which serves every process's Team Roster, not
just NPS-Calling's.

Dry-run by default; --apply performs the DDL.
"""
import argparse
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_agent_process"
COLUMN = "detractor_product_filter"


def _column_exists(cur):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, COLUMN),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL (default: dry run)")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], autocommit=False,
        ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        with conn.cursor() as cur:
            if _column_exists(cur):
                print(f"  column {COLUMN}: already present")
            elif args.apply:
                cur.execute(f"ALTER TABLE {TABLE} ADD COLUMN {COLUMN} TEXT NULL")
                print(f"  column {COLUMN}: added")
            else:
                print(f"  column {COLUMN}: would add")

        if args.apply:
            conn.commit()
            print("committed")
        else:
            conn.rollback()
            print("dry run - nothing written (re-run with --apply)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
