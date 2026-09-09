#!/usr/bin/env python3
"""Read-only: what are the rows in Delivery_escalation that don't match ANY of the four ticket-
list views (Fresh/Resolved/Forced RTO/New Order Placed)? Overview's own total tile counts every
row; the four tabs' tiles each count DISTINCT awb_code under their own outcome/tat predicate
(see DE_FRESH_WHERE/DE_RESOLVED_WHERE/DE_FORCED_RTO_WHERE/DE_NEW_ORDER_PLACED_WHERE in
api/_lib/db.js) - if those four don't sum to the total, the difference is rows with an outcome
(or tat combination) none of the four predicates recognize, invisible to every tab. This mirrors
those exact predicates in SQL (copy, not import - this runs standalone) to find out what those
rows actually look like: their outcome value, whether awb_code/tat is set. No writes.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib

RTO_ROOT = "(outcome = 'RTO' OR outcome LIKE 'RTO > %%' OR outcome = 'RTO_MBP' OR outcome LIKE 'RTO_MBP > %%')"
FORCED_RTO = f"((tat IS NOT NULL AND tat = 'Forced to be marked as RTO') OR (outcome IS NOT NULL AND {RTO_ROOT}))"
FRESH = f"""((outcome IS NULL OR outcome = ''
   OR {RTO_ROOT}
   OR (outcome = 'Escalated' OR (outcome LIKE 'Escalated > %%' AND outcome <> 'Escalated > New order placed')))
   AND NOT ({FORCED_RTO}))"""
RESOLVED = "(outcome = 'Delivered' OR outcome LIKE 'Delivered > %%' OR outcome = 'Resolved' OR outcome LIKE 'Resolved > %%')"
NEW_ORDER_PLACED = "(outcome = 'Escalated > New order placed')"

ORPHAN_WHERE = f"NOT ({FRESH}) AND NOT ({RESOLVED}) AND NOT ({FORCED_RTO}) AND NOT ({NEW_ORDER_PLACED})"


def main():
    total = mysql_lib.query("SELECT COUNT(*) FROM Delivery_escalation", database="PEP_CLS")
    if total is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    print(f"Total rows in Delivery_escalation: {total[0][0]}")

    orphan_count = mysql_lib.query(
        f"SELECT COUNT(*), COUNT(DISTINCT awb_code) FROM Delivery_escalation WHERE {ORPHAN_WHERE}",
        database="PEP_CLS")
    print(f"Orphan rows (match none of the 4 views): {orphan_count[0][0]} rows, "
          f"{orphan_count[0][1]} distinct AWBs\n")
    if orphan_count[0][0] == 0:
        print("No orphan rows - the gap isn't outcome-shaped. Check for a counting-convention "
              "difference (e.g. Overview's total vs. each tab's own DISTINCT-AWB tile) instead.")
        return

    print("Breakdown by outcome (top 20), NULL/blank shown as '<blank>':")
    rows = mysql_lib.query(f"""
        SELECT COALESCE(NULLIF(outcome, ''), '<blank>') AS outcome_val, tat,
               SUM(CASE WHEN awb_code IS NULL OR awb_code = '' THEN 1 ELSE 0 END) AS no_awb,
               COUNT(*) AS n
        FROM Delivery_escalation
        WHERE {ORPHAN_WHERE}
        GROUP BY outcome_val, tat
        ORDER BY n DESC
        LIMIT 20
    """, database="PEP_CLS")
    for outcome_val, tat, no_awb, n in rows:
        print(f"  outcome={outcome_val!r:45} tat={tat!r:35} no_awb={no_awb:5} count={n}")

    print("\nSample rows (up to 10), for a closer look:")
    sample = mysql_lib.query(f"""
        SELECT id, brand, order_id, awb_code, outcome, tat, added_date, disposed_at
        FROM Delivery_escalation
        WHERE {ORPHAN_WHERE}
        ORDER BY id DESC
        LIMIT 10
    """, database="PEP_CLS")
    for r in sample:
        print(f"  {r}")


if __name__ == "__main__":
    main()
