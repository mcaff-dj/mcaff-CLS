"""Shared logic for the RTO-Calling tool (api/calling.py), split out so the Vercel Python
function's static bundler can trace a plain top-level `import` (a sys.path hack into
scripts/lib.py wouldn't reliably get picked up by build-time dependency tracing). The
Google Sheets client here is intentionally a re-implementation of scripts/lib.py's
approach (hand-rolled RS256 JWT, no SDK) for that same reason, not because the logic
should diverge - keep both in sync if the sheet's column layout ever changes.

Session reuse: this tool has no login of its own. It verifies the exact same
HMAC-signed `pkyc_session` cookie issued by api/_lib/session.js (same SESSION_SECRET),
so being signed into the main site is enough - no separate sign-in step.
"""
import base64
import hashlib
import hmac
import json
import os
import time

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

# ---------------------------------------------------------------------------
# Session cookie verification (mirrors api/_lib/session.js exactly)
# ---------------------------------------------------------------------------
COOKIE_NAME = "pkyc_session"


def _b64url_decode(s):
    s = s + "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("ascii"))


def _b64url_encode(raw_bytes):
    return base64.urlsafe_b64encode(raw_bytes).decode("ascii").rstrip("=")


def verify_session(cookie_value):
    """Returns the session payload dict ({uid, email, name, isAdmin, perms, exp}) or
    None if missing/invalid/expired - same contract as session.js's getSession()."""
    secret = os.environ.get("SESSION_SECRET")
    if not secret or not cookie_value or "." not in cookie_value:
        return None
    body, mac = cookie_value.rsplit(".", 1)
    expected_mac = _b64url_encode(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(mac, expected_mac):
        return None
    try:
        payload = json.loads(_b64url_decode(body))
    except Exception:
        return None
    if not payload.get("exp") or time.time() > payload["exp"]:
        return None
    return payload


def has_calling_access(payload):
    if not payload:
        return False
    return bool(payload.get("isAdmin")) or "calling" in (payload.get("perms") or [])


# ---------------------------------------------------------------------------
# Google Sheets v4 REST client - service-account JWT bearer flow
# ---------------------------------------------------------------------------
TOKEN_URL = "https://oauth2.googleapis.com/token"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"

_token_cache = {"read": {"token": None, "expiry": 0}, "write": {"token": None, "expiry": 0}}


def _get_sa_credential():
    if os.environ.get("GOOGLE_SA_KEY_JSON"):
        return json.loads(os.environ["GOOGLE_SA_KEY_JSON"])
    path = os.environ.get("GOOGLE_SA_KEY_FILE")
    if not path or not os.path.exists(path):
        raise RuntimeError("Missing GOOGLE_SA_KEY_JSON or a valid GOOGLE_SA_KEY_FILE path")
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _sign_rs256(signing_input, private_key_pem):
    private_key = serialization.load_pem_private_key(private_key_pem.encode("ascii"), password=None)
    return private_key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())


def _get_token(scope, cache_key):
    cache = _token_cache[cache_key]
    now = int(time.time())
    if cache["token"] and now < (cache["expiry"] - 120):
        return cache["token"]
    cred = _get_sa_credential()
    header_b64 = _b64url_encode('{"alg":"RS256","typ":"JWT"}'.encode("ascii"))
    exp = now + 3600
    claim_json = (
        '{"iss":"' + cred["client_email"] + '","scope":"' + scope + '","aud":"' +
        cred["token_uri"] + '","exp":' + str(exp) + ',"iat":' + str(now) + '}'
    )
    claim_b64 = _b64url_encode(claim_json.encode("ascii"))
    signing_input = f"{header_b64}.{claim_b64}"
    sig_b64 = _b64url_encode(_sign_rs256(signing_input, cred["private_key"]))
    jwt = f"{signing_input}.{sig_b64}"

    resp = requests.post(cred["token_uri"], data={
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": jwt,
    }, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    cache["token"] = data["access_token"]
    cache["expiry"] = now + data["expires_in"]
    return cache["token"]


def _read_token():
    return _get_token("https://www.googleapis.com/auth/spreadsheets.readonly", "read")


def _write_token():
    return _get_token("https://www.googleapis.com/auth/spreadsheets", "write")


def get_values(spreadsheet_id, range_):
    url = f"{SHEETS_API}/{spreadsheet_id}/values/{requests.utils.quote(range_, safe='')}"
    resp = requests.get(url, headers={"Authorization": f"Bearer {_read_token()}"}, timeout=60)
    resp.raise_for_status()
    return resp.json().get("values", [])


def set_values_batch(spreadsheet_id, updates):
    url = f"{SHEETS_API}/{spreadsheet_id}/values:batchUpdate"
    body = {"valueInputOption": "USER_ENTERED", "data": [{"range": u["range"], "values": u["values"]} for u in updates]}
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {_write_token()}",
        "Content-Type": "application/json; charset=utf-8",
    }, json=body, timeout=60)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# RTO "Data" tab access - column layout, row identity, auto-claim, dispose
