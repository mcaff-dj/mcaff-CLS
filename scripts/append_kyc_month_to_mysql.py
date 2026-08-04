"""One-off/monthly backfill: appends a settled month's ticket rows from each brand's live
Google Sheet into its PEP_CLS.CLS_KYC_* MySQL mirror (see kyc_source.py/brands.py's
kyc_mysql_columns). Normally that mirror is kept in sync by an external process (see
docs/CODEBASE_REFERENCE.md), but this script exists to push a specific month in directly
when needed.

Usage: python scripts/append_kyc_month_to_mysql.py "7_Jul'26" [--force]

Refuses to insert if the month already has rows in the table, since the table has no
unique key to make re-running idempotent - pass --force to skip that guard and insert
anyway (this will create duplicates unless you've deleted the existing rows first).
"""
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
import brands
import lib
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
BUFFER_ROWS = 25000


def fetch_month_rows(b, month):
    col = b["col"]
    return lib.get_sheet_tail_for_months(
        b["spreadsheet_id"], b["sheet_name"], b["last_col"], BUFFER_ROWS, col["month"], [month]
    )


def insert_rows(table, columns, rows):
    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        col_names = ", ".join(f"`{c}`" for c in columns)
        placeholders = ", ".join(["%s"] * len(columns))
        cur.executemany(f"INSERT INTO `{table}` ({col_names}) VALUES ({placeholders})", rows)
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def existing_count(table, month):
    cred = get_credential()
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) FROM `{table}` WHERE `month` = %s", (month,))
        return cur.fetchone()[0]
    finally:
        conn.close()


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    month = sys.argv[1]
    force = "--force" in sys.argv[2:]

    for b in brands.BRANDS:
        table = b.get("kyc_mysql_table")
        if not table:
            continue
        columns = b["kyc_mysql_columns"]

        existing = existing_count(table, month)
        if existing and not force:
            print(f"[{b['brand']}] {existing} row(s) already in {table} for {month} - skipping (use --force to override).")
            continue

        sheet_rows = fetch_month_rows(b, month)
        print(f"[{b['brand']}] fetched {len(sheet_rows)} sheet row(s) for {month}.")
        if not sheet_rows:
            continue

        # Table mirrors the sheet's own leading columns in this exact order (see
        # brands.py's kyc_mysql_columns comment); pad/truncate since the Sheets API
        # drops trailing empty cells per row instead of returning a fixed-width row.
        n = len(columns)
        db_rows = [tuple((row[:n] + [None] * n)[:n]) for row in sheet_rows]

        inserted = insert_rows(table, columns, db_rows)
        print(f"[{b['brand']}] inserted {inserted} row(s) into {table}.")


if __name__ == "__main__":
    main()
