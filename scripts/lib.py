"""Google Sheets access: service-account auth (hand-rolled RS256 JWT, no SDK) plus
read/write helpers. Python port of lib.ps1 - see that file's comments for the
reasoning behind the incremental-cache boundary math and retry/backoff choices;
kept here 1:1 so behavior matches what's already running in production.
"""
import base64
import json
import os
import re
import time
import urllib.parse
from pathlib import Path

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

# Flowcall's "Created At" is always "D/M/YYYY, h:mm:ss am/pm". Shared by every
# script that writes to or audits the ticket-export tabs (export_recurring.py,
# backfill_gap_cleaned.py, check_export_integrity.py) as the one signal for a
# column-shifted row - an unescaped comma/newline inside a free-text field in
# Flowcall's CSV export pushes every later column over by one, and this is
# the cheapest column to validate against a fixed, unambiguous format.
CREATED_AT_PATTERN = re.compile(
    r"^\d{1,2}/\d{1,2}/\d{4},?\s*\d{1,2}:\d{2}:\d{2}\s*(am|pm)$", re.IGNORECASE
)


def get_sa_credential():
    """Credential resolution order: GOOGLE_SA_KEY_JSON env (full JSON text) ->
    GOOGLE_SA_KEY_FILE env (path) -> hardcoded fallback path."""
    if os.environ.get("GOOGLE_SA_KEY_JSON"):
        return json.loads(os.environ["GOOGLE_SA_KEY_JSON"])
    path = os.environ.get("GOOGLE_SA_KEY_FILE") or \
        r"C:\Users\VIKASH PATHAK\Desktop\Service account\sheetdata-501810-53e5bf991483.json"
    if not os.path.exists(path):
        raise RuntimeError("Service-account key not found. Set GOOGLE_SA_KEY_JSON or GOOGLE_SA_KEY_FILE.")
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _b64url(raw_bytes):
    return base64.urlsafe_b64encode(raw_bytes).decode("ascii").rstrip("=")


def _sign_rs256(signing_input, private_key_pem):
    private_key = serialization.load_pem_private_key(private_key_pem.encode("ascii"), password=None)
    return private_key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())


_token_cache = {"read": {"token": None, "expiry": 0}, "write": {"token": None, "expiry": 0}}


def _get_token(scope, cache_key):
    cache = _token_cache[cache_key]
    now = int(time.time())
    if cache["token"] and now < (cache["expiry"] - 120):
        return cache["token"]

    cred = get_sa_credential()
    header_json = '{"alg":"RS256","typ":"JWT"}'
    exp = now + 3600
    claim_json = (
        '{"iss":"' + cred["client_email"] + '","scope":"' + scope + '","aud":"' +
        cred["token_uri"] + '","exp":' + str(exp) + ',"iat":' + str(now) + '}'
    )
    header_b64 = _b64url(header_json.encode("ascii"))
    claim_b64 = _b64url(claim_json.encode("ascii"))
    signing_input = f"{header_b64}.{claim_b64}"
    sig_b64 = _b64url(_sign_rs256(signing_input, cred["private_key"]))
    jwt = f"{signing_input}.{sig_b64}"

    resp = requests.post(cred["token_uri"], data={
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": jwt,
    })
    resp.raise_for_status()
    data = resp.json()
    cache["token"] = data["access_token"]
    cache["expiry"] = now + data["expires_in"]
    return cache["token"]


def get_access_token():
    return _get_token("https://www.googleapis.com/auth/spreadsheets.readonly", "read")


def get_write_access_token():
    return _get_token("https://www.googleapis.com/auth/spreadsheets", "write")


def set_sheet_values_batch(spreadsheet_id, updates):
    token = get_write_access_token()
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values:batchUpdate"
    body = {
        "valueInputOption": "USER_ENTERED",
        "data": [{"range": u["range"], "values": u["values"]} for u in updates],
    }
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }, json=body)
    resp.raise_for_status()
    return resp.json()


def get_sheet_values(spreadsheet_id, range_, timeout_sec=120):
    encoded = urllib.parse.quote(range_, safe="")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{encoded}"
    last_err = None
    for attempt in range(1, 6):
        try:
            token = get_access_token()
            resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=timeout_sec)
            resp.raise_for_status()
            return resp.json().get("values", [])
        except Exception as e:
            last_err = e
            print(f"  fetch '{range_}' attempt {attempt} failed: {e}")
            time.sleep(4 * attempt)
    raise RuntimeError(f"Failed to fetch range '{range_}' after 5 attempts") from last_err


