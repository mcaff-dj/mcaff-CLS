#!/usr/bin/env python3
"""Adds PEP_CLS.calling_process_dispositions.team_id and clones today's shared NDR disposition
tree into every existing active NDR team (see
docs/superpowers/specs/2026-08-28-per-team-dispositions-design.md).

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER TABLE
anywhere in api/ - so a new TABLE ships itself with the Lambda deploy while a new COLUMN cannot.
Running this BEFORE that deploy is not optional: api/ code selecting a missing column throws
ER_BAD_FIELD_ERROR inside getProcessDispositions, which serves the Escalation desk's dispose
modal as well as NDR's.

team_id NULL means SHARED (the fallback tree every process uses today), not "unassigned". Existing
rows stay NULL and every process with fewer than two active teams keeps reading them, so applying
this early is safe and reversible: DROP COLUMN team_id restores exactly today's behaviour, and
cloned rows carry created_by = 'migration' so a partial run can be removed by that alone.

Cloning is per team and skipped for any team that already has rows of its own, which is what makes
the whole script safe to re-run.

Dry-run by default; --apply performs the DDL and the inserts.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_process_dispositions"
TEAMS_TABLE = "calling_teams"
PROCESS_KEY = "ndr"
CLONE_CREATED_BY = "migration"
INDEX_NAME = "calling_process_dispositions_team_idx"


def plan_tree_clone(rows):
    """Flat (id, parent_id, label, description, sort_order, children_input_type) rows -> an insert
    plan, parents before children, with real ids replaced by temp keys. Inserting a copy with the
    ORIGINAL parent_id would hang the new rows off the source tree - the one way this clone could
    corrupt the tree it copied from. Breadth-first from the roots rather than a sort of the input,
    because sort_order is scoped per parent and gives no ordering between levels. An orphan (parent
    absent from rows) is dropped, not promoted to a root: a stray root reads as a brand-new
    top-level outcome to everything that keys off top-level labels."""
    by_parent = {}
    for row in rows or []:
        by_parent.setdefault(row[1], []).append(row)
    for children in by_parent.values():
        children.sort(key=lambda r: (r[4] or 0, r[0]))

    plan = []
    temp_key_by_id = {}
    queue = list(by_parent.get(None, []))
    while queue:
        row = queue.pop(0)
        temp_key = len(plan)
        temp_key_by_id[row[0]] = temp_key
        plan.append((
            temp_key,
            None if row[1] is None else temp_key_by_id[row[1]],
            row[2],
            row[3],
            row[4] or 0,
            row[5] or "single",
        ))
        queue.extend(by_parent.get(row[0], []))
    return plan


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
        f"FROM {TABLE} WHERE process_key = %s AND team_id IS NULL "
        "ORDER BY sort_order ASC, id ASC",
        (PROCESS_KEY,),
    )
    return list(cur.fetchall())


def _teams_needing_clone(cur):
    cur.execute(
        f"SELECT t.id, t.name FROM {TEAMS_TABLE} t "
        f"WHERE t.process_key = %s AND t.active = TRUE "
        f"  AND NOT EXISTS (SELECT 1 FROM {TABLE} d WHERE d.team_id = t.id) "
        "ORDER BY t.id",
        (PROCESS_KEY,),
    )
    return list(cur.fetchall())


def _clone_into(cur, team_id, plan):
    """Inserts the plan one row at a time, mapping temp keys to the real ids MySQL just assigned.
    One statement per row rather than executemany, because a child's parent_id is not known until
    its parent's INSERT has returned lastrowid."""
    real_id_by_temp_key = {}
    for temp_key, parent_temp_key, label, description, sort_order, input_type in plan:
        cur.execute(
            f"INSERT INTO {TABLE} "
            "(process_key, team_id, parent_id, label, description, sort_order, children_input_type, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                PROCESS_KEY,
                team_id,
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
    import pymysql

    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=int(cred.get("port", 3306)), autocommit=False,
    )
    try:
        with conn.cursor() as cur:
            # Step 1: the column and its index.
            if _column_exists(cur, "team_id"):
                print("  column team_id: already present")
            elif args.apply:
                cur.execute(
                    f"ALTER TABLE {TABLE} ADD COLUMN team_id INT NULL, "
                    f"ADD CONSTRAINT {TABLE}_team_fk FOREIGN KEY (team_id) "
                    f"REFERENCES {TEAMS_TABLE}(id) ON DELETE CASCADE"
                )
                print("  column team_id: added")
            else:
                print("  column team_id: would add (with FK to calling_teams, ON DELETE CASCADE)")

            if _column_exists(cur, "team_id"):
                if _index_exists(cur, INDEX_NAME):
                    print(f"  index {INDEX_NAME}: already present")
                elif args.apply:
                    cur.execute(f"CREATE INDEX {INDEX_NAME} ON {TABLE} (process_key, team_id, sort_order)")
                    print(f"  index {INDEX_NAME}: added")
                else:
                    print(f"  index {INDEX_NAME}: would add")
            else:
                print(f"  index {INDEX_NAME}: skipped on dry run (column does not exist yet)")

            # Step 2: clone the shared tree into every active team that has none. Skipped entirely
            # on a dry run before the column exists, since both queries below select team_id.
            if not _column_exists(cur, "team_id"):
                print("  clone: skipped on dry run (re-run after --apply to see per-team detail)")
                conn.rollback()
                return

            shared = _shared_tree(cur)
            plan = plan_tree_clone(shared)
            teams = _teams_needing_clone(cur)
            if not plan:
                print(f"  clone: shared '{PROCESS_KEY}' tree is empty - nothing to copy")
            elif not teams:
                print("  clone: every active team already has its own tree - nothing to do")
            for team_id, name in teams:
                if not plan:
                    break
                if args.apply:
                    _clone_into(cur, team_id, plan)
                    print(f"  clone: copied {len(plan)} option(s) into team #{team_id} ({name})")
                else:
                    print(f"  clone: would copy {len(plan)} option(s) into team #{team_id} ({name})")

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