# ---------------------------------------------------------------------------
TAB = "Data"
DATA_RANGE = f"'{TAB}'!A2:AC"  # header row (1) skipped; AD (Logs) not needed

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

DISPOSE_COLUMNS = [
    "agent_name", "connected", "status", "rto_reason_agent", "new_product_needed",
    "new_order_id", "change_in_address", "new_address", "calling_date", "remark",
]

CONNECTED_OPTIONS = [
    "Yes", "No", "Disconnect", "Switch Off/ Out Of Network", "Non-Serviceable/ No Incoming Facility",
    "Busy", "Wrong number", "Order Denied", "Language Barrier", "Network issue", "Call Later",
]
STATUS_OPTIONS = [
    "Genunie Attempt", "Fake Attempt", "To be refunded", "Already Placed", "Already Refunded",
    "Delivered", "In Transit",
]

CLAIM_BATCH_SIZE = 20  # how many fresh leads an agent gets each time their queue runs dry


def _sheet_id():
    sid = os.environ.get("RTO_SHEET_ID")
    if not sid:
        raise RuntimeError("Missing RTO_SHEET_ID env var")
    return sid


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
    now = time.time()
    if not force_refresh and _cache["rows"] is not None and now - _cache["fetched_at"] < CACHE_TTL_SECONDS:
        return _cache["rows"]
    raw = get_values(_sheet_id(), DATA_RANGE)
    rows = [_row_to_record(row, i + 2) for i, row in enumerate(raw)]
    _cache["rows"] = rows
    _cache["fetched_at"] = now
    return rows


def verify_rows(items):
    """Re-checks Order ID + AWB Code for a batch of {row_number, order_id, awb_code}
    refs in one API round trip, right before writing."""
    if not items:
        return [], []
    raw = get_values(_sheet_id(), f"'{TAB}'!E2:G")
    valid, mismatched = [], []
    for it in items:
        idx = it["row_number"] - 2
        row = raw[idx] if 0 <= idx < len(raw) else []
        if _cell(row, 0) == it["order_id"] and _cell(row, 2) == it["awb_code"]:
            valid.append(it)
        else:
            mismatched.append(it)
    return valid, mismatched


def claim_next_batch(agent_email, batch_size=CLAIM_BATCH_SIZE):
    """Auto-assign: grabs up to `batch_size` currently-unassigned rows for this agent.
    Re-checks each candidate's Agent Name cell is still blank immediately before writing,
    to shrink (not fully eliminate) the race window against another agent's simultaneous
    claim - an acceptable tradeoff for a small internal team, not a distributed lock."""
    rows = fetch_all_rows(force_refresh=True)
    candidates = [r for r in rows if not r["agent_name"]][:batch_size]
    if not candidates:
        return 0
    row_numbers = [c["row_number"] for c in candidates]
    ranges = [f"'{TAB}'!Q{n}:Q{n}" for n in row_numbers]
    recheck = get_values(_sheet_id(), f"'{TAB}'!Q{min(row_numbers)}:Q{max(row_numbers)}")
    base = min(row_numbers)
    still_unassigned = []
    for n in row_numbers:
        idx = n - base
        val = recheck[idx][0] if idx < len(recheck) and recheck[idx] else ""
        if not str(val).strip():
            still_unassigned.append(n)
    if not still_unassigned:
        return 0
    updates = [{"range": f"'{TAB}'!Q{n}:Q{n}", "values": [[agent_email]]} for n in still_unassigned]
    set_values_batch(_sheet_id(), updates)
    _cache["rows"] = None
    return len(still_unassigned)


def dispose(item, fields):
    valid, _mismatched = verify_rows([item])
    if not valid:
        raise ValueError(
            "This lead changed in the sheet since you loaded it (row shifted or edited "
            "directly) - refresh and try again."
        )
    values = [str(fields.get(col, "") or "") for col in DISPOSE_COLUMNS]
    set_values_batch(_sheet_id(), [{"range": f"'{TAB}'!Q{item['row_number']}:Z{item['row_number']}", "values": [values]}])
    _cache["rows"] = None
    return item["row_number"]
