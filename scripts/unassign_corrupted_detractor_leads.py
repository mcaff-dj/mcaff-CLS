#!/usr/bin/env python3
"""One-off: deletes CLS_NPS_calling rows whose agent_email got corrupted into a comma-joined
multi-address string (e.g. "shilpa.mallah@mcaffeine.com,tushal.nimbhore@mcaffeine.com") instead
of one real agent's email - found 2026-09-08, cause not yet identified.

Deleting an undisposed row is exactly "unassign": CLS_NPS_calling's own row IS the claim marker
(peekDeliveryDetractorCandidates/peekProductDetractorCandidates exclude via
LEFT JOIN ... IS NULL), so removing it makes the underlying nps_delivery/nps_product response
claimable again by a real agent. Refuses to touch any row that's already disposed - a
comma-joined agent_email on a disposed row is a labeling bug, not an assignment to undo, and
deleting it would destroy a real disposition record.

Dry-run by default (lists what would be deleted). --apply performs the DELETE.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Actually delete (default is a dry run).")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database="PEP_CLS", port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT response_id, agent_email, lead_type, disposed_at FROM CLS_NPS_calling "
            "WHERE agent_email LIKE '%,%' ORDER BY assigned_at"
        )
        rows = cur.fetchall()
        if not rows:
            print("No comma-joined agent_email rows found.")
            return

        undisposed = [r for r in rows if r["disposed_at"] is None]
        disposed = [r for r in rows if r["disposed_at"] is not None]

        print(f"Found {len(rows)} corrupted row(s): {len(undisposed)} undisposed, {len(disposed)} already disposed.")
        for r in undisposed:
            print(f"  would delete: {r['response_id']} ({r['lead_type']}) agent_email={r['agent_email']!r}")
        if disposed:
            print("Leaving these alone (already disposed, not touching real disposition records):")
            for r in disposed:
                print(f"  SKIP (disposed): {r['response_id']} agent_email={r['agent_email']!r}")

        if not args.apply:
            print("\nDry run - re-run with --apply to delete the undisposed rows above.")
            return

        ids = [r["response_id"] for r in undisposed]
        if not ids:
            print("Nothing undisposed to delete.")
            return
        placeholders = ", ".join(["%s"] * len(ids))
        cur.execute(
            f"DELETE FROM CLS_NPS_calling WHERE response_id IN ({placeholders}) AND disposed_at IS NULL",
            ids,
        )
        conn.commit()
        print(f"Deleted {cur.rowcount} row(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
