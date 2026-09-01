#!/usr/bin/env python3
"""Read-only diagnostic for the Overview 503s (api/delivery-escalation/record?op=stats and
op=daywise both timing out at ~30s, the Lambda/gateway ceiling).

Answers the four DB-side questions the code alone can't: how big the table actually is now,
whether the indexes from alter_delivery_escalation_add_indexes.py were ever applied, whether
an ALTER/long query is currently holding things up, and how long the two failing queries
really take (timed here, with EXPLAIN, so the number comes from the server and not a guess).

Runs nothing but SELECT/EXPLAIN/SHOW - no DDL, no writes. The two timed queries are the same
unfiltered shape the Overview tab fires on mount (getDeliveryEscalationStats and
getDeliveryEscalationDaywiseStats in api/_lib/db.js with no filters), so a slow number here
reproduces the failure server-side.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"

# Mirrors DE_RESOLVED_WHERE / DE_FRESH_WHERE etc. loosely - the point is the SHAPE (full scan,
# COUNT(DISTINCT awb_code) x N), not exact bucket parity with db.js.
STATS_SQL = f"""
SELECT COUNT(DISTINCT awb_code) AS total,
       COUNT(DISTINCT CASE WHEN agent_email IS NOT NULL AND agent_email != '' THEN awb_code END) AS assigned,
       COUNT(DISTINCT CASE WHEN disposed_at IS NOT NULL THEN awb_code END) AS resolved
FROM {TABLE} WHERE 1 = 1
"""

DAYWISE_SQL = f"""
SELECT DATE_FORMAT(added_date, '%%Y-%%m-%%d') AS d,
       COALESCE(delivery_partner, 'Unknown') AS partner,
       COALESCE(query_category, 'Unknown') AS category,
       COUNT(DISTINCT awb_code) AS c
FROM {TABLE}
WHERE added_date IS NOT NULL
GROUP BY d, partner, category
ORDER BY d
"""


def show(cur, label, sql, params=None):
    print(f"\n=== {label} ===")
    cur.execute(sql, params or ())
    rows = cur.fetchall()
    for r in rows:
        print("  ", r)
    if not rows:
        print("   (no rows)")
    return rows


def timed(cur, label, sql):
    print(f"\n=== {label} ===")
    cur.execute("EXPLAIN " + sql)
    for r in cur.fetchall():
        print("   EXPLAIN:", r)
    start = time.monotonic()
    cur.execute(sql)
    cur.fetchall()
    print(f"   ELAPSED: {time.monotonic() - start:.1f}s")


def main():
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
        show(cur, "row count", f"SELECT COUNT(*) FROM {TABLE}")
        show(cur, "distinct AWBs", f"SELECT COUNT(DISTINCT awb_code) FROM {TABLE}")
        show(cur, "indexes present",
             "SELECT index_name, column_name FROM information_schema.statistics "
             "WHERE table_schema = %s AND table_name = %s ORDER BY index_name",
             (SCHEMA, TABLE))
        show(cur, "table size / engine",
             "SELECT engine, table_rows, ROUND(data_length/1024/1024) AS data_mb, "
             "ROUND(index_length/1024/1024) AS index_mb FROM information_schema.tables "
             "WHERE table_schema = %s AND table_name = %s", (SCHEMA, TABLE))
        # Stacked/abandoned queries are the thing to look for here: Lambda gives up at 30s but
        # MySQL keeps running the query it abandoned, so a pileup shows as many long-running
        # copies of the same SELECT, or as "Waiting for table metadata lock" behind an ALTER.
        show(cur, "current activity (>2s, this table)",
             "SELECT id, user, time, state, LEFT(info, 120) FROM information_schema.processlist "
             "WHERE time > 2 AND info IS NOT NULL ORDER BY time DESC")
        timed(cur, "op=stats shape (unfiltered)", STATS_SQL)
        timed(cur, "op=daywise shape (unfiltered)", DAYWISE_SQL)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
