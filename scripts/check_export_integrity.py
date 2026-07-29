#!/usr/bin/env python3
"""Post-run integrity check for the ticket-export tabs (hyphen/mcaffeine).

export_recurring.py and backfill_gap_cleaned.py already refuse to WRITE a row
whose "Created At" doesn't match Flowcall's fixed date format - the signal
(lib.CREATED_AT_PATTERN) for a column-shifted row, where an unescaped
comma/newline inside a free-text field in Flowcall's CSV export pushes every
later column over by one. This script is the other half: run it AFTER an
export so any row that still landed in the sheet malformed - because it went
through the older, unguarded export_resolved_tickets.py path, or predates the
guard - gets caught too.

The documented failure mode is a *whole row* shifted over by a fixed number
of columns, so correction works by testing every shift amount against the
row: if exactly one shift realigns "Created At" with the expected pattern,
that's an unambiguous fix and the row is rewritten in place. If zero or more
than one shift amount would work, guessing is riskier than leaving it broken,
so the row is instead deleted from the tab (so it stops polluting reports)
and appended, in full, to data/export-logs/column-shift-quarantine.log for a
human to reprocess.
"""
import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"
QUARANTINE_LOG = Path(__file__).resolve().parent.parent / "data" / "export-logs" / "column-shift-quarantine.log"


def try_correct_row(row, idx_created_at, width):
    """If exactly one column-shift amount realigns idx_created_at with the
    expected date pattern, return the corrected (same-width) row. Otherwise
    None - more than one candidate means the shift amount is ambiguous."""
    candidates = []
    for k in range(-(width - 1), width):
        if k == 0:
            continue
        src = idx_created_at - k
        if 0 <= src < len(row) and lib.CREATED_AT_PATTERN.match(str(row[src]).strip()):
            candidates.append(k)
    if len(candidates) != 1:
        return None
    k = candidates[0]
    return [(row[j - k] if 0 <= j - k < len(row) else "") for j in range(width)]


def check_tab(tab_name):
    header = lib.get_sheet_values(SHEET_ID, f"'{tab_name}'!A1:ZZ1")
    if not header:
        print(f"[{tab_name}] no header row - skipping integrity check")
        return
    headers = header[0]
    width = len(headers)
    if "Created At" not in headers:
        print(f"[{tab_name}] no 'Created At' column - skipping integrity check")
        return
    idx_created_at = headers.index("Created At")
    idx_ticket_number = headers.index("Ticket Number") if "Ticket Number" in headers else -1
    last_col = lib.get_column_letter(width - 1)

    rows = lib.get_sheet_rows_chunked(SHEET_ID, tab_name, last_col)
    bad = []
    for i, row in enumerate(rows):
        val = row[idx_created_at] if len(row) > idx_created_at else ""
        if not lib.CREATED_AT_PATTERN.match(str(val).strip()):
            bad.append((i + 2, row))  # 1-based sheet row number (row 1 is the header)

    if not bad:
        print(f"[{tab_name}] integrity check OK - {len(rows)} rows, 0 malformed 'Created At'")
        return

    print(f"[{tab_name}] integrity check found {len(bad)} row(s) with malformed 'Created At'")

    corrected_count = 0
    quarantine_row_numbers = []
    quarantine_entries = []
    for row_num, row in bad:
        corrected = try_correct_row(row, idx_created_at, width)
        if corrected is not None:
            lib.set_sheet_rows_at_row(SHEET_ID, tab_name, [corrected], row_num)
            ticket = corrected[idx_ticket_number] if idx_ticket_number >= 0 else "?"
            print(f"[{tab_name}] AUTO-CORRECTED row {row_num} (Ticket {ticket}) - realigned column shift")
            corrected_count += 1
        else:
            ticket = row[idx_ticket_number] if idx_ticket_number >= 0 and len(row) > idx_ticket_number else "?"
            print(f"[{tab_name}] QUARANTINING row {row_num} (Ticket {ticket}) - ambiguous/no safe correction")
            quarantine_row_numbers.append(row_num)
            quarantine_entries.append((row_num, row))

    if quarantine_row_numbers:
        QUARANTINE_LOG.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().astimezone().isoformat()
        with open(QUARANTINE_LOG, "a", encoding="utf-8") as f:
            for row_num, row in quarantine_entries:
                f.write(f"[{stamp}] {tab_name} row {row_num}: {row}\n")
        lib.delete_sheet_rows_multi(SHEET_ID, tab_name, quarantine_row_numbers)
        print(f"[{tab_name}] removed {len(quarantine_row_numbers)} row(s) from the tab and logged them to "
              f"{QUARANTINE_LOG} for manual reprocessing")

    print(f"[{tab_name}] integrity check done - {corrected_count} auto-corrected, "
          f"{len(quarantine_row_numbers)} quarantined")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab-name", required=True, choices=["hyphen", "mcaffeine"])
    args = parser.parse_args()
    check_tab(args.tab_name)


if __name__ == "__main__":
    main()