def get_sheet_rows_chunked(spreadsheet_id, sheet_name, last_col, chunk_size=10000, start_row=2):
    all_rows = []
    start = start_row
    while True:
        end = start + chunk_size - 1
        range_ = f"'{sheet_name}'!A{start}:{last_col}{end}"
        chunk = get_sheet_values(spreadsheet_id, range_)
        if not chunk:
            break
        all_rows.extend(chunk)
        print(f"  fetched {sheet_name} rows {start}-{start + len(chunk) - 1} ({len(all_rows)} total)")
        if len(chunk) < chunk_size:
            break
        start = end + 1
    return all_rows


def get_column_letter(index):
    """0-based column index -> letter, e.g. 0->A, 25->Z, 26->AA."""
    n = index + 1
    s = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def get_last_data_row(spreadsheet_id, sheet_name):
    """1-based row number of the last row with data in column A (0 if empty)."""
    try:
        col_a = get_sheet_values(spreadsheet_id, f"'{sheet_name}'!A:A")
    except Exception:
        col_a = None
    return len(col_a) if col_a else 0


def clear_sheet_range(spreadsheet_id, range_):
    token = get_write_access_token()
    encoded = urllib.parse.quote(range_, safe="")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{encoded}:clear"
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }, timeout=180)
    resp.raise_for_status()
    return resp.json()


def _get_sheet_gid_and_grid(spreadsheet_id, sheet_name):
    token = get_access_token()
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}"
    resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    resp.raise_for_status()
    for sheet in resp.json()["sheets"]:
        if sheet["properties"]["title"] == sheet_name:
            return sheet["properties"]["sheetId"], sheet["properties"]["gridProperties"]
    raise RuntimeError(f"Sheet tab '{sheet_name}' not found in spreadsheet {spreadsheet_id}")


def get_sheet_gid(spreadsheet_id, sheet_name):
    """Numeric sheetId (gid) for a tab - needed for requests like copyPaste
    that address ranges by gid rather than by tab name."""
    gid, _ = _get_sheet_gid_and_grid(spreadsheet_id, sheet_name)
    return gid


def copy_paste_column(spreadsheet_id, sheet_gid, src_row, dest_row_start, dest_row_end, col_index):
    """Copies a single source cell down through a destination row range in the
    same column via the Sheets API's copyPaste request - Sheets auto-adjusts
    relative references (B2 -> B3, B4, ...) exactly like dragging the fill
    handle down manually. Rows are 1-based; col_index is 0-based.

    Retried + logs the response body on failure, same as set_sheet_rows_at_row -
    this call immediately follows a grid resize (ensure_grid_size), and a bare
    raise_for_status() with no body logging previously made a same-day 400 from
    Sheets impossible to diagnose from CI logs alone."""
    token = get_write_access_token()
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
    body = {
        "requests": [{
            "copyPaste": {
                "source": {
                    "sheetId": sheet_gid,
                    "startRowIndex": src_row - 1, "endRowIndex": src_row,
                    "startColumnIndex": col_index, "endColumnIndex": col_index + 1,
                },
                "destination": {
                    "sheetId": sheet_gid,
                    "startRowIndex": dest_row_start - 1, "endRowIndex": dest_row_end,
                    "startColumnIndex": col_index, "endColumnIndex": col_index + 1,
                },
                "pasteType": "PASTE_NORMAL",
            }
        }]
    }
    last_err = None
    for attempt in range(1, 6):
        try:
            resp = requests.post(url, headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }, json=body, timeout=60)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            last_err = e
            print(f"  copy_paste_column col {col_index} rows {dest_row_start}-{dest_row_end} attempt {attempt} failed: {e}")
            if isinstance(e, requests.exceptions.HTTPError):
                print(f"    response body: {e.response.text}")
            if attempt == 5:
                raise
            time.sleep(5 * attempt)


def delete_sheet_rows(spreadsheet_id, sheet_name, start_row, end_row):
    """Deletes rows start_row..end_row (both 1-based, inclusive) from a tab -
    a real structural delete (rows below shift up), not a clear-to-blank."""
    gid, _ = _get_sheet_gid_and_grid(spreadsheet_id, sheet_name)
    token = get_write_access_token()
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
    body = {
        "requests": [{
            "deleteDimension": {
                "range": {
                    "sheetId": gid,
                    "dimension": "ROWS",
                    "startIndex": start_row - 1,
                    "endIndex": end_row,
                }
            }
        }]
    }
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }, json=body, timeout=60)
    resp.raise_for_status()
    return resp.json()


def delete_sheet_rows_multi(spreadsheet_id, sheet_name, row_numbers):
    """Deletes a set of (not necessarily contiguous) 1-based row numbers in a
    single batchUpdate. Requests are applied in the order given, so they're
    sorted descending here - deleting a higher row first never shifts the
    still-pending lower row numbers, avoiding the need to re-index between
    deletes."""
    if not row_numbers:
        return
    gid, _ = _get_sheet_gid_and_grid(spreadsheet_id, sheet_name)
    token = get_write_access_token()
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
    requests_list = [
        {"deleteDimension": {"range": {"sheetId": gid, "dimension": "ROWS", "startIndex": r - 1, "endIndex": r}}}
        for r in sorted(set(row_numbers), reverse=True)
    ]
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }, json={"requests": requests_list}, timeout=120)
    resp.raise_for_status()
    return resp.json()


