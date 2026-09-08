#!/usr/bin/env python3
"""Read-only diagnostic for "agent is Online but not being auto-assigned NPS-Calling
detractor leads" after setting their per-agent Process filter (Delivery/Product/Both).

For each email given, prints:
  - their calling_agent_process row (status, quota, brand filter, process/lead-type filter)
  - current undisposed load in CLS_NPS_calling (against their quota)
  - how many eligible-but-unclaimed candidates exist in whichever pool(s) their filter allows,
    replicating peekDeliveryDetractorCandidates/peekProductDetractorCandidates's own WHERE
    clause (nps_category = 'Detractor', not already in CLS_NPS_calling, submitted_date within
    30 days, brand filter applied)

No writes. Usage: python scripts/debug_detractor_lead_type_filter.py ali@x.com shilpa@x.com
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"


def main():
    emails = sys.argv[1:]
    if not emails:
        raise SystemExit("Usage: python scripts/debug_detractor_lead_type_filter.py <email> [email...]")

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
        for email in emails:
            email = email.strip().lower()
            print(f"\n=== {email} ===")
            cur.execute(
                "SELECT status, max_quota, detractor_brand_filter, detractor_lead_type_filter, updated_at "
                "FROM calling_agent_process WHERE email = %s AND process_key = 'detractor'",
                (email,),
            )
            row = cur.fetchone()
            if not row:
                print("  NO calling_agent_process row for this email/process at all.")
                continue
            print(f"  status={row['status']} max_quota={row['max_quota']} "
                  f"brand_filter={row['detractor_brand_filter']!r} "
                  f"lead_type_filter={row['detractor_lead_type_filter']!r} "
                  f"updated_at={row['updated_at']}")

            cur.execute(
                "SELECT COUNT(*) AS n FROM CLS_NPS_calling "
                "WHERE agent_email = %s AND disposed_at IS NULL",
                (email,),
            )
            load = cur.fetchone()["n"]
            quota = row["max_quota"] if row["max_quota"] is not None else 15
            print(f"  current undisposed load = {load} / quota {quota}"
                  f"{' (AT/OVER QUOTA - no auto-fill expected, not a bug)' if load >= quota else ''}")

            brand_filter = row["detractor_brand_filter"] or ""
            lead_type_filter = row["detractor_lead_type_filter"] or ""
            pools = ["delivery", "product"] if not lead_type_filter else [lead_type_filter]

            for pool in pools:
                table = "nps_delivery" if pool == "delivery" else "nps_product"
                brand_col = "brand"
                if pool == "delivery":
                    cur.execute(
                        f"""
                        SELECT COUNT(*) AS n FROM {table} d
                        LEFT JOIN CLS_NPS_calling c ON c.response_id = d.response_id
                        WHERE d.nps_category = 'Detractor' AND c.response_id IS NULL
                          AND (%s = '' OR d.{brand_col} = %s)
                          AND STR_TO_DATE(d.submitted_date, '%%d/%%m/%%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                        """,
                        (brand_filter, brand_filter),
                    )
                else:
                    cur.execute(
                        f"""
                        SELECT COUNT(*) AS n FROM (
                          SELECT p.response_id
                          FROM {table} p
                          LEFT JOIN CLS_NPS_calling c ON c.response_id = p.response_id
                          WHERE c.response_id IS NULL
                            AND (%s = '' OR p.{brand_col} = %s)
                            AND STR_TO_DATE(p.submitted_date, '%%d/%%m/%%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                          GROUP BY p.response_id
                          HAVING MIN(p.nps_category) = 'Detractor'
                        ) x
                        """,
                        (brand_filter, brand_filter),
                    )
                n = cur.fetchone()["n"]
                print(f"  eligible unclaimed candidates in {pool} pool (brand_filter={brand_filter!r}): {n}"
                      f"{' -> POOL IS EMPTY, zero assignment is expected, not a bug' if n == 0 else ' -> should have been claimable'}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
