#!/usr/bin/env python3
"""Re-shapes MySQL PEP_CLS.CLS_RTO_calling from "one row per order_id, overwritten on
reassignment" into "one row per assignment CYCLE" - the same grain Postgres lead_assignments
already uses (see api/_lib/db.js's bootstrapPgSchema) - as the schema half of retiring
lead_assignments from Postgres entirely and making this table its sole replacement.

Why the grain has to change, not just the storage engine: today's upsert-on-order_id
(scripts/sync_lead_assignments_to_mysql.py's ON DUPLICATE KEY UPDATE) throws away a
reassigned lead's earlier attempt the moment a later one lands - the exact loss
lead_assignments' per-cycle rows exist to prevent (see that table's own comment: "the old
upsert did throw it away"). assign_leads.py's "an agent who already failed to connect never
gets this lead again" exclusion and getCallingOverviewStats' call-outcome counts both depend
on every past cycle surviving a reassignment, so a flat upsert here would silently break both.

Adds:
  id                  surrogate PK (BIGINT UNSIGNED AUTO_INCREMENT) - order_id can no longer be
                      the key once it repeats across cycles.
  reassigned_away_at  DATETIME NULL - NULL means "still the live cycle", mirroring Postgres.
  rto_reason, new_order_id, delivery_partner - lead_assignments columns this table never had
                      (the old sync only carried the 10 columns its own COLUMNS list named).
  live_order_id, live_awb_code - VIRTUAL generated columns, NULL unless reassigned_away_at IS
                      NULL, each carrying a UNIQUE index. MySQL has no partial/predicated
                      unique index (Postgres's `WHERE reassigned_away_at IS NULL`), but DOES
                      treat every NULL in a UNIQUE index as distinct - so a generated column
                      that's non-NULL only on the live cycle reproduces the exact same "at
                      most one live row per lead / per AWB" guarantee Postgres enforces via
                      lead_assignments_order_id_current_key / lead_assignments_awb_code_key.

Existing rows (today's archived, already-disposed leads) get reassigned_away_at = NULL, i.e.
they become "the live/only cycle of their lead" - correct, since a disposed lead is never
reassigned again, so there is no later cycle to make them retired relative to.

Every step is guarded by an information_schema check first and prints its plan before
altering anything. Dry-run by default; --apply performs the DDL. Safe to re-run: an
already-applied step is detected and skipped, matching this repo's other one-off MySQL
schema scripts (see fix_delivery_partner_generated_column.py's Postgres equivalent).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_RTO_calling"

NEW_COLUMNS = [
    ("reassigned_away_at", "DATETIME NULL"),
    ("rto_reason", "VARCHAR(255) NULL"),
    ("new_order_id", "VARCHAR(64) NULL"),
    ("delivery_partner", "VARCHAR(64) NULL"),
]


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def _current_key_on_order_id(cur):
    """(index_name, is_primary) of whatever unique key today's upsert relies on, or None if
    order_id isn't keyed at all. Looked up rather than assumed - same reasoning as
    api/_lib/db.js's Postgres migration looking up its PK's real name instead of guessing
    the default."""
    cur.execute(
        "SELECT index_name FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND column_name = 'order_id' AND non_unique = 0",
        (SCHEMA, TABLE),
    )
    rows = cur.fetchall()
    if not rows:
        return None
    # PRIMARY sorts first if present; that's the one DROP needs a different clause for.
    names = {r[0] for r in rows}
    return "PRIMARY" if "PRIMARY" in names else next(iter(names))


def _has_id_pk(cur):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = 'id'",
        (SCHEMA, TABLE),
    )
    return cur.fetchone() is not None


def _duplicate_live_awb_codes(cur):
    """Non-null awb_code values shared by more than one row - would break live_awb_code's
    UNIQUE index (every existing row starts out "live" - see module docstring). Checked
    before creating that index rather than letting MySQL reject the ALTER outright, so a
    real conflict is reported with the actual order_ids instead of a bare constraint error."""
    cur.execute(
        f"SELECT awb_code, COUNT(*) c, GROUP_CONCAT(order_id) FROM `{TABLE}` "
        "WHERE awb_code IS NOT NULL AND awb_code <> '' GROUP BY awb_code HAVING c > 1"
    )
    return cur.fetchall()


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

        if _has_id_pk(cur):
            print("id column already present - surrogate PK step already applied.")
        else:
            key_name = _current_key_on_order_id(cur)
            drop_clause = "DROP PRIMARY KEY" if key_name == "PRIMARY" else (
                f"DROP INDEX `{key_name}`" if key_name else None
            )
            add_clauses = ["ADD COLUMN `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT FIRST",
                           "ADD PRIMARY KEY (`id`)"]
            clauses = ([drop_clause] if drop_clause else []) + add_clauses
            stmt = f"ALTER TABLE `{TABLE}` " + ", ".join(clauses)
            plan.append(("add surrogate id PK" + (f" (dropping old key `{key_name}`)" if key_name else ""), stmt))

        for col, ddl in NEW_COLUMNS:
            if _column_exists(cur, col):
                print(f"{col} already present - skipping.")
            else:
                plan.append((f"add column {col}", f"ALTER TABLE `{TABLE}` ADD COLUMN `{col}` {ddl}"))

        if _column_exists(cur, "live_order_id"):
            print("live_order_id already present - skipping.")
        else:
            plan.append((
                "add live_order_id generated column + unique index",
                f"ALTER TABLE `{TABLE}` "
                "ADD COLUMN `live_order_id` VARCHAR(64) GENERATED ALWAYS AS "
                "(IF(reassigned_away_at IS NULL, order_id, NULL)) VIRTUAL, "
                "ADD UNIQUE KEY `live_order_id_key` (`live_order_id`)",
            ))

        if _column_exists(cur, "live_awb_code"):
            print("live_awb_code already present - skipping.")
        else:
            dupes = _duplicate_live_awb_codes(cur)
            if dupes:
                print("\nRefusing to add live_awb_code's unique index - duplicate AWB codes found "
                      "among current rows (all of which start out 'live'):")
                for awb, count, order_ids in dupes:
                    print(f"    {awb!r}: {count} rows ({order_ids})")
                print("Resolve these (or null one side's awb_code) before re-running.\n")
            else:
                plan.append((
                    "add live_awb_code generated column + unique index",
                    f"ALTER TABLE `{TABLE}` "
                    "ADD COLUMN `live_awb_code` VARCHAR(255) GENERATED ALWAYS AS "
                    "(IF(reassigned_away_at IS NULL, awb_code, NULL)) VIRTUAL, "
                    "ADD UNIQUE KEY `live_awb_code_key` (`live_awb_code`)",
                ))

        if not plan:
            print("\nSchema already fully migrated - nothing to do.")
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
        print("\nSchema migration complete.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
