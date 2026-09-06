#!/usr/bin/env python3
"""Adds PEP_CLS.CLS_NPS_calling.lead_type (+ its six nps_product rating columns) and rewrites
live_response_id's generated column to namespace by lead_type, then adds
PEP_CLS.calling_process_dispositions.lead_type (+ index) - see
docs/superpowers/specs/2026-09-06-nps-calling-product-leads-design.md.

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with CREATE
TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER TABLE
anywhere in api/ - so these two new columns cannot ship themselves with the Lambda deploy the way
a brand-new table would. Same reasoning, same shape, as scripts/migrate_team_dispositions.py.

Run BEFORE the api/ deploy that reads these columns. getUnassignedDetractorLeads has no
pre-migration fallback for lead_type (a read against a missing column throws
ER_BAD_FIELD_ERROR there). getProcessDispositions DOES have a softened fallback (it sheds the
lead_type predicate first, then team_id too if that retry also fails) - see that function's own
comment in db.js - but the fallback exists to protect OTHER processes' pre-existing team_id
reads during this exact deploy window, not to make this migration's run order optional: until
--apply runs, NPS-Calling's own Product-tree reads/writes still don't work correctly, they just
fail without crashing the endpoint entirely.

CLS_NPS_calling.lead_type:
  - DEFAULT 'delivery' means the ADD COLUMN itself backfills every existing row correctly (every
    ticket that exists today really did come from nps_delivery) - no separate UPDATE needed.
  - live_response_id (a generated/virtual column carrying CLS_NPS_calling's actual dedup UNIQUE
    KEY - NOT a plain PRIMARY KEY(response_id); see that column's own comment in db.js) is
    rewritten from `IF(reassigned_away_at IS NULL, response_id, NULL)` to
    `IF(reassigned_away_at IS NULL, CONCAT(lead_type, ':', response_id), NULL)` - a generated
    column's expression can be changed in place via MODIFY COLUMN; every existing row's value
    re-derives automatically (all still 'delivery:<response_id>', identical in effect to today),
    no backfill loop needed.
    RECOVERY IF THIS STEP FAILS PARTWAY (MySQL DDL auto-commits per statement, so a failure here
    leaves lead_type already added but live_response_id NOT yet rewritten - re-running this
    script picks up exactly where it left off, since every step checks information_schema before
    acting). If a manual fix is ever needed: this column carries the table's UNIQUE KEY
    (cls_nps_calling_live_response_key), so on some MySQL versions altering an indexed virtual
    column's expression in place may require dropping and re-adding that key by hand:
      ALTER TABLE CLS_NPS_calling DROP INDEX cls_nps_calling_live_response_key;
      ALTER TABLE CLS_NPS_calling MODIFY COLUMN live_response_id VARCHAR(80)
        GENERATED ALWAYS AS (IF(reassigned_away_at IS NULL, CONCAT(lead_type, ':', response_id), NULL)) VIRTUAL;
      ALTER TABLE CLS_NPS_calling ADD UNIQUE KEY cls_nps_calling_live_response_key (live_response_id);
    Re-run this script afterward (--apply) to confirm it now reports "already namespaced".

calling_process_dispositions.lead_type: nullable, same convention team_id already established -
NULL means shared/fallback, not "unassigned". Existing rows (every process, including today's
'detractor' rows) stay NULL and keep their current meaning; only an admin who actually configures
a Product tree ever writes a non-null value.

Idempotent / safe to re-run: every step is skipped if already applied (checked via
information_schema). Dry-run by default; --apply performs the DDL.
"""
import argparse
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
CALLING_TABLE = "CLS_NPS_calling"
DISP_TABLE = "calling_process_dispositions"
DISP_INDEX_NAME = "calling_process_dispositions_lead_type_idx"
# MySQL's error for "you hold no such privilege on this object" - what a missing INDEX grant
# raises on CREATE INDEX below. Same constant, same reasoning, as migrate_team_dispositions.py's
# own ER_SPECIFIC_ACCESS_DENIED: this runner's grants on PEP_CLS have never included INDEX.
ER_SPECIFIC_ACCESS_DENIED = 1142

OLD_LIVE_RESPONSE_ID_EXPR = "IF(reassigned_away_at IS NULL, response_id, NULL)"
NEW_LIVE_RESPONSE_ID_EXPR = "IF(reassigned_away_at IS NULL, CONCAT(lead_type, ':', response_id), NULL)"

# nps_product's per-product rating fields, only ever filled for lead_type='product' rows - see
# claimOneProductDetractorLead (api/_lib/db.js) for how these are populated.
PRODUCT_RATING_COLUMNS = {
    "product_results": "VARCHAR(20)",
    "product_texture": "VARCHAR(20)",
    "product_fragrance": "VARCHAR(20)",
    "product_packaging_rating": "VARCHAR(20)",
    "product_skin_type": "VARCHAR(50)",
    "product_nps": "VARCHAR(10)",
}


def _column_exists(cur, table, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, table, column),
    )
    return cur.fetchone() is not None


def _generation_expression(cur, table, column):
    cur.execute(
        "SELECT generation_expression FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, table, column),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _index_exists(cur, table, index):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, table, index),
    )
    return cur.fetchone() is not None


