"""RTO calling tool: reads/writes the "Data" tab of the RTO Calling Google Sheet live
(source of truth stays the sheet - no local copy of leads is kept, and nothing here talks
to Shiprocket). Column layout below mirrors the sheet's actual header row exactly (as of
Jul 2026) - it is NOT derived programmatically because several headers repeat ("RTO
Reason" appears twice, once for the courier's original reason in column D and once for
the agent's confirmed reason in column T) or have stray leading/trailing spaces, so
matching by position is the only reliable option.

Row identity: the sheet's "Key" column (AA) looks like a per-row ID at a glance but is
actually a loyalty tier ("Gold"/"Lion"/"Tiger"/"Cat") shared by thousands of rows, and
neither Order ID nor AWB Code is unique on their own (~1,900 repeats each - the same
order/shipment can get a fresh RTO/NDR entry logged more than once). There's no reliable
business-column identifier, so writes are addressed by sheet row number (captured at read
time) with a live Order ID + AWB Code check immediately before writing - see verify_rows().
This catches the case where someone edited the sheet directly and rows shifted since.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import lib as sheets_lib  # noqa: E402 - path insert must happen first

import config  # noqa: E402

TAB = "Data"
SHEET_ID = config.get("RTO_SHEET_ID", required=True)
DATA_RANGE = f"'{TAB}'!A2:AC"  # header row (1) skipped; AD (Logs) not needed by the tool

# 0-based index into each row array returned by DATA_RANGE
COL = {
    "cxb_cv": 0, "rto_initiated_date": 1, "latest_ndr_date": 2, "rto_reason_original": 3,
    "order_id": 4, "unique": 5, "awb_code": 6, "cust_email": 7, "cust_name": 8,
    "cust_mobile": 9, "address": 10, "city": 11, "state": 12, "pincode": 13,
    "payment_method": 14, "order_total": 15, "agent_name": 16, "connected": 17,
    "status": 18, "rto_reason_agent": 19, "new_product_needed": 20, "new_order_id": 21,
    "change_in_address": 22, "new_address": 23, "calling_date": 24, "remark": 25,
    "tier": 26, "facility": 27, "courier": 28,
}

# Disposition columns written back by dispose(), in sheet column order (Q..Z) - must match
# the order of values passed to the Q{row}:Z{row} write range.
DISPOSE_COLUMNS = [
    "agent_name", "connected", "status", "rto_reason_agent", "new_product_needed",
    "new_order_id", "change_in_address", "new_address", "calling_date", "remark",
]

# Distinct values already in use in the sheet's Connected / Attempt(Status) columns -
# offered as dropdown options so new entries stay consistent with the existing ~52k rows
# instead of drifting into new free-text variants.
CONNECTED_OPTIONS = [
    "Yes", "No", "Disconnect", "Switch Off/ Out Of Network", "Non-Serviceable/ No Incoming Facility",
    "Busy", "Wrong number", "Order Denied", "Language Barrier", "Network issue", "Call Later",
]
STATUS_OPTIONS = [
    "Genunie Attempt", "Fake Attempt", "To be refunded", "Already Placed", "Already Refunded",
    "Delivered", "In Transit",
]


def _cell(row, idx):
    return str(row[idx]).strip() if idx < len(row) and row[idx] is not None else ""


def _row_to_record(row, row_number):
    rec = {"row_number": row_number}
    for name, idx in COL.items():
        rec[name] = _cell(row, idx)
    return rec


_cache = {"rows": None, "fetched_at": 0}
CACHE_TTL_SECONDS = 30


def fetch_all_rows(force_refresh=False):
    """Full-sheet read, cached briefly per process - an admin filter view or an agent
    queue refresh doesn't need to hit the Sheets API on every request, and this data is
    inherently a little stale anyway (other people can edit the sheet directly)."""
    now = time.time()
    if not force_refresh and _cache["rows"] is not None and now - _cache["fetched_at"] < CACHE_TTL_SECONDS:
        return _cache["rows"]
    raw = sheets_lib.get_sheet_values(SHEET_ID, DATA_RANGE)
    rows = [_row_to_record(row, i + 2) for i, row in enumerate(raw)]  # +2: skip header, 1-index
    _cache["rows"] = rows
    _cache["fetched_at"] = now
    return rows


def verify_rows(items):
    """Re-checks Order ID + AWB Code for a batch of {row_number, order_id, awb_code} refs
    in one API round trip, right before writing - if a row no longer matches what the
    caller saw, the sheet changed under us and it's dropped as mismatched rather than
    risking a write to the wrong lead."""
    if not items:
        return [], []
    raw = sheets_lib.get_sheet_values(SHEET_ID, f"'{TAB}'!E2:G")
    valid, mismatched = [], []
    for it in items:
        idx = it["row_number"] - 2
        row = raw[idx] if 0 <= idx < len(raw) else []
        order_id = _cell(row, 0)  # E
        awb_code = _cell(row, 2)  # G
        if order_id == it["order_id"] and awb_code == it["awb_code"]:
            valid.append(it)
        else:
            mismatched.append(it)
    return valid, mismatched


def assign(items, agent_email):
    valid, mismatched = verify_rows(items)
    updates = [
        {"range": f"'{TAB}'!Q{it['row_number']}:Q{it['row_number']}", "values": [[agent_email]]}
        for it in valid
    ]
    if updates:
        sheets_lib.set_sheet_values_batch(SHEET_ID, updates)
    _cache["rows"] = None
    return len(valid), mismatched


def dispose(item, fields):
    valid, _mismatched = verify_rows([item])
    if not valid:
        raise ValueError(
            "This lead changed in the sheet since you loaded it (row shifted or edited "
            "directly) - refresh and try again."
        )
    values = [str(fields.get(col, "") or "") for col in DISPOSE_COLUMNS]
    sheets_lib.set_sheet_values_batch(
        SHEET_ID, [{"range": f"'{TAB}'!Q{item['row_number']}:Z{item['row_number']}", "values": [values]}]
    )
    _cache["rows"] = None
    return item["row_number"]
