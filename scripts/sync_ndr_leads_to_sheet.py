"""Step 1 of standing up NDR Calling: syncs assignable NDR leads (see ndr_source.py) into
a Google Sheet, the same role scripts/assign_leads.py's own "Data" tab plays for RTO. Step 2
is scripts/assign_ndr_leads.py, which reads FROM this sheet and writes agent assignments into
columns P (assigned_agent) / Q (assigned_at), which this script never touches.

Upserts by awb_number rather than a full clear+rewrite: an earlier version cleared and
rewrote the whole sheet every run, which would silently wipe assign_ndr_leads.py's P/Q columns
on the very next sync. Now each run only ever writes its own source columns (A through
LAST_SOURCE_COL) - an existing awb gets its source fields refreshed in place (which is also
how a changed courier_final_status reaches the sheet - see ndr_source.py), a new awb gets
appended after the current last row. A row whose awb drops out of yesterday's window (or gone
RTO) is left exactly as it was - there's no "done" signal for NDR leads yet, so deleting it
risks discarding an agent's in-progress work on it.

awb_number is the only duplicate check this needs: ndr_source.py's GROUP BY already guarantees
one row per awb per fetch, and existing_row_by_awb below guarantees that awb never gets a
second row in the sheet even across many days of runs - a repeat sighting of the same awb is
always an update to its existing row, never a new one.
"""
import lib
import ndr_source

SPREADSHEET_ID = "1oRPRvZaGpgQsZyXO_Q_j5HEZO1nkrFv0spTobfDoQ2g"
SHEET_TAB = "Sheet1"
HEADERS = ndr_source.COLUMNS
LAST_SOURCE_COL = lib.get_column_letter(len(HEADERS) - 1)  # P onward is assign_ndr_leads.py's
CHUNK_SIZE = 300  # matches lib.set_sheet_rows_at_row's own chunking


def main():
    rows = ndr_source.fetch_ndr_candidates()
    if rows is None:
        raise SystemExit("MySQL credentials not configured - cannot sync.")
    print(f"Fetched {len(rows)} candidate NDR row(s) (cp_ndr_attempts >= 1, not RTO, phone "
          f"present, yesterday) from lmd_courier_tracking.")

    awb_counts = {}
    for r in rows:
        awb_counts[r[0]] = awb_counts.get(r[0], 0) + 1
    dupes = {awb: n for awb, n in awb_counts.items() if n > 1}
    if dupes:
        print(f"  WARNING: {len(dupes)} awb_number(s) appeared more than once in this fetch "
              f"- ndr_source.py's GROUP BY should prevent this; only the last one will stick.")

    # Read existing rows BEFORE writing anything - doing it after the header write risked a
    # read seeing stale/empty state from a value read immediately following a value write
    # (observed once in practice: existing came back empty right after the header write even
    # though the sheet demonstrably had rows moments before and after).
    existing = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:A1000000")
    existing_row_by_awb = {row[0]: i + 2 for i, row in enumerate(existing) if row}
    next_row = len(existing) + 2

    lib.set_sheet_values_batch(SPREADSHEET_ID, [{"range": f"'{SHEET_TAB}'!A1", "values": [HEADERS]}])
    print("Header row written.")

    updates, new_rows = [], []
    for r in rows:
        values = [str(v) if v is not None else "" for v in r]
        row_num = existing_row_by_awb.get(values[0])
        if row_num:
            updates.append({
                "range": f"'{SHEET_TAB}'!A{row_num}:{LAST_SOURCE_COL}{row_num}",
                "values": [values],
            })
        else:
            new_rows.append(values)

    for start in range(0, len(updates), CHUNK_SIZE):
        lib.set_sheet_values_batch(SPREADSHEET_ID, updates[start:start + CHUNK_SIZE])
    print(f"Refreshed {len(updates)} existing row(s) in place (P/Q columns untouched).")

    if new_rows:
        lib.set_sheet_rows_at_row(SPREADSHEET_ID, SHEET_TAB, new_rows, start_row=next_row)
    print(f"Appended {len(new_rows)} new row(s).")


if __name__ == "__main__":
    main()
