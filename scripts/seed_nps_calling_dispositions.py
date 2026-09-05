#!/usr/bin/env python3
"""One-off: seeds NPS-Calling's (process_key='detractor') disposition tree with 4 starter
categories + a handful of reasons each, and widens CLS_NPS_calling.disposition to fit a
multi-reason call (see app/nps-calling/NpsCallingClient.js's DispositionChecklist, which lets an
agent tag more than one reason - possibly across categories - per call, joined "Category >
Reason; Category > Reason" into this one column).

Both steps are idempotent / safe to re-run:
  - Column widen (VARCHAR(255) -> TEXT) is skipped if it's already TEXT (information_schema
    DATA_TYPE check first).
  - Each category/reason row is skipped if a row with that label already exists under the same
    parent for process_key='detractor' - a second run only adds whatever's still missing, so an
    admin who has already renamed/removed a starter row from Admin Panel -> Disposition List won't
    have it silently re-created out from under them, and won't get a duplicate.

These are STARTER rows only - once seeded, add/rename/reorder/delete any of them from the NPS-
Calling Admin Panel's Disposition List, same as any other process's tree
(calling_process_dispositions is fully admin-configurable already; nothing here is hardcoded into
the app).

Dry-run by default (prints the plan, no write); --apply performs the ALTER + INSERTs.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
PROCESS_KEY = "detractor"

# label, [reason labels...] - children_input_type='multi' on the category itself (its own
# children render as checkboxes, not a single-select cascade) matches DispositionChecklist's
# multi-select-per-category design.
CATEGORIES = [
    ("Product Related Issue", [
        "Damaged/defective product", "Wrong product received", "Product not as described",
        "Packaging damaged", "Expiry/freshness issue", "No visible results",
    ]),
    ("App / Website Issue", [
        "App crash or bug", "Payment/checkout failure", "Order tracking not working",
        "Difficult to navigate", "Coupon/discount not applied",
    ]),
    ("Delivery Related", [
        "Late delivery", "Delivered to wrong address", "Damaged in transit",
        "Delivery partner behavior", "Order lost/never delivered",
        "Repeated failed delivery attempts",
    ]),
    ("Customer Support", [
        "No response / slow response", "Unhelpful or rude agent", "Refund/replacement delayed",
        "Query not resolved", "Escalation mishandled",
    ]),
]


def _disposition_column_is_text(cur):
    cur.execute(
        "SELECT DATA_TYPE FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = 'CLS_NPS_calling' AND column_name = 'disposition'",
        (SCHEMA,),
    )
    row = cur.fetchone()
    return row is not None and row[0] == "text"


def _existing_id(cur, label, parent_id):
    if parent_id is None:
        cur.execute(
            "SELECT id FROM calling_process_dispositions "
            "WHERE process_key = %s AND parent_id IS NULL AND team_id IS NULL AND label = %s",
            (PROCESS_KEY, label),
        )
    else:
        cur.execute(
            "SELECT id FROM calling_process_dispositions "
            "WHERE process_key = %s AND parent_id = %s AND label = %s",
            (PROCESS_KEY, parent_id, label),
        )
    row = cur.fetchone()
    return row[0] if row else None


def _next_sort_order(cur, parent_id):
    if parent_id is None:
        cur.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM calling_process_dispositions "
            "WHERE process_key = %s AND parent_id IS NULL AND team_id IS NULL",
            (PROCESS_KEY,),
        )
    else:
        cur.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM calling_process_dispositions "
            "WHERE process_key = %s AND parent_id = %s",
            (PROCESS_KEY, parent_id),
        )
    return cur.fetchone()[0] + 1


def self_check():
    # CATEGORIES shape: (label, [reason, ...]), every label non-empty, no duplicate category
    # labels, no duplicate reason labels within one category.
    labels = [label for label, _ in CATEGORIES]
    assert len(labels) == len(set(labels)), "duplicate category label"
    for label, reasons in CATEGORIES:
        assert label.strip(), "blank category label"
        assert reasons, f"{label}: no starter reasons"
        assert len(reasons) == len(set(reasons)), f"{label}: duplicate reason label"
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the ALTER + INSERTs (default is a dry run).")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()

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

        if _disposition_column_is_text(cur):
            print("CLS_NPS_calling.disposition is already TEXT - skipping column widen.")
        else:
            print("Plan: ALTER TABLE CLS_NPS_calling MODIFY COLUMN disposition TEXT")
            if args.apply:
                cur.execute("ALTER TABLE CLS_NPS_calling MODIFY COLUMN disposition TEXT")
                conn.commit()
                print("column widened.")

        added_categories = added_reasons = skipped = 0
        for cat_label, reasons in CATEGORIES:
            cat_id = _existing_id(cur, cat_label, None)
            if cat_id is not None:
                print(f"category already exists - skipping: {cat_label}")
                skipped += 1
            else:
                sort_order = _next_sort_order(cur, None)
                print(f"Plan: add category \"{cat_label}\" (sort_order={sort_order}, children_input_type=multi)")
                if args.apply:
                    cur.execute(
                        "INSERT INTO calling_process_dispositions "
                        "(process_key, parent_id, label, sort_order, children_input_type, created_by) "
                        "VALUES (%s, NULL, %s, %s, 'multi', %s)",
                        (PROCESS_KEY, cat_label, sort_order, "seed_nps_calling_dispositions.py"),
                    )
                    conn.commit()
                    cat_id = cur.lastrowid
                added_categories += 1

            if cat_id is None:
                # Dry run and the category itself doesn't exist yet - every one of its reasons
                # is necessarily new too (nothing can exist under a parent that doesn't exist).
                for reason_label in reasons:
                    print(f"  Plan: add reason \"{reason_label}\" under {cat_label}")
                    added_reasons += 1
                continue
            for reason_label in reasons:
                if _existing_id(cur, reason_label, cat_id) is not None:
                    print(f"  reason already exists - skipping: {cat_label} > {reason_label}")
                    skipped += 1
                    continue
                sort_order = _next_sort_order(cur, cat_id)
                print(f"  Plan: add reason \"{reason_label}\" under {cat_label} (sort_order={sort_order})")
                if args.apply:
                    cur.execute(
                        "INSERT INTO calling_process_dispositions "
                        "(process_key, parent_id, label, sort_order, created_by) "
                        "VALUES (%s, %s, %s, %s, %s)",
                        (PROCESS_KEY, cat_id, reason_label, sort_order, "seed_nps_calling_dispositions.py"),
                    )
                    conn.commit()
                added_reasons += 1

        if not args.apply:
            print(f"\nDry run - {added_categories} categor(y/ies) and {added_reasons} reason(s) would be "
                  f"added, {skipped} already exist. Re-run with --apply to write.")
        else:
            print(f"\nAdded {added_categories} categor(y/ies), {added_reasons} reason(s); {skipped} already existed.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
