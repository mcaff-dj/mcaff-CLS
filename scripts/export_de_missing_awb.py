#!/usr/bin/env python3
"""Read-only: every Delivery_escalation row with no awb_code (NULL or blank), written to a local
CSV. No writes to the DB. Same columns the app's own ticket-list export uses (see EXPORT_COLUMNS
in app/delivery-escalation/DeliveryEscalationClient.js), so this can be opened/filtered the same
way. Not scoped to any one tab/view - a missing AWB can happen to a Fresh, Resolved, Forced RTO,
or New Order Placed ticket alike.
"""
import csv
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib

COLUMNS = [
    "id", "brand", "order_id", "awb_code", "new_order_AWB", "ticket_number",
    "delivery_partner", "query_class", "query_category", "wh_name",
    "status_as_per_awb", "tat", "contact_count", "first_added_date",
    "agent_email", "outcome", "child_disposition", "agent_remarks",
    "disposed_at", "added_date", "order_date",
]

OUT_PATH = Path(__file__).resolve().parent.parent / f"de_missing_awb_{datetime.now():%Y%m%d_%H%M%S}.csv"


def main():
    cols_sql = ", ".join(COLUMNS)
    rows = mysql_lib.query(
        f"SELECT {cols_sql} FROM Delivery_escalation WHERE awb_code IS NULL OR awb_code = '' ORDER BY id DESC",
        database="PEP_CLS")
    if rows is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    with open(OUT_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        writer.writerows(rows)

    print(f"{len(rows)} row(s) with no AWB written to {OUT_PATH}")


if __name__ == "__main__":
    main()
