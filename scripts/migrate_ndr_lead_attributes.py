#!/usr/bin/env python3
"""Adds PEP_CLS.ndr_lead_assignments.delivery_partner/ndr_reason/payment_mode/brand - the
lead-attribute mirror behind the Calling Team Overview's Process (RTO/NDR) filter (see
docs/superpowers/specs/2026-09-05-calling-overview-process-filter-design.md).

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER
TABLE anywhere in api/. Run this BEFORE deploying the api/ and scripts/ changes that write or
read these columns (claimNdrLead, api/ndr/next-lead.js, assign_ndr_leads.py's
record_new_assignments, the backfill script, and the new NDR query functions in db.js) - a
missing column throws ER_BAD_FIELD_ERROR the first time any of them touches it.

All 4 columns start NULL and are always written together (see the claim-time mirror and the
backfill script) - a row with any one of them non-NULL has all four set, which is what lets
both that mirror and the backfill guard against overwriting real data with `WHERE
delivery_partner IS NULL`.

Dry-run by default; --apply performs the DDL. Safe to re-run: an already-applied step is
detected and skipped, matching this repo's other one-off MySQL schema scripts (see
migrate_ndr_team_id.py).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "ndr_lead_assignments"
NEW_COLUMNS = [
    ("delivery_partner", "VARCHAR(64) NULL"),
    ("ndr_reason", "VARCHAR(255) NULL"),
    ("payment_mode", "VARCHAR(20) NULL"),
    ("brand", "VARCHAR(20) NULL"),
]


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL (default: dry run)")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        plan = []
        for column, ddl_type in NEW_COLUMNS:
            if _column_exists(cur, column):
                print(f"{column} already present - skipping.")
            else:
                plan.append((
                    f"add {column} column",
                    f"ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl_type}",
                ))

        if not plan:
            print("\nNothing to do - schema already migrated.")
            return 0

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} step(s):")
        for label, stmt in plan:
            print(f"  - {label}\n      {stmt}")

        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return 0

        for label, stmt in plan:
            cur.execute(stmt)
            conn.commit()
            print(f"  done: {label}")

        cur.execute(f"SELECT COUNT(*) FROM `{TABLE}`")
        (total,) = cur.fetchone()
        print(f"\nDone. {TABLE} has {total} row(s); all 4 new columns start NULL.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
