#!/usr/bin/env python3
"""One-off backfill: retags every existing Delivery_escalation row still carrying the OLD
'Resolved > New order placed' outcome to the CURRENT path, 'Escalated > New order placed' - the
admin-configured disposition tree's 'New order placed' child was moved from the 'Resolved' root
to the 'Escalated' root. See CATEGORY_DISPOSITION in auto_dispose_de_categories.py and
DE_NEW_ORDER_PLACED_WHERE/DE_FRESH_WHERE in api/_lib/db.js - both already match EITHER string, so
running this is optional for correctness (nothing breaks if it's never run); it just stops old
and new rows from disagreeing on which root they sit under, and lets you eventually drop the
old-string branch from those two constants.

Only outcome changes - disposed_at/agent_email/agent_remarks/child_disposition (generated off
outcome) are left exactly as they were. This is a label rename, not a re-disposal.

Dry-run by default (prints the count); --apply performs the UPDATE.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib

OLD_OUTCOME = "Resolved > New order placed"
NEW_OUTCOME = "Escalated > New order placed"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the UPDATE (default is a dry run).")
    args = ap.parse_args()

    got = mysql_lib.query(
        "SELECT COUNT(*) FROM Delivery_escalation WHERE outcome = %s",
        params=(OLD_OUTCOME,), database="PEP_CLS")
    if got is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    n = got[0][0]
    print(f"{n} row(s) currently carry outcome = {OLD_OUTCOME!r}")

    if not args.apply:
        print(f"DRY RUN - would UPDATE them to outcome = {NEW_OUTCOME!r}. Re-run with --apply to perform it.")
        return
    if n == 0:
        print("Nothing to do.")
        return

    updated = mysql_lib.execute(
        "UPDATE Delivery_escalation SET outcome = %s WHERE outcome = %s",
        params=(NEW_OUTCOME, OLD_OUTCOME), database="PEP_CLS")
    print(f"Updated {updated} row(s) to outcome = {NEW_OUTCOME!r}.")


if __name__ == "__main__":
    main()
