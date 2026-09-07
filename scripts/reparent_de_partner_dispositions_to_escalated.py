#!/usr/bin/env python3
"""One-off data fix for the Delivery-Escalation Partner disposition tree (role_scope='Partner' on
calling_process_dispositions - see docs/superpowers/specs/2026-08-28-per-team-dispositions-design.md
and scripts/migrate_delivery_escalation_role_dispositions.py, which created this tree as a flat
clone of the shared one before it got hand-edited into today's flat 7-option shape).

Ticket-tab placement is decided purely by the stored `outcome` string (see DE_FRESH_WHERE/
DE_RESOLVED_WHERE/DE_FORCED_RTO_WHERE in api/_lib/db.js), which is built by joining the agent's
disposition PATH with ' > ' - so a flat top-level option produces a bare root outcome, and only
nesting under the right root sends it to the right tab. Mapping asked for:

  Partner picks RTO       -> stays a top-level 'RTO' leaf. api/_lib/db.js's applyRtoMbpOverride
                             already relabels any root-'RTO' outcome to 'RTO_MBP' for a Partner-
                             role agent (existing code, no data change needed) - RTO_MBP matches
                             DE_RTO_ROOT_SQL, so it lands in Forced RTO.
  Partner picks Delivered -> stays a top-level 'Delivered' leaf, already matches DE_RESOLVED_WHERE.
                             No data change needed.
  Everything else         -> currently flat top-level leaves (In-Transit, Invalid AWB#,
                             Lost/Damaged, NDR, Out for Delivery). Stored bare, none of these match
                             DE_FRESH_WHERE, DE_RESOLVED_WHERE, or DE_FORCED_RTO_WHERE - a ticket
                             disposed with one would land in NO tab at all (the "silent
                             disappearance" DE_RESOLVED_WHERE's own comment warns about). Reparenting
                             them under a new top-level 'Escalated' node makes the stored outcome
                             'Escalated > <label>', which DE_FRESH_WHERE's Escalated clause already
                             matches (excluded only for the literal 'Escalated > New order placed'
                             path, which none of these are) - "unresolved, stays in Fresh", exactly
                             the ask.

Only touches role_scope='Partner' rows for process_key='deliveryescalation'. RTO/Delivered are left
exactly where they are (still top-level, no reparent). Idempotent: skipped entirely if the
'Escalated' parent already exists.

Dry-run by default; --apply performs the writes.
"""
import argparse
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "calling_process_dispositions"
PROCESS_KEY = "deliveryescalation"
ROLE_SCOPE = "Partner"
ESCALATED_LABEL = "Escalated"
# Reparented as-is, in this display order under the new Escalated node.
TO_REPARENT = ["In-Transit", "Invalid AWB#", "Lost/Damaged", "NDR", "Out for Delivery"]
CREATED_BY = "script:reparent_de_partner_dispositions"


def _partner_rows(cur):
    cur.execute(
        f"SELECT id, parent_id, label, sort_order FROM {TABLE} "
        "WHERE process_key = %s AND role_scope = %s ORDER BY sort_order, id",
        (PROCESS_KEY, ROLE_SCOPE),
    )
    return list(cur.fetchall())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="perform the writes (default: dry run)")
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
            rows = _partner_rows(cur)
            by_label = {r[2]: r for r in rows if r[1] is None}  # top-level only

            if ESCALATED_LABEL in by_label:
                print(f"  '{ESCALATED_LABEL}' already exists (id {by_label[ESCALATED_LABEL][0]}) - nothing to do")
                conn.rollback()
                return

            targets = [by_label[label] for label in TO_REPARENT if label in by_label]
            missing = [label for label in TO_REPARENT if label not in by_label]
            if missing:
                print(f"  not found (already reparented, renamed, or never existed): {missing}")
            if not targets:
                print("  nothing to reparent")
                conn.rollback()
                return

            print(f"  would create top-level '{ESCALATED_LABEL}' and reparent: {[t[2] for t in targets]}")
            if not args.apply:
                conn.rollback()
                print("dry run - nothing written (re-run with --apply)")
                return

            next_top_sort = max((r[3] or 0) for r in rows if r[1] is None) + 1
            cur.execute(
                f"INSERT INTO {TABLE} (process_key, role_scope, parent_id, label, sort_order, created_by) "
                "VALUES (%s, %s, NULL, %s, %s, %s)",
                (PROCESS_KEY, ROLE_SCOPE, ESCALATED_LABEL, next_top_sort, CREATED_BY),
            )
            escalated_id = cur.lastrowid
            for i, t in enumerate(targets):
                cur.execute(
                    f"UPDATE {TABLE} SET parent_id = %s, sort_order = %s WHERE id = %s",
                    (escalated_id, i, t[0]),
                )
                print(f"  reparented '{t[2]}' (id {t[0]}) under '{ESCALATED_LABEL}' (id {escalated_id})")

        conn.commit()
        print("committed")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
