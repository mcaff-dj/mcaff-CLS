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

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

# Flowcall's "Created At" was "D/M/YYYY, h:mm:ss am/pm" until it switched to
# "D-M-YY H:MM:SS" (24h clock, 2-digit year) around 2026-08-25 - both accepted
# here so rows written under the old format still validate. Shared by every
# script that writes to or audits the ticket-export tabs (export_recurring.py,
# backfill_gap_cleaned.py, check_export_integrity.py) as the one signal for a
# column-shifted row - an unescaped comma/newline inside a free-text field in
# Flowcall's CSV export pushes every later column over by one, and this is
# the cheapest column to validate against a fixed, unambiguous format.
CREATED_AT_PATTERN = re.compile(
    r"^(?:\d{1,2}/\d{1,2}/\d{4},?\s*\d{1,2}:\d{2}:\d{2}\s*(?:am|pm)"
    r"|\d{1,2}-\d{1,2}-\d{2}\s+\d{1,2}:\d{2}:\d{2})$", re.IGNORECASE
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


_token_cache = {
    "read": {"token": None, "expiry": 0},
    "write": {"token": None, "expiry": 0},
    "drive": {"token": None, "expiry": 0},
}


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


def get_drive_access_token():
    return _get_token("https://www.googleapis.com/auth/drive.readonly", "drive")


def list_drive_folder(folder_id):
    """Lists {id, name, mimeType, size, modifiedTime} for every file directly inside
    a Drive folder (service account must already have at least Viewer access -
    see the mcaff-CLS Drive CSV merge precedent). Paginates via nextPageToken."""
    token = get_drive_access_token()
    files = []
    page_token = None
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed = false",
            "fields": "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        resp = requests.get(
            "https://www.googleapis.com/drive/v3/files",
            headers={"Authorization": f"Bearer {token}"},
            params=params, timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        files.extend(data.get("files", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files


def download_drive_file(file_id, dest_path, timeout_sec=300):
    token = get_drive_access_token()
    resp = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"alt": "media", "supportsAllDrives": "true"},
        timeout=timeout_sec, stream=True,
    )
    resp.raise_for_status()
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)


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


def append_sheet_rows(spreadsheet_id, range_, rows):
    """Appends `rows` (a list of lists, one per new sheet row) as genuinely NEW rows via
    Sheets' values:append with insertDataOption=INSERT_ROWS - never values:batchUpdate, which
    only overwrites existing cells and has no notion of "add a row". ONE call regardless of how
    many rows are in the batch - see this feature's own design note on why an unbatched write
    path is not acceptable (a real 429 outage earlier this same day, see git log).

    range_ only needs to name the starting column and sheet/tab (e.g. "'Data'!B2:P") - Google
    figures out where the actual next blank row is; it does not need to be exact.

    Returns Google's raw response dict, or {"updates": {"updatedRows": 0}} without making any
    network call at all if `rows` is empty - avoids both a wasted request and a confusing 400
    from Google for an empty values array."""
    if not rows:
        return {"updates": {"updatedRows": 0}}
    encoded = urllib.parse.quote(range_, safe="")
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{encoded}"
        f":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
    )
    return post_with_cell_reclaim(spreadsheet_id, url, {"values": rows}, timeout=180)


def get_sheet_values(spreadsheet_id, range_, timeout_sec=120, value_render_option=None):
    """value_render_option: pass "FORMULA" to get each cell's formula text
    (e.g. "=A2-B2") instead of its computed value - needed to discover which
    columns a tab computes itself before filling formulas down into new rows."""
    encoded = urllib.parse.quote(range_, safe="")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{encoded}"
    params = {"valueRenderOption": value_render_option} if value_render_option else None
    last_err = None
    for attempt in range(1, 6):
        try:
            token = get_access_token()
            resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, params=params, timeout=timeout_sec)
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


def is_cell_limit_error(resp):
    """True for Google's workbook-wide cell-cap rejection: HTTP 400 with
    "This action would increase the number of cells in the workbook above the
    limit of 10000000 cells." Deliberately NOT matched on the number - the cap
    has been raised before (5M -> 10M) and would raise again."""
    if resp.status_code != 400:
        return False
    body = (resp.text or "").lower()
    return "above the limit of" in body and "cells" in body


def last_used_row(spreadsheet_id, sheet_name, last_col, grid_rows, chunk=2000):
    """Highest 1-based row holding any value in A..last_col (0 if the tab is
    empty). Probes UPWARD from the bottom of the allocated grid in chunks, so an
    over-allocated tab costs only reads of its blank tail plus one chunk - not a
    full-tab read, which on a workbook near the 10M-cell cap is exactly the read
    that is too big to afford. Looks at every column, never just column A: a row
    blank in A but filled in F is data, and deleting it would be data loss."""
    end = grid_rows
    while end > 0:
        start = max(1, end - chunk + 1)
        window = get_sheet_values(spreadsheet_id, f"'{sheet_name}'!A{start}:{last_col}{end}")
        for i in range(len(window) - 1, -1, -1):
            if any(str(c).strip() for c in window[i]):
                return start + i
        end = start - 1
    return 0


