#!/usr/bin/env python3
"""Background worker for the Order Punch feature (api/order-punch/start.js). Ports the
"Repunch Pipeline" Google Apps Script's business logic 1:1 - channel routing, DELIVERED/
cooldown guards, duplicate-suffix handling, duplicate-create recovery on retry - onto this
app's Postgres job table + Unicommerce's REST API. See
docs/superpowers/specs/2026-08-21-order-punch-design.md.

This file's pure functions (this section) have no network/DB dependency and are covered by
test_process_order_punch_job.py. The network + process_job half is appended below them.
"""
import datetime


class TokenExpiredError(Exception):
    pass


class RateLimitedError(Exception):
    pass


def resolve_target_channel(current_channel, mcaffeine_channels, hyphen_channels, target_mcaffeine, target_hyphen):
    """Mirrors resolveTargetChannel_ exactly, including its ch.indexOf("HYP") === 0 fallback for
    an unrecognized channel."""
    ch = (current_channel or "").strip().upper()
    if ch in {c.upper() for c in mcaffeine_channels} or ch == target_mcaffeine.upper():
        return target_mcaffeine
    if ch in {c.upper() for c in hyphen_channels} or ch == target_hyphen.upper():
        return target_hyphen
    return target_hyphen if ch.startswith("HYP") else target_mcaffeine


def pick_so_code(display_order_code, same_channel, existing_codes, max_suffix):
    """Mirrors pickSoCode_ exactly: bare code if a different channel and free, else the first
    free _1.._max_suffix suffix, else None (max suffix exhausted)."""
    if not same_channel and display_order_code not in existing_codes:
        return display_order_code
    for n in range(1, max_suffix + 1):
        candidate = f"{display_order_code}_{n}"
        if candidate not in existing_codes:
            return candidate
    return None


def build_create_payload(order, new_display_code, so_code, target_channel, facility_code, reason, agent_email):
    """Mirrors buildCreatePayload_ exactly. `reason` -> item giftMessage, `agent_email` ->
    item voucherCode - see the design spec's Field mapping section for why (confirmed with the
    user; the Apps Script's own parameter NAMES are misleadingly swapped relative to what they
    actually produce, but the behavior itself is what's ported here)."""
    addresses = []
    for addr in order.get("addresses") or []:
        addresses.append({
            "id": str(addr.get("id") or ""),
            "name": addr.get("name") or "",
            "addressLine1": addr.get("addressLine1") or "",
            "addressLine2": addr.get("addressLine2") or "",
            "city": addr.get("city") or "",
            "state": addr.get("state") or "",
            "country": addr.get("country") or "IN",
            "pincode": str(addr.get("pincode") or ""),
            "phone": str(addr.get("phone") or ""),
            "email": addr.get("email") or "",
        })

    billing_id = str((order.get("billingAddress") or {}).get("id") or "")
    items = order.get("saleOrderItems") or []
    shipping_id = billing_id
    if items and items[0].get("shippingAddressId"):
        shipping_id = str(items[0]["shippingAddressId"])
    elif len(addresses) > 1:
        for a in addresses:
            if a["id"] != billing_id:
                shipping_id = a["id"]
                break

    sale_order_items = []
    for i, item in enumerate(items):
        soi = {
            "code": f"{so_code}-{i}",
            "itemSku": item.get("itemSku") or item.get("sellerSkuCode") or "",
            "shippingMethodCode": item.get("shippingMethodCode") or "STD",
            "packetNumber": item.get("packetNumber") or 1,
            "totalPrice": item.get("totalPrice") or 0,
            "sellingPrice": item.get("sellingPrice") or 0,
            "discount": item.get("discount") or 0,
            "shippingCharges": item.get("shippingCharges") or 0,
            "cashOnDeliveryCharges": item.get("cashOnDeliveryCharges") or 0,
            "prepaidAmount": item.get("prepaidAmount") or 0,
            "storeCredit": item.get("storeCredit") or 0,
            "giftWrapCharges": item.get("giftWrapCharges") or 0,
        }
        if facility_code:
            soi["facilityCode"] = facility_code
        for k in ("giftWrap", "channelProductId"):
            if item.get(k) not in (None, ""):
                soi[k] = item[k]
        if reason:
            soi["giftMessage"] = reason
        elif item.get("giftMessage"):
            soi["giftMessage"] = item["giftMessage"]
        if agent_email:
            soi["voucherCode"] = agent_email
        elif item.get("voucherCode"):
            soi["voucherCode"] = item["voucherCode"]
        sale_order_items.append(soi)

    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    sale_order = {
        "code": so_code,
        "displayOrderCode": new_display_code,
        "displayOrderDateTime": now_iso,
        "channel": target_channel,
        "cashOnDelivery": bool(order.get("cod")),
        "currencyCode": order.get("currencyCode") or "INR",
        "notificationEmail": order.get("notificationEmail") or "",
        "notificationMobile": order.get("notificationMobile") or "",
        "customerCode": order.get("customerCode") or "",
        "customerName": order.get("customerCode") or "",
        "addresses": addresses,
        "billingAddress": {"referenceId": billing_id},
        "shippingAddress": {"referenceId": shipping_id},
        "saleOrderItems": sale_order_items,
        "priority": order.get("priority") or 0,
    }
    if order.get("additionalInfo"):
        sale_order["additionalInfo"] = order["additionalInfo"]
    for k in ("customerGSTIN", "fulfillmentTat", "paymentInstrument", "verificationRequired"):
        if order.get(k) not in (None, ""):
            sale_order[k] = order[k]
    if order.get("thirdPartyShipping"):
        sale_order["thirdPartyShipping"] = True
    if order.get("customFieldValues"):
        sale_order["customFieldValues"] = [
            {"name": cf["name"], "value": cf["value"]}
            for cf in order["customFieldValues"] if cf.get("name") and cf.get("value")
        ]

    return {"saleOrder": sale_order}


