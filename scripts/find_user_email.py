#!/usr/bin/env python3
"""Read-only: look up users.email/name by a name fragment, and show whether they have a
calling_agent_process row for the 'detractor' (NPS-Calling) process.

Usage: python scripts/find_user_email.py ali shilpa
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"


def main():
    fragments = sys.argv[1:]
    if not fragments:
        raise SystemExit("Usage: python scripts/find_user_email.py <name fragment> [more...]")

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        cur = conn.cursor()
        for frag in fragments:
            print(f"\n=== users matching '{frag}' ===")
            cur.execute(
                "SELECT id, email, name, is_admin FROM users WHERE name LIKE %s OR email LIKE %s",
                (f"%{frag}%", f"%{frag}%"),
            )
            rows = cur.fetchall()
            if not rows:
                print("  no matching user found")
                continue
            for r in rows:
                print(f"  id={r['id']} email={r['email']} name={r['name']} is_admin={r['is_admin']}")
                cur.execute(
                    "SELECT status, max_quota, detractor_brand_filter, detractor_lead_type_filter "
                    "FROM calling_agent_process WHERE email = %s AND process_key = 'detractor'",
                    (r["email"],),
                )
                cap = cur.fetchone()
                if cap:
                    print(f"    calling_agent_process(detractor): status={cap['status']} "
                          f"max_quota={cap['max_quota']} brand_filter={cap['detractor_brand_filter']!r} "
                          f"lead_type_filter={cap['detractor_lead_type_filter']!r}")
                else:
                    print("    calling_agent_process(detractor): NO ROW")
                cur.execute(
                    "SELECT tab_key FROM report_tab_permissions rt "
                    "WHERE rt.user_id = %s AND rt.card_key = 'calling'",
                    (r["id"],),
                )
                tabs = [t["tab_key"] for t in cur.fetchall()]
                print(f"    calling tab perms: {tabs if tabs else '(none row = unrestricted, every process)'}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
