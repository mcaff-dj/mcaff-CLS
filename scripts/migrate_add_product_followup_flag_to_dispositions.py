#!/usr/bin/env python3
"""Adds PEP_CLS.calling_process_dispositions.triggers_product_followup (TINYINT(1), default 0)
and flags today's two known "ask which product?" categories - id 104 "Product Related Issue"
under NPS-Calling's Delivery tree, and id 202 "Query Class" under its Product tree - so the
feature keeps working the moment this deploys, with no admin action required.

Why this exists at all: app/nps-calling/NpsCallingClient.js's DispositionChecklist used to
decide "does checking this reason need a which-product? follow-up" by matching the checked
leaf's ANCESTOR LABELS against a hardcoded list ("Product Related Issue", then "Query Category"
after a rename, then "Query Class" after a second rename+restructure). Each rename silently
broke the follow-up - the checkbox still ticked fine, nothing downstream of it fired - because
nothing tied the two together except a string an admin could freely edit from the very editor
that was supposed to configure this. This column makes it a real, admin-configurable property of
the node itself (rendered as a checkbox in CallingAdminPanel.js's DispNode, gated by
allowProductFollowupControl - passed only from NpsCallingClient.js's Admin Panel today), so a
future rename can't unhook it again.

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER TABLE
anywhere in api/ - a new COLUMN cannot ship itself with the Lambda deploy the way a new TABLE can
(same reasoning as migrate_delivery_escalation_role_dispositions.py and
migrate_nps_calling_lead_type.py). Running this BEFORE that deploy is not optional: api/ code
selecting a missing column throws ER_BAD_FIELD_ERROR inside getProcessDispositions, which serves
every process's dispose modal, not just NPS-Calling's.

Seeding is idempotent and safe to re-run: it only ever sets the flag to 1 on those exact two ids
(scoped by process_key='detractor' too, so a same-numbered row in a completely different
process/table can never be touched), never touches any other row, and setting an already-1 value
to 1 again is a no-op. It does NOT flag every current descendant reason individually - the
ancestor-walk in DispositionChecklist means flagging just the two category nodes covers every
leaf under them, including ones added or moved later (e.g. "Packaging issue" under "Query
Class"), without needing its own flag.

Dry-run by default; --apply performs the DDL and the seed UPDATEs.
"""
import argparse
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_process_dispositions"
PROCESS_KEY = "detractor"
COLUMN = "triggers_product_followup"
# (id, label) pairs to seed - label is checked too, not just id, so this script fails loudly
# (rather than silently flagging the wrong row) if either node has since been renamed or removed.
SEED_IDS = [
    (104, "Product Related Issue"),
    (202, "Query Class"),
]


def _column_exists(cur):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, COLUMN),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL and seed updates (default: dry run)")
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
            column_exists = _column_exists(cur)
            if column_exists:
                print(f"  column {COLUMN}: already present")
            elif args.apply:
                cur.execute(f"ALTER TABLE {TABLE} ADD COLUMN {COLUMN} TINYINT(1) NOT NULL DEFAULT 0")
                print(f"  column {COLUMN}: added")
                column_exists = True
            else:
                print(f"  column {COLUMN}: would add")

            if not column_exists:
                print("  seed: skipped on dry run (re-run after --apply to see seed detail)")
                conn.rollback()
                return

            for node_id, expected_label in SEED_IDS:
                cur.execute(
                    f"SELECT label, {COLUMN} FROM {TABLE} WHERE id = %s AND process_key = %s",
                    (node_id, PROCESS_KEY),
                )
                row = cur.fetchone()
                if row is None:
                    print(f"  seed id {node_id}: NOT FOUND - skipped (has it been deleted?)")
                    continue
                label, current = row
                if label != expected_label:
                    print(f"  seed id {node_id}: label is now {label!r}, expected {expected_label!r} - "
                          "skipped (renamed since this script was written - flag it by hand in the Admin Panel instead)")
                    continue
                if current:
                    print(f"  seed id {node_id} ({label!r}): already flagged")
                elif args.apply:
                    cur.execute(f"UPDATE {TABLE} SET {COLUMN} = 1 WHERE id = %s", (node_id,))
                    print(f"  seed id {node_id} ({label!r}): flagged")
                else:
                    print(f"  seed id {node_id} ({label!r}): would flag")

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