def extract_status(obj):
    """Mirrors extractStatus_: known field names first, then any key containing "status" but
    not "updat" (so e.g. lastUpdatedStatus is excluded)."""
    for key in ("status", "statusCode", "orderStatus", "currentStatus", "fulfillmentStatus", "status_code"):
        val = obj.get(key)
        if isinstance(val, str) and val:
            return val.strip().upper()
    for key, val in obj.items():
        kl = key.lower()
        if "status" in kl and "updat" not in kl and isinstance(val, str) and val:
            return val.strip().upper()
    return None


def extract_created_date(obj):
    """Mirrors extractCreatedDate_: known field names first, then any key containing "creat" or
    "date" but not "updat"."""
    for key in ("created", "createdDate", "created_time", "createdTime", "uniware_created_time",
                "uniwareCreatedTime", "createDateTime", "createdDateTime", "createdAt",
                "orderDate", "displayOrderDateTime", "orderDateTime"):
        val = obj.get(key)
        if val not in (None, ""):
            return val
    for key, val in obj.items():
        kl = key.lower()
        if ("creat" in kl or ("date" in kl and "updat" not in kl)) and val not in (None, "") and not isinstance(val, (dict, bool)):
            return val
    return None


def parse_timestamp(val):
    """Mirrors parseTimestamp_: epoch ms, epoch seconds, or an ISO/date string -> epoch ms
    (float), or None if unparseable."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        if val > 1e15:
            return None
        return float(val) if val > 1e12 else float(val) * 1000
    try:
        s = str(val).strip()
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.timestamp() * 1000
    except Exception:
        return None


import json
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

UC_BASE_URL = "https://pep.unicommerce.com"
UC_SECRET_ID = "mcaff-cls/unicommerce"
# Not env-var-configurable - deploy_infra.sh never sets one, and there is only ever one
# deployed worker function for this to name.
WORKER_FUNCTION_NAME = "mcaff-cls-order-punch-worker"

# Ported unchanged from the Apps Script's own tuning constants - these govern Unicommerce
# rate-limit behavior, not business rules, so they are NOT admin-editable (unlike
# order_punch_settings).
SLEEP_BETWEEN_SEC = 0.5
BACKOFF_ON_403_SEC = 10
MAX_CONSECUTIVE_403 = 5
TOKEN_REFRESH_SEC = 120
# Leaves ~100s of the Lambda's 900s timeout for the in-flight row to finish, a final progress
# write, and the continuation self-invoke itself.
CHUNK_BUDGET_SEC = 800

DEFAULT_SETTINGS = {
    "facility_codes": ["HYP_SRKOL", "HYP_SRBGLR", "mCaff_Mumbai2", "mCaff_Gurgaon3", "HYP_AHMD",
                        "HYP_SRLOK2", "HYP_SRGWHT", "Omnivio_Noida1", "HYP_DLNAG"],
    "mcaffeine_channels": ["SHOPIFY", "FIEN_SHOPIFY", "HYPD", "COMPENSATION", "MCaf_Shopify.in", "MCAFF_TEST"],
    "hyphen_channels": ["HYP_SHOPIFY", "HYPD_HYPHEN", "HYP_COMPENSATION", "HYP_SHOPIFY_IN"],
    "target_mcaffeine": "MCAFFEINE_D2C",
    "target_hyphen": "HYPHEN_D2C",
    "cooldown_days": 3,
    "max_suffix": 2,
}

_uc_credentials_cache = None


def get_uc_credentials():
    """Cached for this container's lifetime - one Secrets Manager read per cold start, not per
    row/chunk."""
    global _uc_credentials_cache
    if _uc_credentials_cache is not None:
        return _uc_credentials_cache
    import boto3
    client = boto3.client("secretsmanager")
    secret = client.get_secret_value(SecretId=UC_SECRET_ID)
    _uc_credentials_cache = json.loads(secret["SecretString"])
    return _uc_credentials_cache


def get_uc_token():
    creds = get_uc_credentials()
    resp = requests.get(
        f"{UC_BASE_URL}/oauth/token",
        params={"grant_type": "password", "client_id": "my-trusted-client",
                "username": creds["username"], "password": creds["password"]},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    if resp.status_code != 200:
        raise Exception(f"Auth failed ({resp.status_code}): {resp.text[:200]}")
    return resp.json()["access_token"]


def uc_headers(token, facility=None):
    h = {"Content-Type": "application/json", "Authorization": f"bearer {token}"}
    if facility:
        h["Facility"] = facility
    return h


def search_display_code(token, display_order_code):
    """Mirrors searchDisplayCode_: one retry with a 10s backoff on 403/429, TokenExpiredError on
    401, empty list for any other non-200 (genuine "not found")."""
    url = f"{UC_BASE_URL}/services/rest/v1/oms/saleOrder/search"
    payload = {"displayOrderCode": display_order_code}
    for attempt in range(2):
        resp = requests.post(url, headers=uc_headers(token), json=payload, timeout=30)
        code = resp.status_code
        if code == 200:
            data = resp.json()
            return (data.get("elements") or []) if data.get("successful") else []
        if code == 401:
            raise TokenExpiredError("search returned 401 - token expired")
        if code in (403, 429) and attempt == 0:
            time.sleep(BACKOFF_ON_403_SEC)
            continue
        if code in (403, 429):
            raise RateLimitedError(f"search returned {code} - Unicommerce is rate limiting")
        return []
    return []


def get_order_dto(token, so_code):
    """Mirrors getOrderDto_ - best-effort, returns None on any failure rather than raising."""
    try:
        url = f"{UC_BASE_URL}/services/rest/v1/oms/saleorder/get"
        resp = requests.post(url, headers=uc_headers(token), json={"code": so_code}, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
        return data.get("saleOrderDTO") if data.get("successful") else None
    except Exception:
        return None


def get_order(token, so_code, facility_code, all_facility_codes):
    """Mirrors getOrder_: try the given facility, then no facility, then every other known
    facility - stopping at the first 200, or the first non-403 failure."""
    url = f"{UC_BASE_URL}/services/rest/v1/oms/saleorder/get"
    attempts = []
    if facility_code:
        attempts.append(facility_code)
    attempts.append(None)
    for fc in all_facility_codes:
        if fc != facility_code:
            attempts.append(fc)

    resp = None
    for fc in attempts:
        resp = requests.post(url, headers=uc_headers(token, fc), json={"code": so_code}, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("successful"):
                return data.get("saleOrderDTO"), fc
        if resp.status_code != 403:
            break
    raise Exception(f"saleOrder/get failed: {resp.status_code if resp else '?'} {resp.text[:200] if resp else ''}")


def create_order(token, facility_code, order_payload):
    url = f"{UC_BASE_URL}/services/rest/v1/oms/saleOrder/create"
    resp = requests.post(url, headers=uc_headers(token, facility_code), json=order_payload, timeout=30)
    if resp.status_code != 200:
        raise Exception(f"create returned {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if not data.get("successful"):
        msgs = "; ".join(str(e.get("description") or e.get("message") or e) for e in (data.get("errors") or []))
        raise Exception(f"Create failed: {msgs}")
    return data


def search_and_resolve(token, display_order_code, settings):
    """Mirrors searchAndResolve_: searches the bare code plus every _1.._max_suffix variant,
    collects every existing SO code, the DELIVERED-status SO code (if any), and the most recent
    repunch within the cooldown window (if any) - falling back to direct saleOrder/get lookups
    on up to 3 candidates if the search results themselves carried no status/date fields."""
    existing_codes = {}
    delivered_code = None
    orig_so_code = None
    recent_repunch = None
    cooldown_ms = settings["cooldown_days"] * 24 * 60 * 60 * 1000
    now_ms = time.time() * 1000
    all_so_codes = []
    codes_needing_date_check = []
    status_found_in_search = False

    search_list = [display_order_code] + [f"{display_order_code}_{n}" for n in range(1, settings["max_suffix"] + 1)]

    for search_doc in search_list:
        elements = search_display_code(token, search_doc)
        for el in elements:
            code = el.get("code")
            if code:
                existing_codes[code] = True
            if el.get("displayOrderCode") == search_doc:
                if search_doc == display_order_code and not orig_so_code:
                    orig_so_code = code
                if code:
                    all_so_codes.append(code)

                el_status = extract_status(el)
                if el_status:
                    status_found_in_search = True
                    if not delivered_code and "DELIVER" in el_status:
                        delivered_code = code

                if not recent_repunch and code:
                    created_val = extract_created_date(el)
                    if created_val:
                        created_ms = parse_timestamp(created_val)
                        if created_ms and (now_ms - created_ms) < cooldown_ms:
                            recent_repunch = {"code": code, "days_ago": round((now_ms - created_ms) / (24 * 60 * 60 * 1000), 1)}
                    else:
                        codes_needing_date_check.append(code)

    needs_get_fallback = (not delivered_code and not status_found_in_search) or (not recent_repunch and codes_needing_date_check)
    if needs_get_fallback and all_so_codes:
        check_limit = min(len(all_so_codes), 3)
        for so_code in reversed(all_so_codes[-check_limit:]):
            dto = get_order_dto(token, so_code)
            if not dto:
                continue
            if not delivered_code:
                get_status = extract_status(dto)
                if get_status and "DELIVER" in get_status:
                    delivered_code = so_code
            if not recent_repunch:
                get_created = extract_created_date(dto)
                if get_created:
                    get_ms = parse_timestamp(get_created)
                    if get_ms and (now_ms - get_ms) < cooldown_ms:
                        recent_repunch = {"code": so_code, "days_ago": round((now_ms - get_ms) / (24 * 60 * 60 * 1000), 1)}
            if delivered_code and recent_repunch:
                break

    if not orig_so_code:
        raise Exception(f"No order found for '{display_order_code}'")

    return {
        "orig_so_code": orig_so_code,
        "existing_codes": existing_codes,
        "delivered": delivered_code,
        "recent_repunch": recent_repunch,
    }


# ---- MySQL helpers - this worker's own pymysql connection, separate from Node's sql ----

def _connect():
    import mysql_lib
    cred = mysql_lib.get_credential()
    if cred is None:
        raise RuntimeError("MYSQL_* credentials not configured")
    import pymysql
    return pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=cred["database"], port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )



def fetch_job(conn, job_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, status, created_by, total_rows, processed_count, success_count, "
            "error_count, skipped_count, stop_requested FROM order_punch_jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    keys = ["id", "status", "created_by", "total_rows", "processed_count", "success_count",
            "error_count", "skipped_count", "stop_requested"]
    return dict(zip(keys, row))


def fetch_next_pending_row(conn, job_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT row_index, display_order_code, reason, facility_code FROM order_punch_job_rows "
            "WHERE job_id = %s AND status = 'pending' ORDER BY row_index LIMIT 1",
            (job_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {"row_index": row[0], "display_order_code": row[1], "reason": row[2], "facility_code": row[3]}


def count_pending_rows(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM order_punch_job_rows WHERE job_id = %s AND status = 'pending'", (job_id,))
        return cur.fetchone()[0]


def update_row_status(conn, job_id, row_index, status, so_code=None, target_channel=None, error_message=None):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE order_punch_job_rows SET status = %s, so_code = %s, target_channel = %s, "
            "error_message = %s, updated_at = now() WHERE job_id = %s AND row_index = %s",
            (status, so_code, target_channel, error_message, job_id, row_index),
        )
    conn.commit()


def update_job_counters(conn, job_id, **fields):
    if not fields:
        return
    set_clauses = []
    values = []
    for key, value in fields.items():
        set_clauses.append(f"{key} = %s")
        values.append(value)
    values.append(job_id)
    with conn.cursor() as cur:
        cur.execute(f"UPDATE order_punch_jobs SET {', '.join(set_clauses)}, updated_at = now() WHERE id = %s", values)
    conn.commit()


def fetch_settings(conn):
    with conn.cursor() as cur:
        # `key` backticked: it is a MySQL reserved word, so the unquoted form is a 1064
        # syntax error (api/_lib/db.js quotes it everywhere for the same reason).
        cur.execute("SELECT `key`, value FROM order_punch_settings")
        rows = cur.fetchall()
    settings = dict(DEFAULT_SETTINGS)
    for key, value in rows:
        settings[key] = json.loads(value) if isinstance(value, str) else value
    return settings


def invoke_self(job_id):
    import boto3
    boto3.client("lambda").invoke(
        FunctionName=WORKER_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps({"jobId": job_id}).encode("utf-8"),
    )


def process_one_row(conn, job_id, row, token, settings, agent_email):
    """One row's full attempt-plus-one-retry, mirroring the script's per-row try/except
    exactly: on a retryable failure (token expired, rate limited, "no order found"), refresh
    the token and retry once, checking first whether the earlier attempt actually succeeded
    despite the error (duplicate-create recovery) before trying to create again. Returns
    (outcome, possibly-refreshed token)."""
    row_index = row["row_index"]
    doc = row["display_order_code"]
    facility = row["facility_code"] or None
    reason = row["reason"] or None
    attempted_so_code = None

    try:
        sr = search_and_resolve(token, doc, settings)

        if sr["delivered"]:
            update_row_status(conn, job_id, row_index, "skipped",
                               error_message=f"ALREADY DELIVERED | {sr['delivered']} has status DELIVERED")
            return "skipped", token

        if sr["recent_repunch"]:
            update_row_status(conn, job_id, row_index, "skipped", error_message=(
                f"already repunched {sr['recent_repunch']['days_ago']} day(s) ago - "
                f"{sr['recent_repunch']['code']} (cooldown: {settings['cooldown_days']} days)"
            ))
            return "skipped", token

        order, _ = get_order(token, sr["orig_so_code"], facility, settings["facility_codes"])
        target_channel = resolve_target_channel(
            order.get("channel") or "", settings["mcaffeine_channels"], settings["hyphen_channels"],
            settings["target_mcaffeine"], settings["target_hyphen"],
        )
        same_channel = (order.get("channel") or "") == target_channel
        so_code = pick_so_code(doc, same_channel, sr["existing_codes"], settings["max_suffix"])
        if not so_code:
            update_row_status(conn, job_id, row_index, "skipped",
                               error_message=f"SKIPPED | max suffix _{settings['max_suffix']} reached")
            return "skipped", token

        attempted_so_code = so_code
        payload = build_create_payload(order, doc, so_code, target_channel, facility, reason, agent_email)
        create_order(token, facility, payload)
        update_row_status(conn, job_id, row_index, "success", so_code=so_code, target_channel=target_channel)
        return "success", token

    except Exception as e:
        retryable = isinstance(e, (TokenExpiredError, RateLimitedError)) or "No order found" in str(e)
        if not retryable:
            update_row_status(conn, job_id, row_index, "error", so_code=attempted_so_code, error_message=str(e))
            return "error", token

        try:
            token = get_uc_token()
            time.sleep(1)
            sr2 = search_and_resolve(token, doc, settings)

            if sr2["delivered"]:
                update_row_status(conn, job_id, row_index, "skipped",
                                   error_message=f"ALREADY DELIVERED | {sr2['delivered']} has status DELIVERED")
                return "skipped", token
            if sr2["recent_repunch"]:
                update_row_status(conn, job_id, row_index, "skipped", error_message=(
                    f"already repunched {sr2['recent_repunch']['days_ago']} day(s) ago - "
                    f"{sr2['recent_repunch']['code']} (cooldown: {settings['cooldown_days']} days)"
                ))
                return "skipped", token
            if attempted_so_code and attempted_so_code in sr2["existing_codes"]:
                # The first attempt's create actually succeeded despite the error - don't
                # create a second time.
                update_row_status(conn, job_id, row_index, "success", so_code=attempted_so_code)
                return "success", token

            order2, _ = get_order(token, sr2["orig_so_code"], facility, settings["facility_codes"])
            target_channel2 = resolve_target_channel(
                order2.get("channel") or "", settings["mcaffeine_channels"], settings["hyphen_channels"],
                settings["target_mcaffeine"], settings["target_hyphen"],
            )
            same_channel2 = (order2.get("channel") or "") == target_channel2
            so_code2 = pick_so_code(doc, same_channel2, sr2["existing_codes"], settings["max_suffix"])
            if not so_code2:
                update_row_status(conn, job_id, row_index, "skipped",
                                   error_message=f"SKIPPED | max suffix _{settings['max_suffix']} reached (order may already exist)")
                return "skipped", token

            payload2 = build_create_payload(order2, doc, so_code2, target_channel2, facility, reason, agent_email)
            create_order(token, facility, payload2)
            update_row_status(conn, job_id, row_index, "success", so_code=so_code2, target_channel=target_channel2)
            return "success", token

        except Exception as retry_err:
            so_tag = f"(SO: {attempted_so_code}) " if attempted_so_code else ""
            update_row_status(conn, job_id, row_index, "error", so_code=attempted_so_code,
                               error_message=f"{so_tag}(retry failed) {retry_err}")
            return "error", token


def process_job(job_id):
    """Entrypoint - one Lambda invoke's worth of work. Self-invokes to continue if rows remain
    pending after CHUNK_BUDGET_SEC, mirroring the Apps Script's own always-resume design (see
    the design spec's Error handling section)."""
    try:
        conn = _connect()
    except Exception as e:
        print(f"process_job({job_id}): could not connect to MySQL, giving up: {e}")
        return

    try:
        job = fetch_job(conn, job_id)
        if job is None:
            print(f"process_job({job_id}): job not found")
            return
        if job["stop_requested"]:
            update_job_counters(conn, job_id, status="stopped")
            return
        if job["status"] == "done":
            print(f"process_job({job_id}): already done, skipping duplicate invoke")
            return

        update_job_counters(conn, job_id, status="running")
        settings = fetch_settings(conn)
        agent_email = job["created_by"]

        token = get_uc_token()
        token_fetched_at = time.monotonic()
        started_at = time.monotonic()
        consecutive_403 = 0
        success = job["success_count"]
        errors = job["error_count"]
        skipped = job["skipped_count"]
        processed = job["processed_count"]

        while time.monotonic() - started_at < CHUNK_BUDGET_SEC:
            fresh = fetch_job(conn, job_id)
            if fresh and fresh["stop_requested"]:
                update_job_counters(conn, job_id, status="stopped")
                return

            row = fetch_next_pending_row(conn, job_id)
            if row is None:
                break

            if time.monotonic() - token_fetched_at > TOKEN_REFRESH_SEC:
                try:
                    token = get_uc_token()
                    token_fetched_at = time.monotonic()
                except Exception as refresh_err:
                    print(f"  token refresh failed, keeping old token: {refresh_err}")

            if consecutive_403 >= MAX_CONSECUTIVE_403:
                time.sleep(30)
                consecutive_403 = 0
                try:
                    token = get_uc_token()
                    token_fetched_at = time.monotonic()
                except Exception:
                    pass

            try:
                outcome, token = process_one_row(conn, job_id, row, token, settings, agent_email)
            except (TokenExpiredError, RateLimitedError):
                # process_one_row already handles these internally via its own retry - reaching
                # here would only happen if that retry itself raised one of these again, which
                # process_one_row's own except-all already converts to a row-level "error"
                # instead of propagating. Kept as a defensive fallback, not the expected path.
                outcome = "error"
            if outcome == "success":
                success += 1
                consecutive_403 = 0
            elif outcome == "skipped":
                skipped += 1
                consecutive_403 = 0
            else:
                errors += 1
            processed += 1
            update_job_counters(conn, job_id, processed_count=processed, success_count=success,
                                 error_count=errors, skipped_count=skipped)
            time.sleep(SLEEP_BETWEEN_SEC)

        remaining = count_pending_rows(conn, job_id)
        if remaining > 0:
            print(f"process_job({job_id}): {remaining} row(s) still pending, scheduling continuation")
            invoke_self(job_id)
        else:
            update_job_counters(conn, job_id, status="done")
            print(f"process_job({job_id}): done - {success} success, {errors} error, {skipped} skipped")

    except Exception as e:
        print(f"process_job({job_id}): chunk crashed: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            fresh = fetch_job(conn, job_id)
        except Exception:
            fresh = None
        if fresh and fresh.get("stop_requested"):
            try:
                update_job_counters(conn, job_id, status="stopped")
            except Exception:
                pass
        else:
            try:
                invoke_self(job_id)
            except Exception as invoke_err:
                print(f"process_job({job_id}): could not schedule continuation after crash: {invoke_err}")
                try:
                    update_job_counters(conn, job_id, status="failed", error_message=str(e))
                except Exception:
                    pass
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python process_order_punch_job.py <job_id>")
    process_job(int(sys.argv[1]))