def ensure_grid_size(spreadsheet_id, sheet_name, min_rows, min_cols):
    """Grows the sheet's underlying grid if needed. A PUT to an explicit range
    fails outright with 'exceeds grid limits' if the target is beyond the
    sheet's current (fixed) row/column count - unlike values:append, which
    auto-grows the grid. Adds a buffer beyond the immediate need so a future
    incremental write doesn't have to resize again right away - but ONLY on
    whichever dimension actually needs to grow: a workbook already close to
    Google Sheets' 10M-cell-per-workbook ceiling can reject an unnecessary
    column bump (e.g. rows need to grow but columns already fit) that a
    blanket buffer on both dimensions would trigger."""
    gid, grid_props = _get_sheet_gid_and_grid(spreadsheet_id, sheet_name)
    cur_rows = grid_props.get("rowCount", 0)
    cur_cols = grid_props.get("columnCount", 0)
    if min_rows <= cur_rows and min_cols <= cur_cols:
        return
    new_rows = max(min_rows + 500, cur_rows) if min_rows > cur_rows else cur_rows
    new_cols = max(min_cols + 20, cur_cols) if min_cols > cur_cols else cur_cols
    token = get_write_access_token()
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate"
    body = {
        "requests": [{
            "updateSheetProperties": {
                "properties": {"sheetId": gid, "gridProperties": {"rowCount": new_rows, "columnCount": new_cols}},
                "fields": "gridProperties.rowCount,gridProperties.columnCount",
            }
        }]
    }
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }, json=body, timeout=60)
    resp.raise_for_status()
    print(f"  grew '{sheet_name}' grid to {new_rows} rows x {new_cols} cols (was {cur_rows} x {cur_cols})")


def set_sheet_rows_at_row(spreadsheet_id, sheet_name, rows, start_row, chunk_size=300):
    """Writes rows starting at an explicit 1-based row number (chunked + retried).
    Unlike values:append, a PUT to an explicit range is idempotent - retrying after a
    connection reset just rewrites the same cells instead of risking a duplicate insert."""
    if not rows:
        return
    token = get_write_access_token()
    max_width = max(len(r) for r in rows)
    last_col = get_column_letter(max_width - 1)

    ensure_grid_size(spreadsheet_id, sheet_name, start_row + len(rows) - 1, max_width)

    for start in range(0, len(rows), chunk_size):
        end = min(start + chunk_size, len(rows)) - 1
        chunk = rows[start:end + 1]
        row_start = start_row + start
        row_end = start_row + end
        range_ = urllib.parse.quote(f"'{sheet_name}'!A{row_start}:{last_col}{row_end}", safe="")
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_}?valueInputOption=USER_ENTERED"
        body = {"values": chunk}
        last_err = None
        for attempt in range(1, 6):
            try:
                resp = requests.put(url, headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                }, json=body, timeout=180)
                resp.raise_for_status()
                break
            except Exception as e:
                last_err = e
                print(f"  write rows {row_start}-{row_end} attempt {attempt} failed: {e}")
                if isinstance(e, requests.exceptions.HTTPError):
                    print(f"    response body: {e.response.text}")
                if attempt == 5:
                    raise
                time.sleep(5 * attempt)


def get_sheet_rows_incremental(spreadsheet_id, sheet_name, last_col, cache_path, month_col_idx, target_months):
    cache_path = Path(cache_path)
    if not cache_path.exists():
        print(f"  no incremental cache yet at {cache_path} - doing a full fetch")
        all_rows = get_sheet_rows_chunked(spreadsheet_id, sheet_name, last_col)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(all_rows, f, separators=(",", ":"))
        return all_rows

    with open(cache_path, "r", encoding="utf-8-sig") as f:
        cached = json.load(f)

    earliest_target = target_months[0]
    boundary = -1
    for i, row in enumerate(cached):
        mo = row[month_col_idx] if isinstance(row, list) and month_col_idx < len(row) else None
        if mo == earliest_target:
            boundary = i
            break

    if boundary < 0:
        print(f"  '{earliest_target}' not found in cache - refetching everything this once")
        all_rows = get_sheet_rows_chunked(spreadsheet_id, sheet_name, last_col)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(all_rows, f, separators=(",", ":"))
        return all_rows

    print(f"  reusing {boundary} cached rows (months before {earliest_target}); refetching from row {boundary + 2} onward")
    fresh_tail = get_sheet_rows_chunked(spreadsheet_id, sheet_name, last_col, start_row=boundary + 2)
    merged = cached[:boundary] + list(fresh_tail)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, separators=(",", ":"))
    return merged
