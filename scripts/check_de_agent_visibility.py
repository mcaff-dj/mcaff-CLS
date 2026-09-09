#!/usr/bin/env python3
"""Read-only: why doesn't a given name show in the Delivery-Escalation Agent filter?
That dropdown is DISTINCT agent_email off Delivery_escalation itself (no roster - see
getDeliveryEscalationAgents in api/_lib/db.js) - a name is missing either because they've
never claimed/been assigned a row here, or their email is spelled/cased differently than
expected. Searches case-insensitively for a name fragment across every agent_email that HAS
touched a row, so a typo/case mismatch shows up as a near-miss instead of nothing at all.

Usage: python scripts/check_de_agent_visibility.py <name-fragment>
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python scripts/check_de_agent_visibility.py <name-fragment>")
    fragment = sys.argv[1]

    exact = mysql_lib.query(
        "SELECT COUNT(*) FROM Delivery_escalation WHERE LOWER(agent_email) LIKE %s",
        params=(f"%{fragment.lower()}%",), database="PEP_CLS")
    if exact is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    print(f"Rows with agent_email containing {fragment!r} (any case): {exact[0][0]}")

    close = mysql_lib.query(
        "SELECT DISTINCT agent_email FROM Delivery_escalation "
        "WHERE agent_email IS NOT NULL AND agent_email != '' ORDER BY agent_email",
        database="PEP_CLS")
    print(f"\nAll {len(close)} distinct agent_email value(s) currently in the dropdown:")
    for (email,) in close:
        print(f"  {email}")


if __name__ == "__main__":
    main()
