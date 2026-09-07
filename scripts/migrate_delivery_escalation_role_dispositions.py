#!/usr/bin/env python3
"""Adds PEP_CLS.calling_process_dispositions.role_scope and clones today's shared
Delivery-Escalation disposition tree into role_scope='Partner' (see
docs/superpowers/specs/2026-08-28-per-team-dispositions-design.md - role_scope is the same
"independent, orthogonal dimension" team_id and lead_type already are on this table, just keyed
on delivery_escalation_user_role.role instead of a team or a lead type).

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER TABLE
anywhere in api/ - so a new COLUMN cannot ship itself with the Lambda deploy the way a new TABLE
can. Running this BEFORE that deploy is not optional: api/ code selecting a missing column throws
ER_BAD_FIELD_ERROR inside getProcessDispositions, which serves NDR's and Escalation's dispose
modals as well as Delivery-Escalation's.

role_scope NULL means SHARED (the tree every role but Partner falls back to), not "unassigned".
Existing rows stay NULL, so applying this early is safe and reversible: DROP COLUMN role_scope
restores exactly today's behaviour, and cloned rows carry created_by = 'migration' so a partial
run can be removed by that alone.

Unlike team_id, role_scope carries no FOREIGN KEY - a role is a fixed label
(DELIVERY_ESCALATION_ROLES in api/admin/[action].js), not a row in another table, so there is no
REFERENCES grant to worry about (see migrate_team_dispositions.py's own long comment on that).

Cloning is skipped if role_scope='Partner' already has rows for this process, which is what makes
the whole script safe to re-run.

Dry-run by default; --apply performs the DDL and the inserts.
"""
import argparse
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential
from migrate_team_dispositions import plan_tree_clone

SCHEMA = "PEP_CLS"
TABLE = "calling_process_dispositions"
PROCESS_KEY = "deliveryescalation"
ROLE_SCOPE = "Partner"
CLONE_CREATED_BY = "migration"
INDEX_NAME = "calling_process_dispositions_role_idx"


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def _index_exists(cur, index):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, TABLE, index),
    )
    return cur.fetchone() is not None


def _shared_tree(cur):
    cur.execute(
        "SELECT id, parent_id, label, description, sort_order, children_input_type "
        f"FROM {TABLE} WHERE process_key = %s AND role_scope IS NULL "
        "ORDER BY sort_order ASC, id ASC",
        (PROCESS_KEY,),
    )
    return list(cur.fetchall())


def _partner_tree_exists(cur):
    cur.execute(
        f"SELECT 1 FROM {TABLE} WHERE process_key = %s AND role_scope = %s LIMIT 1",
        (PROCESS_KEY, ROLE_SCOPE),
    )
    return cur.fetchone() is not None


def _clone_into(cur, plan):
    """Same one-row-at-a-time shape as migrate_team_dispositions.py's _clone_into - a child's
    parent_id is not known until its parent's INSERT has returned lastrowid, so this can't be an
    executemany."""
    real_id_by_temp_key = {}
    for temp_key, parent_temp_key, label, description, sort_order, input_type in plan:
        cur.execute(
            f"INSERT INTO {TABLE} "
            "(process_key, role_scope, parent_id, label, description, sort_order, children_input_type, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                PROCESS_KEY,
                ROLE_SCOPE,
                None if parent_temp_key is None else real_id_by_temp_key[parent_temp_key],
                label,
                description,
                sort_order,
                input_type,
                CLONE_CREATED_BY,
            ),
        )
        real_id_by_temp_key[temp_key] = cur.lastrowid


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL and inserts (default: dry run)")
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
            role_scope_exists = _column_exists(cur, "role_scope")
            if role_scope_exists:
                print("  column role_scope: already present")
            elif args.apply:
                cur.execute(f"ALTER TABLE {TABLE} ADD COLUMN role_scope VARCHAR(20) NULL")
                print("  column role_scope: added")
                role_scope_exists = True
            else:
                print("  column role_scope: would add")

            # No FK privilege concern here (role_scope is a plain label, not a row in another
            # table - see the module docstring) - but CREATE INDEX needs its own INDEX grant the
            # same way migrate_team_dispositions.py/migrate_nps_calling_lead_type.py's own index
            # steps do, and this runner's grants have never included it (confirmed live: a bare
            # CREATE INDEX here raised the same 1142 those two already guard against). Swallowed
            # the same way - the column is what api/ actually needs, an index is pure lookup speed
            # on a table of tens of rows.
            if role_scope_exists:
                if _index_exists(cur, INDEX_NAME):
                    print(f"  index {INDEX_NAME}: already present")
                elif args.apply:
                    try:
                        cur.execute(f"CREATE INDEX {INDEX_NAME} ON {TABLE} (process_key, role_scope, sort_order)")
                        print(f"  index {INDEX_NAME}: added")
                    except pymysql.err.OperationalError as e:
                        if e.args[0] != 1142:
                            raise
                        print(f"  index {INDEX_NAME}: SKIPPED - {e.args[1]}")
                        print("      absence is not measurable - every query still returns the same answer.")
                        print(f"      To add it later, have a DBA run  GRANT INDEX ON `{SCHEMA}`.* TO `<user>`@`%`;")
                        print("      then re-run this script - it picks the step up on its own, nothing else to redo.")
                else:
                    print(f"  index {INDEX_NAME}: would add")
            else:
                print(f"  index {INDEX_NAME}: skipped on dry run (column does not exist yet)")

            # Clone the shared Delivery-Escalation tree into role_scope='Partner', once. Skipped
            # entirely on a dry run before the column exists, since both queries below select it.
            if not role_scope_exists:
                print("  clone: skipped on dry run (re-run after --apply to see clone detail)")
                conn.rollback()
                return

            if _partner_tree_exists(cur):
                print(f"  clone: {PROCESS_KEY} already has a Partner tree - nothing to do")
            else:
                shared = _shared_tree(cur)
                plan = plan_tree_clone(shared)
                if not plan:
                    print(f"  clone: shared '{PROCESS_KEY}' tree is empty - nothing to copy")
                elif args.apply:
                    _clone_into(cur, plan)
                    print(f"  clone: copied {len(plan)} option(s) into role_scope='{ROLE_SCOPE}'")
                else:
                    print(f"  clone: would copy {len(plan)} option(s) into role_scope='{ROLE_SCOPE}'")

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
