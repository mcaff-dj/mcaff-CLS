#!/usr/bin/env python3
"""One-off: restructures NPS-Calling's (process_key='detractor') disposition tree so
"Connected" and "Non Connected" become the only two top-level nodes.

Before: the 5 categories (Product Related Issue, App / Website Issue, Delivery Related,
Customer Support, Others - the last two added directly via Admin Panel, not by
seed_nps_calling_dispositions.py) sit at top level, alongside a pre-existing "Connected"
node that already had its own hand-added "Product Related Issue" child with 2 reasons of
its own (id 103: "Reacted to Acne and Rashes", "Product not effective") - a duplicate
label of the real, 6-reason "Product Related Issue" category (id 104).

After:
  - The 2 reasons under duplicate id 103 are moved onto the real category (id 104), then
    103 itself (now childless) is deleted - no data lost, no more duplicate label.
  - All 5 categories are reparented under "Connected".
  - A new top-level "Non Connected" node is added with 5 starter reasons (the call never
    went through, so none of the issue categories apply): Ringing / No answer, Switched
    off, Busy, Invalid/Wrong number, Call disconnected.

Every id here (102 Connected, 103 duplicate Product Related Issue, 104/111/117/124/135 the
5 categories) was confirmed by direct query against this database before writing this
script - re-run with --self-check-ids first if this is ever re-run against a different
database, since the whole point of hardcoded ids is to target the exact rows already
inspected, not to search by label again (a label search could match a category an admin
renamed to look like one of these by coincidence).

Idempotent in the sense that matters: safe to run --apply twice. The second run finds
CONNECTED_ID's children already contain all 5 categories (reparent is a no-op UPDATE),
DUPLICATE_PRODUCT_ISSUE_ID no longer exists (skipped), and NON_CONNECTED reason labels
already exist under it (skipped, same check seed_nps_calling_dispositions.py uses).

Dry-run by default; --apply performs the UPDATE/DELETE/INSERT statements.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
PROCESS_KEY = "detractor"

CONNECTED_ID = 102
DUPLICATE_PRODUCT_ISSUE_ID = 103  # "Product Related Issue" child of Connected - duplicate label, to be emptied then deleted
REAL_PRODUCT_ISSUE_ID = 104       # the real, 6-reason "Product Related Issue" - duplicate's 2 reasons move here

CATEGORY_IDS_TO_REPARENT = [104, 111, 117, 124, 135]  # Product/App/Delivery/CustomerSupport/Others

NON_CONNECTED_REASONS = [
    "Ringing / No answer", "Switched off", "Busy", "Invalid/Wrong number", "Call disconnected",
]


def _row_exists(cur, node_id):
    cur.execute(
        "SELECT 1 FROM calling_process_dispositions WHERE process_key = %s AND id = %s",
        (PROCESS_KEY, node_id),
    )
    return cur.fetchone() is not None


def _next_sort_order(cur, parent_id):
    cur.execute(
        "SELECT COALESCE(MAX(sort_order), -1) FROM calling_process_dispositions "
        "WHERE process_key = %s AND parent_id = %s",
        (PROCESS_KEY, parent_id),
    )
    return cur.fetchone()[0] + 1


def _top_level_next_sort_order(cur):
    cur.execute(
        "SELECT COALESCE(MAX(sort_order), -1) FROM calling_process_dispositions "
        "WHERE process_key = %s AND parent_id IS NULL",
        (PROCESS_KEY,),
    )
    return cur.fetchone()[0] + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the UPDATE/DELETE/INSERTs (default is a dry run).")
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

        # Step 1: fold the duplicate's 2 reasons onto the real category, then delete the duplicate.
        if _row_exists(cur, DUPLICATE_PRODUCT_ISSUE_ID):
            cur.execute(
                "SELECT id, label FROM calling_process_dispositions WHERE parent_id = %s ORDER BY sort_order",
                (DUPLICATE_PRODUCT_ISSUE_ID,),
            )
            dup_children = cur.fetchall()
            for child_id, child_label in dup_children:
                sort_order = _next_sort_order(cur, REAL_PRODUCT_ISSUE_ID)
                print(f"Plan: move \"{child_label}\" (id={child_id}) onto Product Related Issue (id={REAL_PRODUCT_ISSUE_ID}), sort_order={sort_order}")
                if args.apply:
                    cur.execute(
                        "UPDATE calling_process_dispositions SET parent_id = %s, sort_order = %s WHERE id = %s",
                        (REAL_PRODUCT_ISSUE_ID, sort_order, child_id),
                    )
                    conn.commit()
            print(f"Plan: delete now-empty duplicate \"Product Related Issue\" (id={DUPLICATE_PRODUCT_ISSUE_ID})")
            if args.apply:
                cur.execute("DELETE FROM calling_process_dispositions WHERE id = %s", (DUPLICATE_PRODUCT_ISSUE_ID,))
                conn.commit()
        else:
            print(f"Duplicate node id={DUPLICATE_PRODUCT_ISSUE_ID} already gone - skipping fold/delete.")

        # Step 2: reparent the 5 categories under Connected.
        for cat_id in CATEGORY_IDS_TO_REPARENT:
            if not _row_exists(cur, cat_id):
                print(f"category id={cat_id} not found - skipping (already moved or removed?)")
                continue
            cur.execute(
                "SELECT label, parent_id FROM calling_process_dispositions WHERE id = %s", (cat_id,)
            )
            label, parent_id = cur.fetchone()
            if parent_id == CONNECTED_ID:
                print(f"\"{label}\" (id={cat_id}) already under Connected - skipping.")
                continue
            print(f"Plan: reparent \"{label}\" (id={cat_id}) under Connected (id={CONNECTED_ID})")
            if args.apply:
                cur.execute(
                    "UPDATE calling_process_dispositions SET parent_id = %s WHERE id = %s",
                    (CONNECTED_ID, cat_id),
                )
                conn.commit()

        # Step 3: add "Non Connected" + its starter reasons.
        cur.execute(
            "SELECT id FROM calling_process_dispositions WHERE process_key = %s AND parent_id IS NULL AND label = %s",
            (PROCESS_KEY, "Non Connected"),
        )
        row = cur.fetchone()
        non_connected_id = row[0] if row else None

        if non_connected_id is not None:
            print(f"\"Non Connected\" already exists (id={non_connected_id}) - skipping creation.")
        else:
            sort_order = _top_level_next_sort_order(cur)
            print(f"Plan: add top-level \"Non Connected\" (sort_order={sort_order}, children_input_type=multi)")
            if args.apply:
                cur.execute(
                    "INSERT INTO calling_process_dispositions "
                    "(process_key, parent_id, label, sort_order, children_input_type, created_by) "
                    "VALUES (%s, NULL, %s, %s, 'multi', %s)",
                    (PROCESS_KEY, "Non Connected", sort_order, "restructure_nps_calling_dispositions.py"),
                )
                conn.commit()
                non_connected_id = cur.lastrowid

        for reason_label in NON_CONNECTED_REASONS:
            if non_connected_id is None:
                print(f"  Plan: add reason \"{reason_label}\" under Non Connected")
                continue
            cur.execute(
                "SELECT id FROM calling_process_dispositions WHERE process_key = %s AND parent_id = %s AND label = %s",
                (PROCESS_KEY, non_connected_id, reason_label),
            )
            if cur.fetchone():
                print(f"  reason already exists - skipping: Non Connected > {reason_label}")
                continue
            sort_order = _next_sort_order(cur, non_connected_id)
            print(f"  Plan: add reason \"{reason_label}\" under Non Connected (sort_order={sort_order})")
            if args.apply:
                cur.execute(
                    "INSERT INTO calling_process_dispositions "
                    "(process_key, parent_id, label, sort_order, created_by) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (PROCESS_KEY, non_connected_id, reason_label, sort_order, "restructure_nps_calling_dispositions.py"),
                )
                conn.commit()

        if not args.apply:
            print("\nDry run - re-run with --apply to write.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
