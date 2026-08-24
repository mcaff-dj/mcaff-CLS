#!/usr/bin/env python3
"""One-off: push a local xlsx export (same 300+ column FlowCall ticket-export
shape as the live 'hyphen' source tab - confirmed by its "HYPT..." Ticket
Numbers) into the Hyphen dashboard sheet, reusing push_hyphen_to_dashboard's
mapping/dedup/formula logic verbatim - the only difference from the normal
run is where the source rows come from.

Dedup is still by Ticket No against whatever is already in the dashboard
tab, so re-running this against the same xlsx is a no-op the second time.

This file's 'Created At' column is month-first (e.g. "8/1/2026" = Aug 1),
the opposite of the live source tab's day-first format that
parse_flowcall_date assumes - reordered to day-first below, before handing
rows to the shared push logic, so that parser (kept day-first for the live
pipeline it's normally fed) reads the right date.
"""
import datetime
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import openpyxl
import push_hyphen_to_dashboard as push

XLSX_PATH = Path(__file__).resolve().parent.parent / "migrate.xlsx"

CREATED_AT_MONTH_FIRST = re.compile(
    r"^(\d{1,2})/(\d{1,2})/(\d{4}),?\s*(\d{1,2}:\d{2}:\d{2}\s*(?:am|pm))$", re.IGNORECASE)


def to_day_first(value):
    """'8/1/2026, 7:50:10 AM' (month/day/year, as this xlsx stores it) ->
    '1/8/2026, 7:50:10 AM' (day/month/year, what parse_flowcall_date
    expects) - same instant, digits reordered only."""
    m = CREATED_AT_MONTH_FIRST.match(str(value).strip())
    if not m:
        return value
    month, day, year, time_part = m.groups()
    return f"{day}/{month}/{year}, {time_part}"


def cell_to_value(c):
    """openpyxl hands back real datetime/date objects for date-formatted
    cells - not JSON-serializable for the Sheets API PUT, unlike every other
    value here (which is already a plain str/int/float). Stringified to the
    one ISO format parse_flowcall_date already recognizes, so those cells
    parse correctly downstream instead of just failing to serialize."""
    if c is None:
        return ""
    if isinstance(c, datetime.date):
        if not isinstance(c, datetime.datetime):
            c = datetime.datetime.combine(c, datetime.time())
        return c.strftime("%Y-%m-%dT%H:%M:%SZ")
    return c


def load_xlsx_rows(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    headers = list(next(rows_iter))
    rows = [[cell_to_value(c) for c in r] for r in rows_iter]
    idx_created_at = headers.index("Created At")
    for r in rows:
        r[idx_created_at] = to_day_first(r[idx_created_at])
    return headers, rows


def self_check():
    assert to_day_first("8/1/2026, 7:50:10 AM") == "1/8/2026, 7:50:10 AM"
    assert to_day_first("7/31/2026, 4:33:35 PM") == "31/7/2026, 4:33:35 PM"
    assert to_day_first("") == ""  # non-matching input passed through unchanged
    assert cell_to_value(None) == ""
    assert cell_to_value("plain text") == "plain text"
    assert cell_to_value(datetime.datetime(2026, 8, 22, 17, 51, 16)) == "2026-08-22T17:51:16Z"
    assert cell_to_value(datetime.date(2026, 8, 22)) == "2026-08-22T00:00:00Z"
    print("self-check ok")


def main():
    if "--self-check" in sys.argv:
        return self_check()
    if not XLSX_PATH.exists():
        raise SystemExit(f"not found: {XLSX_PATH}")
    headers, rows = load_xlsx_rows(XLSX_PATH)
    print(f"[migrate] {XLSX_PATH.name}: {len(rows)} rows, {len(headers)} columns")
    pushed = push.push_rows_to_dashboard(headers, rows)
    print(f"[migrate] done - {pushed} row(s) appended")


if __name__ == "__main__":
    main()
