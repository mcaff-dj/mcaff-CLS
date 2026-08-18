#!/usr/bin/env python3
"""Re-keys MySQL PEP_CLS.Delivery_escalation from "one row per AWB" to "one row per ticket,
falling back to one row per AWB only when the sheet gives us nothing better" - the same
conditional-uniqueness problem scripts/migrate_cls_rto_calling_schema.py solved for
CLS_RTO_calling (MySQL has no partial/predicated unique index like Postgres's `WHERE ...`), so
this uses the identical trick: a VIRTUAL generated column computing the real dedup identity,
with the UNIQUE index on THAT column instead of the raw ones.

Why not just UNIQUE (brand, awb_code, ticket_number): ticket_number is blank on ~24% of
HYPHEN's and ~49% of mCaffeine's terminal rows (verified against the live sheet before writing
this). MySQL treats every NULL in a unique index as distinct from every other NULL, so a plain
composite key would let blank-ticket-number rows for the SAME AWB pile up as duplicates on every
re-run of the backfill - the opposite of the "safe to re-run" idempotency every other one-off
script in this repo relies on. The generated column sidesteps this: when ticket_number is
present, dedup_key is deterministic and keeps distinct tickets separate; when it's blank,
dedup_key falls back to the AWB alone, so re-running always upserts the same row instead of
piling up new ones.

Drops the old `brand_awb_key` UNIQUE (brand, awb_code) entirely - keeping it would still block
more than one row per AWB regardless of ticket_number, defeating the point of this migration.

Dry-run by default; --apply performs the DDL. Guarded by an information_schema check per step,
safe to re-run.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"


def _key_exists(cur, index_name):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, TABLE, index_name),
    )
    return cur.fetchone() is not None


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DDL (default is a dry run).")
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

        if _key_exists(cur, "brand_awb_key"):
            plan.append(("drop old brand_awb_key unique key",
                         f"ALTER TABLE `{TABLE}` DROP INDEX `brand_awb_key`"))
        else:
            print("brand_awb_key already gone - skipping.")

        if _column_exists(cur, "dedup_key"):
            print("dedup_key already present - skipping.")
        else:
            plan.append((
                "add dedup_key generated column + unique index",
                f"ALTER TABLE `{TABLE}` "
                "ADD COLUMN `dedup_key` VARCHAR(320) GENERATED ALWAYS AS ("
                "IF(ticket_number IS NOT NULL AND ticket_number <> '', "
                "CONCAT(brand, '|tkt|', ticket_number), "
                "CONCAT(brand, '|awb|', awb_code)"
                ")) VIRTUAL, "
                f"ADD UNIQUE KEY `dedup_key_key` (`dedup_key`)",
            ))

        if not plan:
            print("\nAlready fully migrated - nothing to do.")
            return

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} step(s):")
        for label, stmt in plan:
            print(f"  - {label}\n      {stmt}")

        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return

        for label, stmt in plan:
            cur.execute(stmt)
            conn.commit()
            print(f"  done: {label}")
        print("\nMigration complete.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