def trim_empty_grid_rows(spreadsheet_id, keep_buffer=50, min_gain_cells=1000):
    """Reclaims cells against the 10M-per-workbook cap by structurally deleting
    each tab's allocated-but-EMPTY trailing rows. Only ever removes rows below
    the last row that holds data (plus `keep_buffer` spare rows so the next
    incremental write doesn't immediately resize), so no data is touched -
    clearing cell contents would free nothing at all, since the cap counts
    allocated grid, not filled cells. Row 1 always survives. Returns cells freed.

    Skips a tab whose trimmable tail is under min_gain_cells - a batchUpdate plus
    a tail read is not worth a few hundred cells."""
    token = get_access_token()
    resp = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}?fields=sheets.properties",
        headers={"Authorization": f"Bearer {token}"}, timeout=60)
    resp.raise_for_status()
    freed = 0
    for sheet in resp.json().get("sheets", []):
        props = sheet["properties"]
        name = props["title"]
        grid = props.get("gridProperties", {})
        rows = grid.get("rowCount", 0)
        cols = grid.get("columnCount", 0)
        if not rows or not cols:
            continue
        last_col = get_column_letter(cols - 1)
        first_dead = max(last_used_row(spreadsheet_id, name, last_col, rows) + keep_buffer + 1, 2)
        gain = (rows - first_dead + 1) * cols
        if first_dead > rows or gain < min_gain_cells:
            continue
        delete_sheet_rows(spreadsheet_id, name, first_dead, rows)
        freed += gain
        print(f"  trimmed '{name}': dropped rows {first_dead}-{rows} ({gain:,} cells)")
    return freed


def post_with_cell_reclaim(spreadsheet_id, url, body, timeout=60):
    """POSTs a Sheets write and, if Google rejects it for the workbook cell cap,
    trims empty trailing grid rows once and retries. Every write that can grow
    the grid (values:append with INSERT_ROWS, updateSheetProperties raising
    rowCount/columnCount) routes through here, so the cap is handled in one place
    instead of at each call site."""
    headers = {
        "Authorization": f"Bearer {get_write_access_token()}",
        "Content-Type": "application/json; charset=utf-8",
    }
    resp = requests.post(url, headers=headers, json=body, timeout=timeout)
    if is_cell_limit_error(resp):
        print("  workbook cell limit hit - trimming empty grid rows")
        freed = trim_empty_grid_rows(spreadsheet_id)
        if not freed:
            print("  nothing empty left to trim - the grid is genuinely full of data")
        else:
            print(f"  freed {freed:,} cells; retrying write")
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
    if not resp.ok:
        print(f"  Sheets write failed: {resp.status_code}")
        print(f"    response body: {resp.text}")
    resp.raise_for_status()
    return resp.json()


def ensure_grid_size(spreadsheet_id, sheet_name, min_rows, min_cols, _retried=False):
    """Grows the sheet's underlying grid if needed. A PUT to an explicit range
    fails outright with 'exceeds grid limits' if the target is beyond the
    sheet's current (fixed) row/column count - unlike values:append, which
    auto-grows the grid. Adds a small buffer beyond the immediate need so a
    future incremental write doesn't have to resize again right away - but
    ONLY on whichever dimension actually needs to grow: a workbook already
    close to Google Sheets' 10M-cell-per-workbook ceiling can reject an
    unnecessary column bump (e.g. rows need to grow but columns already fit)
    that a blanket buffer on both dimensions would trigger. Kept deliberately
    small (not the ~500/~20 this used to add) - this workbook runs close to
    the cap, and every extra buffered cell is one less cell of headroom."""
    gid, grid_props = _get_sheet_gid_and_grid(spreadsheet_id, sheet_name)
    cur_rows = grid_props.get("rowCount", 0)
    cur_cols = grid_props.get("columnCount", 0)
    if min_rows <= cur_rows and min_cols <= cur_cols:
        return
    new_rows = max(min_rows + 50, cur_rows) if min_rows > cur_rows else cur_rows
    new_cols = max(min_cols + 5, cur_cols) if min_cols > cur_cols else cur_cols
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
    if is_cell_limit_error(resp) and not _retried:
        # Retry through this same function rather than replaying the request:
        # new_rows/new_cols are absolute, and a trim that shrinks THIS tab would
        # otherwise be undone by a replay asking for the old (bloated) rowCount.
        print(f"  '{sheet_name}' -> {new_rows}x{new_cols} hit the workbook cell limit - trimming empty grid rows")
        if trim_empty_grid_rows(spreadsheet_id):
            return ensure_grid_size(spreadsheet_id, sheet_name, min_rows, min_cols, _retried=True)
        print("  nothing empty left to trim - the grid is genuinely full of data")
    if not resp.ok:
        print(f"  ensure_grid_size('{sheet_name}' -> {new_rows}x{new_cols}) failed: {resp.status_code}")
        print(f"    response body: {resp.text}")
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


def get_sheet_tail_for_months(spreadsheet_id, sheet_name, last_col, buffer_rows, month_col_idx, target_months):
    """Fetches the last buffer_rows data rows of the sheet - using the sheet's own current
    row count (a cheap column-A read), not a row count derived from some other source - and
    keeps only rows whose Month is one of target_months. Used when the settled
    (pre-target-month) rows come from a MySQL mirror instead of a local cache (see
    kyc_source.py): that mirror's row count can NOT be assumed to line up with the live
    sheet's own row numbering (e.g. it may also fold in a secondary/legacy sheet the primary
    tab doesn't carry), so this reads a generous trailing window off the sheet itself rather
    than guessing a start row from the mirror's count. buffer_rows must comfortably exceed
    the current month's row count; the Month filter discards whatever extra older rows the
    window happens to catch."""
    last_row = get_last_data_row(spreadsheet_id, sheet_name)
    start_row = max(2, last_row - buffer_rows + 1)
    target_set = set(target_months)
    fetched = get_sheet_rows_chunked(spreadsheet_id, sheet_name, last_col, start_row=start_row)
    return [r for r in fetched if (r[month_col_idx] if month_col_idx < len(r) else None) in target_set]
