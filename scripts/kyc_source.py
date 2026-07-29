"""Historical (settled-month) ticket rows for the main report, sourced from the PEP_CLS
CLS_KYC_mCaff / CLS_KYC_Hyphen MySQL tables - a column-for-column mirror of each brand's
primary Google Sheet (see brands.py's kyc_mysql_columns) - instead of a live Sheets pull.
Only the current, still-moving month(s) get fetched live from the sheet (see
generate_report.py); MySQL covers everything settled before that, which is both far
faster and avoids re-reading tens of thousands of rows via the Sheets API on every
refresh.
"""
import mysql_lib

KYC_DATABASE = "PEP_CLS"


def fetch_settled_rows(table, columns, exclude_months):
    """Returns sheet-shaped row lists (same column order as the brand's sheet) for every
    row whose Month isn't one of exclude_months - i.e. everything the button/schedule
    would otherwise have to re-fetch live. None if MySQL credentials aren't configured,
    so the caller can fall back to the old sheet-only incremental cache."""
    col_list = ", ".join(f"`{c}`" for c in columns)
    placeholders = ", ".join(["%s"] * len(exclude_months))
    rows = mysql_lib.query(
        f"SELECT {col_list} FROM `{table}` WHERE `month` NOT IN ({placeholders})",
        params=tuple(exclude_months),
        database=KYC_DATABASE,
    )
    if rows is None:
        return None
    return [list(r) for r in rows]
