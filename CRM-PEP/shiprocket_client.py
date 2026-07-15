"""Shiprocket API client - pulls NDR (non-delivery) and RTO shipments to feed as CRM leads.

Confirmed against Shiprocket's public docs/support articles:
  - Auth:  POST https://apiv2.shiprocket.in/v1/external/auth/login  {email, password} -> {token}
           Token is valid 240 hours; we cache it locally and re-login once it's stale.
  - NDR:   GET  https://apiv2.shiprocket.in/v1/external/ndr/all?page=N
  - Orders GET  https://apiv2.shiprocket.in/v1/external/orders?page=N&per_page=&from=&to=

There is no documented dedicated "RTO" endpoint - Shiprocket's own docs describe RTO as a
status on the orders/shipments list (statuses like "RTO Initiated", "RTO Delivered",
"RTO Acknowledged"). So RTO leads are sourced from the orders endpoint, filtered client-side
by a case-insensitive "RTO" match on the status field, rather than a filter param whose exact
accepted value we could not confirm from public docs.

Shiprocket does not publish a full response-field reference for these two endpoints (their
docs site is JS-rendered and not scrapable). Field extraction below tries several candidate
key names seen in community SDKs/integrations, but the FULL raw record is always kept in
raw_data so nothing is lost if a specific field guess misses. Run
`python sync_leads.py --dry-run` against real credentials and check the printed sample record
before relying on any single extracted field.
"""
import time
import json
from pathlib import Path

import requests

import config

BASE_URL = "https://apiv2.shiprocket.in/v1/external"
TOKEN_CACHE_FILE = Path(__file__).resolve().parent / ".shiprocket_token.json"
TOKEN_VALID_SECONDS = 239 * 3600  # refresh a little before the documented 240h expiry


class ShiprocketError(RuntimeError):
    pass


class ShiprocketClient:
    def __init__(self, email=None, password=None):
        self.email = email or config.get("SHIPROCKET_EMAIL", required=True)
        self.password = password or config.get("SHIPROCKET_PASSWORD", required=True)
        self._token = None

    # -- auth -----------------------------------------------------------
    def _load_cached_token(self):
        if not TOKEN_CACHE_FILE.exists():
            return None
        try:
            data = json.loads(TOKEN_CACHE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if data.get("email") != self.email:
            return None
        if time.time() - data.get("fetched_at", 0) > TOKEN_VALID_SECONDS:
            return None
        return data.get("token")

    def _save_token(self, token):
        TOKEN_CACHE_FILE.write_text(
            json.dumps({"email": self.email, "token": token, "fetched_at": time.time()}),
            encoding="utf-8",
        )

    def _login(self):
        resp = requests.post(
            f"{BASE_URL}/auth/login",
            json={"email": self.email, "password": self.password},
            timeout=30,
        )
        if resp.status_code != 200:
            raise ShiprocketError(f"Shiprocket login failed ({resp.status_code}): {resp.text[:300]}")
        token = resp.json().get("token")
        if not token:
            raise ShiprocketError("Shiprocket login response had no token")
        self._save_token(token)
        return token

    def _get_token(self):
        if self._token:
            return self._token
        self._token = self._load_cached_token() or self._login()
        return self._token

    def _headers(self):
        return {"Authorization": f"Bearer {self._get_token()}"}

    def _request(self, method, path, **kwargs):
        resp = requests.request(method, f"{BASE_URL}{path}", headers=self._headers(), timeout=30, **kwargs)
        if resp.status_code == 401:
            # token expired/invalid server-side even though our cache thought it was fresh - relogin once
            self._token = self._login()
            resp = requests.request(method, f"{BASE_URL}{path}", headers=self._headers(), timeout=30, **kwargs)
        if resp.status_code >= 400:
            raise ShiprocketError(f"Shiprocket {method} {path} failed ({resp.status_code}): {resp.text[:300]}")
        return resp.json()

    @staticmethod
    def _pick(record, *keys, default=None):
        for key in keys:
            value = record.get(key)
            if value not in (None, ""):
                return value
        return default

    @staticmethod
    def _extract_page(payload):
        """Shiprocket list endpoints wrap results under a 'data' key in every SDK/integration
        we found documented; fall back to treating the payload itself as the list."""
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("data", "ndr", "results"):
                value = payload.get(key)
                if isinstance(value, list):
                    return value
        return []

    # -- NDR leads --------------------------------------------------------
    def iter_ndr_records(self, max_pages=50):
        for page in range(1, max_pages + 1):
            payload = self._request("GET", "/ndr/all", params={"page": page})
            records = self._extract_page(payload)
            if not records:
                break
            yield from records

    def get_ndr_leads(self, max_pages=50):
        leads = []
        for record in self.iter_ndr_records(max_pages=max_pages):
            leads.append({
                "source": "ndr",
                "shiprocket_order_id": str(self._pick(record, "order_id", "orderId", default="")),
                "shiprocket_shipment_id": str(self._pick(record, "shipment_id", "shipmentId", default="")),
                "awb": str(self._pick(record, "awb", "awb_code", default="")),
                "channel_order_id": str(self._pick(record, "channel_order_id", "order_number", default="")),
                "customer_name": self._pick(record, "customer_name", "customer_full_name", "name"),
                "customer_phone": self._pick(record, "customer_phone", "phone", "customer_phone_number"),
                "customer_address": self._pick(record, "customer_address", "address", "delivery_address"),
                "courier_name": self._pick(record, "courier_name", "courier"),
                "order_value": self._pick(record, "order_value", "total", "cod_amount"),
                "status": self._pick(record, "ndr_status", "status", default="NDR"),
                "reason": self._pick(record, "ndr_reason", "reason", "comments"),
                "attempts": self._pick(record, "attempts", "ndr_count", default=0),
                "raw_data": record,
            })
        return leads

    # -- RTO leads (derived from the orders list, filtered by status) -----
    def iter_order_records(self, from_date, to_date, max_pages=50, per_page=100):
        for page in range(1, max_pages + 1):
            payload = self._request(
                "GET", "/orders",
                params={"page": page, "per_page": per_page, "from": from_date, "to": to_date},
            )
            records = self._extract_page(payload)
            if not records:
                break
            yield from records
            if len(records) < per_page:
                break

    def get_rto_leads(self, from_date, to_date, max_pages=50):
        leads = []
        for record in self.iter_order_records(from_date, to_date, max_pages=max_pages):
            status = str(self._pick(record, "status", default=""))
            if "rto" not in status.lower():
                continue
            leads.append({
                "source": "rto",
                "shiprocket_order_id": str(self._pick(record, "id", "order_id", default="")),
                "shiprocket_shipment_id": str(self._pick(record, "shipment_id", default="")),
                "awb": str(self._pick(record, "awb", "awb_code", default="")),
                "channel_order_id": str(self._pick(record, "channel_order_id", "channel_order_number", default="")),
                "customer_name": self._pick(record, "customer_name", "billing_customer_name"),
                "customer_phone": self._pick(record, "customer_phone", "billing_phone", "customer_phone_number"),
                "customer_address": self._pick(record, "customer_address", "billing_address"),
                "courier_name": self._pick(record, "courier_name", "courier"),
                "order_value": self._pick(record, "order_value", "total", "channel_total"),
                "status": status,
                "reason": self._pick(record, "reason", "comments"),
                "attempts": self._pick(record, "attempts", default=0),
                "raw_data": record,
            })
        return leads
