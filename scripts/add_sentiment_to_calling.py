#!/usr/bin/env python3
"""One-off: adds sentiment (VARCHAR(10): Positive/Neutral/Negative) and sentiment_reason
(TEXT: one-line justification) to CLS_NPS_calling - AI-classified sentiment of a lead's own
additional_feedback, computed once at assignment time (api/_lib/db.js's getNextDetractorLead,
via api/_lib/sentiment.js) and shown on the calling card.

Column add only - same caveats as the other add_*_to_calling.py scripts: no backfill of
existing rows (nothing to classify them with retroactively without re-running the classifier
against their own additional_feedback, which this script deliberately does not do - it only
adds the columns).

Idempotent - each ADD COLUMN is skipped if it already exists. Dry-run by default; --apply
performs the ALTERs.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "CLS_NPS_calling"

NEW_COLUMNS = {
    "sentiment": "VARCHAR(10)",
    "sentiment_reason": "TEXT",
}


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the ALTER TABLEs (default is a dry run).")
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
        added = skipped = 0
        for column, ddl in NEW_COLUMNS.items():
            if _column_exists(cur, column):
                print(f"{TABLE}.{column} already exists - skipping.")
                skipped += 1
                continue
            print(f"Plan: ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
            if args.apply:
                cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl}")
                conn.commit()
                print("  added.")
            added += 1
        if not args.apply:
            print(f"\nDry run - {added} column(s) would be added, {skipped} already exist. Re-run with --apply to write.")
        else:
            print(f"\nAdded {added} column(s); {skipped} already existed.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