def _try_optional_ddl(cur, statement, what, privilege, why_survivable):
    """Runs a DDL step that needs a privilege beyond the plain DML+ALTER this script's runner is
    known to hold, and treats a denial as a skip rather than a failure. Returns True if it ran.

    Ported from migrate_team_dispositions.py, which hit this exact 1142 on this exact table
    (calling_process_dispositions) attempting CREATE INDEX - the runner's grants are
    SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/CREATE VIEW, never INDEX. The four ADD COLUMN
    steps and the ALTER-based live_response_id rewrite above are NOT run through this helper -
    they use privileges already confirmed working, and api/ selects lead_type unconditionally, so
    a skip there would be an outage, not a downgrade. Only ER_SPECIFIC_ACCESS_DENIED is swallowed;
    any other OperationalError (a syntax error, a duplicate name, a dead connection) still raises,
    because those mean the step is broken rather than merely not permitted."""
    try:
        cur.execute(statement)
        print(f"  {what}: added")
        return True
    except pymysql.err.OperationalError as e:
        if e.args[0] != ER_SPECIFIC_ACCESS_DENIED:
            raise
        print(f"  {what}: SKIPPED - {e.args[1]}")
        for line in why_survivable:
            print(f"      {line}")
        print(f"      To add it later, have a DBA run  GRANT {privilege} ON `{SCHEMA}`.* TO `<user>`@`%`;")
        print("      then re-run this script - it picks the step up on its own, nothing else to redo.")
        return False


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
            # Step 1: CLS_NPS_calling.lead_type
            if _column_exists(cur, CALLING_TABLE, "lead_type"):
                print(f"  {CALLING_TABLE}.lead_type: already present")
            elif args.apply:
                cur.execute(
                    f"ALTER TABLE {CALLING_TABLE} "
                    "ADD COLUMN lead_type ENUM('delivery','product') NOT NULL DEFAULT 'delivery'"
                )
                print(f"  {CALLING_TABLE}.lead_type: added (existing rows backfilled to 'delivery' by DEFAULT)")
            else:
                print(f"  {CALLING_TABLE}.lead_type: would add (DEFAULT 'delivery')")

            # Step 2: live_response_id's generated expression
            current_expr = _generation_expression(cur, CALLING_TABLE, "live_response_id")
            # information_schema normalizes whitespace/case differently across MySQL versions, so
            # this checks for the OLD form still being in place rather than an exact string match
            # against NEW_LIVE_RESPONSE_ID_EXPR (which would never match self-consistently).
            needs_rewrite = current_expr is not None and "concat" not in (current_expr or "").lower()
            if current_expr is None:
                print(f"  {CALLING_TABLE}.live_response_id: column not found (unexpected - is lead_type applied?)")
            elif not needs_rewrite:
                print(f"  {CALLING_TABLE}.live_response_id: already namespaced by lead_type")
            elif args.apply:
                cur.execute(
                    f"ALTER TABLE {CALLING_TABLE} MODIFY COLUMN live_response_id VARCHAR(80) "
                    f"GENERATED ALWAYS AS ({NEW_LIVE_RESPONSE_ID_EXPR}) VIRTUAL"
                )
                print(f"  {CALLING_TABLE}.live_response_id: rewritten to namespace by lead_type")
            else:
                print(f"  {CALLING_TABLE}.live_response_id: would rewrite to namespace by lead_type")

            # Step 3: the six nps_product rating columns
            for column, coltype in PRODUCT_RATING_COLUMNS.items():
                if _column_exists(cur, CALLING_TABLE, column):
                    print(f"  {CALLING_TABLE}.{column}: already present")
                elif args.apply:
                    cur.execute(f"ALTER TABLE {CALLING_TABLE} ADD COLUMN {column} {coltype} NULL")
                    print(f"  {CALLING_TABLE}.{column}: added")
                else:
                    print(f"  {CALLING_TABLE}.{column}: would add")

            # Step 4: calling_process_dispositions.lead_type (+ index)
            if _column_exists(cur, DISP_TABLE, "lead_type"):
                print(f"  {DISP_TABLE}.lead_type: already present")
            elif args.apply:
                cur.execute(f"ALTER TABLE {DISP_TABLE} ADD COLUMN lead_type VARCHAR(16) NULL")
                print(f"  {DISP_TABLE}.lead_type: added")
            else:
                print(f"  {DISP_TABLE}.lead_type: would add")

            if _index_exists(cur, DISP_TABLE, DISP_INDEX_NAME):
                print(f"  index {DISP_INDEX_NAME}: already present")
            elif args.apply:
                _try_optional_ddl(
                    cur,
                    f"CREATE INDEX {DISP_INDEX_NAME} ON {DISP_TABLE} (process_key, lead_type, sort_order)",
                    f"index {DISP_INDEX_NAME}", "INDEX",
                    ["this one is pure lookup speed and the table holds tens of rows, so its",
                     "absence is not measurable - every query still returns the same answer."],
                )
            else:
                print(f"  index {DISP_INDEX_NAME}: would add")

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
