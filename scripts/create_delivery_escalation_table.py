#!/usr/bin/env python3
"""One-off DDL: creates MySQL PEP_CLS.Delivery_escalation - Delivery-Escalation's durable
record, the same role MySQL's CLS_RTO_calling plays for RTO (see
scripts/migrate_cls_rto_calling_schema.py). Unlike CLS_RTO_calling, this table has no
per-cycle/reassignment shape: Delivery-Escalation has no round-robin assignment robot and no
"Connected: No -> try someone else" reassignment path, so one row per ticket (upserted on
claim, updated again on resolve) is the whole lifecycle - a claim/resolve are the only two
writes api/delivery-escalation/ ever makes to this table.

Keyed on (brand, awb_code), not order_id alone: Delivery-Escalation's source sheet is two
brand-tabbed sheets (HYPHEN, mCaffeine) merged into one list client-side (see
app/delivery-escalation/DeliveryEscalationClient.js's mapRow) - brand disambiguates an AWB
that happens to collide across tabs, however unlikely.

Dry-run by default (prints the DDL); --apply creates the table. Idempotent - CREATE TABLE IF
NOT EXISTS, safe to re-run.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"

CREATE_SQL = f"""
CREATE TABLE IF NOT EXISTS `{TABLE}` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `brand` VARCHAR(32) NOT NULL,
  `order_id` VARCHAR(64) NOT NULL,
  `awb_code` VARCHAR(64) NULL,
  `delivery_partner` VARCHAR(64) NULL,
  `query_class` VARCHAR(64) NULL,
  `query_category` VARCHAR(128) NULL,
  `wh_name` VARCHAR(128) NULL,
  `status_as_per_awb` VARCHAR(64) NULL,
  `tat` VARCHAR(32) NULL,
  `agent_email` VARCHAR(255) NULL,
  `assigned_at` DATETIME NULL,
  `disposed_at` DATETIME NULL,
  `outcome` VARCHAR(255) NULL,
  `agent_remarks` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `brand_awb_key` (`brand`, `awb_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
""".strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Create the table (default is a dry run).")
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
        cur.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = %s AND table_name = %s",
            (SCHEMA, TABLE),
        )
        if cur.fetchone():
            print(f"{SCHEMA}.{TABLE} already exists - nothing to do.")
            return

        print(f"{'Applying' if args.apply else 'DRY RUN - would apply'}:\n\n{CREATE_SQL}\n")
        if not args.apply:
            print("Re-run with --apply to execute.")
            return

        cur.execute(CREATE_SQL)
        conn.commit()
        print(f"Created {SCHEMA}.{TABLE}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
