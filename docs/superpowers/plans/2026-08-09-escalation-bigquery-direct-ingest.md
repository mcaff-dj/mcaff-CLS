# Escalation Direct BigQuery Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load escalation tickets into BigQuery directly from MySQL, sweep the sheet's formula columns back into the same table, and move every application read and write onto BigQuery.

**Architecture:** Three writers own disjoint column groups of one `escalation.orders` table. A new Python job loads ticket columns from MySQL; the existing sheet job is untouched and keeps the sheet's formulas alive; a new sweep pulls the formula and logistics columns back. The Node API only reads and writes — all ingest is Python, so there is no sync endpoint, no shared secret, and no Apps Script.

**Tech Stack:** Python 3.12 (`requests`, `pymysql` — already in `requirements-report.txt`), BigQuery REST API v2, Node 18+ with `google-auth-library`, Next.js 14 client, GitHub Actions.

**Design spec:** [`docs/superpowers/specs/2026-08-09-escalation-bigquery-direct-ingest-design.md`](../specs/2026-08-09-escalation-bigquery-direct-ingest-design.md)

**Supersedes:** [`2026-08-09-escalation-bigquery-migration.md`](2026-08-09-escalation-bigquery-migration.md), left in place unchanged.

## Global Constraints

- **Do not modify `scripts/sync_delivery_tickets_to_sheet.py` or `scripts/lib.py`.** The new loader imports functions from the former; the BigQuery helper registers its own token-cache slot in the latter at runtime. Zero edits to either file.
- **No new pip or npm dependencies.** Python reaches BigQuery over REST reusing `lib._get_token`. Node reaches it over REST with a `google-auth-library` JWT. `@google-cloud/bigquery` and `google-cloud-bigquery` are both forbidden — the Lambda bundle is near the 6MB payload ceiling and the Actions runners should stay fast.
- **Load jobs only, never streaming inserts.** Rows written by `tabledata.insertAll` or the Storage Write API sit in a streaming buffer where `UPDATE`/`MERGE` fails for up to 90 minutes.
- **Column ownership is absolute.** The loader writes only ticket-owned columns. The sweep writes only sheet-owned columns *on its matched arm*. The app writes only app-owned columns. Violating this silently destroys another writer's data, so each language's test suite asserts it.
- **One table for both brands.** `escalation.orders` holds `HYPHEN` and `mCaffeine` rows, separated by the `brand` column. No per-brand tables, no per-brand datasets.
- **Row key is `(brand, parent_order, awb_key)`** where `awb_key = LOWER(TRIM(COALESCE(awb_number, '')))`. Never `row_number` — sheet row numbers shift when anyone sorts.
- **Every bulk path is one statement.** No code path issues N BigQuery statements for N rows.
- **Python owns the schema.** Only `scripts/escalation_bq_schema.py` issues DDL. Node assumes the tables exist and never creates them, so the two languages cannot drift on table definitions.
- **No live testing, no deploy.** Python tests use plain `assert` with no network, in the style of `sync_delivery_tickets_to_sheet.py`'s existing `--self-check` ([line 256](../../../scripts/sync_delivery_tickets_to_sheet.py#L256)). Node tests stub `globalThis.fetch`. Never run anything against real BigQuery, the real sheet, or the real database. Never deploy. The user tests and deploys.
- **Credentials:** Python uses the `GOOGLE_SA_KEY` Actions secret via `lib.get_sa_credential()`. Node reuses `GOOGLE_SHEETS_CLIENT_EMAIL` / `GOOGLE_SHEETS_PRIVATE_KEY`. Both principals need **BigQuery Data Editor** and **BigQuery Job User** on `BQ_PROJECT_ID`.
- **New env vars:** `BQ_PROJECT_ID`, `BQ_DATASET` (default `escalation`).
- **Test commands:** `python scripts/test_escalation_ingest.py` and `npm run test:escalation`.
- **Code style:** match the surrounding files. Python scripts use module docstrings explaining *why*, `argparse` with `--dry-run`, and print progress with two-space indents (see `sync_delivery_tickets_to_sheet.py`). Node `api/` files use CommonJS.

## Column ownership

This table is the contract every task is checked against.

| Group | Columns | Written by |
|---|---|---|
| Identity | `brand`, `parent_order`, `awb_number`, `awb_key` | whichever writer inserts the row first |
| Ticket | `added_date`, `query_class`, `query_category`, `delivery_partner_name`, `order_date`, `order_month`, `query_date`, `query_month`, `wh_name`, `ticket_number` | loader (Task 3) |
| Sheet | `total_times_consumer_reached`, `delivered_date`, `status_as_per_awb`, `solv_date`, `tat`, `update_from_logistics`, `city`, `state` | sweep (Task 4) |
| App | `new_order_id`, `new_awb`, `status`, `notes`, `resolved_at`, `resolved_by`, `assigned_to`, `assigned_at` | API (Tasks 8–9) |
| Lifecycle | `synced_at`, `ticket_loaded_at`, `deleted_from_sheet_at`, `row_number` | ingest |

## File Structure

| File | Responsibility |
|---|---|
| `scripts/bq_lib.py` | **New.** BigQuery transport for Python. Token, `query`, `load_ndjson`, job polling. |
| `scripts/escalation_bq_schema.py` | **New.** Single source of truth for DDL, ownership lists, the sheet index→column table, row mapping, and MERGE builders. Imported by the loader, the sweep, and the migration. |
| `scripts/sync_delivery_tickets_to_bq.py` | **New.** Ticket loader. MySQL → BigQuery. |
| `scripts/sync_escalation_sheet_to_bq.py` | **New.** Sheet sweep. Sheet L:S → BigQuery. |
| `scripts/migrate_escalation_to_bq.py` | **New.** One-off backfill and reconciliation. |
| `scripts/test_escalation_ingest.py` | **New.** Offline self-check, Python side. |
| `.github/workflows/sync-escalation-bq.yml` | **New.** Loader on a schedule, sweep on `workflow_dispatch`. |
| `api/_lib/bigquery.js` | **New.** BigQuery transport for the request path. |
| `api/_lib/escalationBq.js` | **New.** Application reads and writes. No DDL, no sync. |
| `api/_lib/escalationSheet.js` | **Delete.** Nothing in the API touches the sheet any more. |
| `api/escalation/[action].js` | **Modify.** Point at `escalationBq`; add `assign-bulk`. |
| `api/_lib/db.js` | **Modify.** Drop six escalation exports, add `pgSql`. |
| `app/escalation/EscalationClient.js` | **Modify.** Payload keys, single-call auto-assign, optimistic writes. |
| `scripts/test_escalation_bq.js` | **New.** Offline self-check, Node side. |

---

### Task 1: Python BigQuery transport

**Files:**
- Create: `scripts/bq_lib.py`
- Create: `scripts/test_escalation_ingest.py`

**Interfaces:**
- Consumes: `lib._get_token`, `lib._token_cache`.
- Produces:
  - `project_id() -> str`, `dataset_id() -> str`
  - `query(sql, params=None) -> dict` (raw `jobs.query` response)
  - `query_rows(sql, params=None) -> list[dict]`
  - `str_param(name, value) -> dict`
  - `struct_array_param(name, fields, rows) -> dict`
  - `load_ndjson(table_id, ndjson, schema_fields) -> int`

- [ ] **Step 1: Write the failing test**

Create `scripts/test_escalation_ingest.py`:

```python
"""Offline self-check for the escalation BigQuery ingest scripts.

    python scripts/test_escalation_ingest.py

No network, no BigQuery, no sheet, no MySQL: every test monkeypatches the transport, so this is
safe to run anywhere. Each task in the implementation plan appends its own section; keep them in
task order.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PASSED = []
FAILED = []


def test(name):
    def deco(fn):
        try:
            fn()
            PASSED.append(name)
            print(f"  ok  {name}")
        except AssertionError as e:
            FAILED.append(name)
            print(f"FAIL  {name}\n      {e}")
        return fn
    return deco


class FakeResponse:
    def __init__(self, body, status=200):
        self._body = body
        self.status_code = status
        self.text = json.dumps(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


import bq_lib

bq_lib._access_token = lambda: "test-token"


# ---------- Task 1: transport ----------

@test("str_param encodes a named STRING parameter")
def _():
    assert bq_lib.str_param("brand", "HYPHEN") == {
        "name": "brand",
        "parameterType": {"type": "STRING"},
        "parameterValue": {"value": "HYPHEN"},
    }


@test("str_param passes None through instead of stringifying it")
def _():
    assert bq_lib.str_param("notes", None)["parameterValue"]["value"] is None


@test("struct_array_param encodes an array of all-STRING structs")
def _():
    p = bq_lib.struct_array_param(
        "items", ["brand", "parent_order"],
        [{"brand": "HYPHEN", "parent_order": "HYP1"}],
    )
    assert p["parameterType"]["type"] == "ARRAY"
    assert p["parameterType"]["arrayType"]["structTypes"] == [
        {"name": "brand", "type": {"type": "STRING"}},
        {"name": "parent_order", "type": {"type": "STRING"}},
    ]
    vals = p["parameterValue"]["arrayValues"]
    assert len(vals) == 1
    assert vals[0]["structValues"]["parent_order"]["value"] == "HYP1"


@test("query_rows maps BigQuery's positional row shape to dicts")
def _():
    captured = {}

    def fake_post(url, **kw):
        captured["url"] = url
        captured["body"] = kw["json"]
        return FakeResponse({
            "jobComplete": True,
            "schema": {"fields": [{"name": "brand"}, {"name": "n"}]},
            "rows": [{"f": [{"v": "HYPHEN"}, {"v": "42"}]}],
        })

    bq_lib.requests.post = fake_post
    rows = bq_lib.query_rows("SELECT 1", [bq_lib.str_param("brand", "HYPHEN")])
    assert rows == [{"brand": "HYPHEN", "n": "42"}], rows
    assert captured["body"]["parameterMode"] == "NAMED"
    assert captured["body"]["useLegacySql"] is False


@test("query raises with BigQuery's own message, not a bare status code")
def _():
    bq_lib.requests.post = lambda url, **kw: FakeResponse(
        {"error": {"message": "Syntax error near MERGE"}}, status=400)
    try:
        bq_lib.query("MERGE bad")
        raise AssertionError("expected a failure")
    except RuntimeError as e:
        assert "Syntax error near MERGE" in str(e), e


@test("load_ndjson submits a multipart load job with WRITE_TRUNCATE, never a stream")
def _():
    calls = []

    def fake_post(url, **kw):
        calls.append((url, kw))
        return FakeResponse({"jobReference": {"jobId": "job-1", "location": "US"}})

    def fake_get(url, **kw):
        calls.append((url, kw))
        return FakeResponse({"status": {"state": "DONE"},
                             "statistics": {"load": {"outputRows": "3"}}})

    bq_lib.requests.post = fake_post
    bq_lib.requests.get = fake_get
    loaded = bq_lib.load_ndjson("orders_staging", '{"a":1}\n', [{"name": "a", "type": "STRING"}])
    assert loaded == 3, loaded
    url, kw = calls[0]
    assert "uploadType=multipart" in url, url
    assert "insertAll" not in url, "streaming insert is forbidden"
    assert '"writeDisposition": "WRITE_TRUNCATE"' in kw["data"] or \
           '"writeDisposition":"WRITE_TRUNCATE"' in kw["data"], kw["data"][:300]


@test("load_ndjson raises when the job finishes with an errorResult")
def _():
    bq_lib.requests.post = lambda url, **kw: FakeResponse(
        {"jobReference": {"jobId": "job-2", "location": "US"}})
    bq_lib.requests.get = lambda url, **kw: FakeResponse(
        {"status": {"state": "DONE", "errorResult": {"message": "schema mismatch"}}})
    try:
        bq_lib.load_ndjson("orders_staging", "{}\n", [])
        raise AssertionError("expected a failure")
    except RuntimeError as e:
        assert "schema mismatch" in str(e), e


# ---------- summary ----------
if __name__ == "__main__":
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_escalation_ingest.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'bq_lib'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/bq_lib.py`:

```python
"""BigQuery over REST, in the same shape as lib.py's Sheets access.

Deliberately not google-cloud-bigquery: lib.py already mints service-account JWTs and calls
Google REST endpoints directly (see lib._get_token), so a BigQuery client here is a thin wrapper
over machinery this repo already owns, and the Actions runners install nothing extra.

LOAD JOBS, NOT STREAMING INSERTS. Nothing here writes via tabledata.insertAll. Rows written by
the streaming API sit in a streaming buffer where UPDATE/DELETE/MERGE fail with "would affect
rows in the streaming buffer" for up to 90 minutes, which would break every write path the
Escalation desk has. Load jobs write straight to managed storage, and are free.
"""
import json
import os
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

API = "https://bigquery.googleapis.com/bigquery/v2"
UPLOAD_API = "https://bigquery.googleapis.com/upload/bigquery/v2"
SCOPE = "https://www.googleapis.com/auth/bigquery"

# lib._token_cache is a fixed dict of slots, and lib.py is not ours to edit - register our own
# slot at import instead, so _get_token's caching works for the bigquery scope too.
lib._token_cache.setdefault("bigquery", {"token": None, "expiry": 0})


def _access_token():
    return lib._get_token(SCOPE, "bigquery")


def _headers():
    return {"Authorization": f"Bearer {_access_token()}"}


def project_id():
    pid = os.environ.get("BQ_PROJECT_ID")
    if not pid:
        raise RuntimeError("BQ_PROJECT_ID is not set.")
    return pid


def dataset_id():
    return os.environ.get("BQ_DATASET", "escalation")


# Only STRING scalars and arrays of all-STRING structs are supported, because that is all this
# desk needs - every sheet column is text and every bulk payload is a list of text fields.
def str_param(name, value):
    return {
        "name": name,
        "parameterType": {"type": "STRING"},
        "parameterValue": {"value": None if value is None else str(value)},
    }


def struct_array_param(name, fields, rows):
    return {
        "name": name,
        "parameterType": {
            "type": "ARRAY",
            "arrayType": {
                "type": "STRUCT",
                "structTypes": [{"name": f, "type": {"type": "STRING"}} for f in fields],
            },
        },
        "parameterValue": {
            "arrayValues": [
                {"structValues": {
                    f: {"value": None if r.get(f) is None else str(r.get(f))} for f in fields
                }}
                for r in rows
            ]
        },
    }


def query(sql, params=None, timeout_sec=180):
    resp = requests.post(
        f"{API}/projects/{project_id()}/queries",
        headers=_headers(),
        json={
            "query": sql,
            "useLegacySql": False,
            "parameterMode": "NAMED",
            "queryParameters": params or [],
            "timeoutMs": 120000,
            "defaultDataset": {"projectId": project_id(), "datasetId": dataset_id()},
        },
        timeout=timeout_sec,
    )
    data = resp.json()
    if resp.status_code >= 400:
        raise RuntimeError(data.get("error", {}).get("message", f"BigQuery query failed ({resp.status_code})"))
    if data.get("errors"):
        raise RuntimeError(data["errors"][0].get("message", "BigQuery query failed"))
    return data


def query_rows(sql, params=None):
    """Rows as dicts. BigQuery returns them positionally against a separate schema."""
    data = query(sql, params)
    fields = [f["name"] for f in data.get("schema", {}).get("fields", [])]
    out = []
    for row in data.get("rows", []):
        cells = row.get("f", [])
        out.append({name: (cells[i].get("v") if i < len(cells) else None)
                    for i, name in enumerate(fields)})
    return out


def affected_rows(data):
    return int(data.get("numDmlAffectedRows", 0))


def _wait_for_job(job_id, location, timeout_sec=300):
    params = {"location": location} if location else None
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        resp = requests.get(f"{API}/projects/{project_id()}/jobs/{job_id}",
                            headers=_headers(), params=params, timeout=60)
        data = resp.json()
        if resp.status_code >= 400:
            raise RuntimeError(data.get("error", {}).get("message", "BigQuery job poll failed"))
        status = data.get("status", {})
        if status.get("state") == "DONE":
            if status.get("errorResult"):
                raise RuntimeError(status["errorResult"].get("message", "BigQuery load job failed"))
            return int(data.get("statistics", {}).get("load", {}).get("outputRows", 0))
        time.sleep(2)
    raise RuntimeError(f"BigQuery job {job_id} did not finish within {timeout_sec}s")


def load_ndjson(table_id, ndjson, schema_fields):
    """Load NDJSON into a table, replacing its contents.

    ponytail: multipart upload, comfortable to ~10MB. Both escalation tabs together are 2-4MB
    today. Past that, switch to a resumable upload or stage the file through GCS.
    """
    metadata = {
        "configuration": {
            "load": {
                "destinationTable": {
                    "projectId": project_id(), "datasetId": dataset_id(), "tableId": table_id,
                },
                "sourceFormat": "NEWLINE_DELIMITED_JSON",
                "writeDisposition": "WRITE_TRUNCATE",
                "schema": {"fields": schema_fields},
            }
        }
    }
    boundary = "bq-load-boundary"
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
        f"{ndjson}\r\n"
        f"--{boundary}--\r\n"
    )
    resp = requests.post(
        f"{UPLOAD_API}/projects/{project_id()}/jobs?uploadType=multipart",
        headers={**_headers(), "Content-Type": f"multipart/related; boundary={boundary}"},
        data=body.encode("utf-8"),
        timeout=300,
    )
    data = resp.json()
    if resp.status_code >= 400:
        raise RuntimeError(data.get("error", {}).get("message", f"BigQuery load failed ({resp.status_code})"))
    ref = data["jobReference"]
    return _wait_for_job(ref["jobId"], ref.get("location"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_escalation_ingest.py`
Expected: PASS — 7 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add scripts/bq_lib.py scripts/test_escalation_ingest.py
git commit -m "feat(bq): Python BigQuery transport reusing lib.py's JWT"
```

---

### Task 2: Shared schema and MERGE builders

**Files:**
- Create: `scripts/escalation_bq_schema.py`
- Modify: `scripts/test_escalation_ingest.py`

**Interfaces:**
- Produces:
  - `ORDERS`, `STAGING`, `EVENTS` — table name constants
  - `IDENTITY_COLUMNS`, `TICKET_COLUMNS`, `SHEET_COLUMNS`, `APP_COLUMNS`, `LIFECYCLE_COLUMNS`
  - `SHEET_INDEX_TO_COLUMN: dict[int, str]` — position in a 26-cell sheet row → BigQuery column
  - `ORDERS_SCHEMA`, `STAGING_SCHEMA`, `EVENTS_SCHEMA`
  - `awb_key(value) -> str`
  - `sheet_row_to_bq(cells, brand, row_number=None) -> dict`
  - `create_tables()` — issues the DDL
  - `build_sweep_merge() -> str`, `build_ticket_merge() -> str`
  - `count_duplicate_keys(rows) -> int`

`SHEET_INDEX_TO_COLUMN` is the load-bearing piece: `sync_delivery_tickets_to_sheet.build_sheet_row()` already returns a 26-element list in exact sheet-column order, so the loader and the sweep map their rows through the same table rather than each inventing one.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_ingest.py`, immediately before the `# ---------- summary ----------` block:

```python
# ---------- Task 2: schema ----------

import escalation_bq_schema as schema


@test("column ownership groups do not overlap")
def _():
    groups = {
        "identity": set(schema.IDENTITY_COLUMNS),
        "ticket": set(schema.TICKET_COLUMNS),
        "sheet": set(schema.SHEET_COLUMNS),
        "app": set(schema.APP_COLUMNS),
        "lifecycle": set(schema.LIFECYCLE_COLUMNS),
    }
    names = list(groups)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            overlap = groups[a] & groups[b]
            assert not overlap, f"{a} and {b} both claim {overlap}"


@test("the sheet index table covers every column the tabs carry")
def _():
    # 26 cells (A..Z); X and Y are unused and deliberately absent.
    mapped = schema.SHEET_INDEX_TO_COLUMN
    assert mapped[0] == "added_date"
    assert mapped[3] == "parent_order"
    assert mapped[4] == "awb_number"
    assert mapped[13] == "status_as_per_awb"
    assert mapped[15] == "tat"
    assert mapped[16] == "update_from_logistics"
    assert mapped[21] == "status"
    assert mapped[25] == "ticket_number"
    assert 23 not in mapped and 24 not in mapped, "columns X and Y are not carried across"


@test("awb_key trims and lowercases, and turns blank into empty string")
def _():
    assert schema.awb_key(" AWB123 ") == "awb123"
    assert schema.awb_key("") == ""
    assert schema.awb_key(None) == ""


@test("sheet_row_to_bq maps a padded sheet row and derives the key")
def _():
    cells = [""] * 26
    cells[0] = "Aug 9, 2026"
    cells[3] = "HYP32557370"
    cells[4] = " AWB1 "
    cells[13] = "RTO"
    cells[15] = "Forced to be marked as RTO"
    cells[25] = "TKT-9"
    row = schema.sheet_row_to_bq(cells, "HYPHEN", row_number=42)
    assert row["brand"] == "HYPHEN"
    assert row["parent_order"] == "HYP32557370"
    assert row["awb_number"] == " AWB1 "
    assert row["awb_key"] == "awb1"
    assert row["row_number"] == 42
    assert row["status_as_per_awb"] == "RTO"
    assert row["ticket_number"] == "TKT-9"


@test("sheet_row_to_bq tolerates a short row, as the Sheets API returns them")
def _():
    row = schema.sheet_row_to_bq(["Aug 9, 2026", "Delivery", "", "HYP1"], "mCaffeine")
    assert row["parent_order"] == "HYP1"
    assert row["awb_number"] == ""
    assert row["awb_key"] == ""
    assert row["tat"] == ""


@test("the sweep MERGE's matched arm writes sheet columns only")
def _():
    sql = schema.build_sweep_merge()
    matched = sql[sql.index("WHEN MATCHED"):sql.index("WHEN NOT MATCHED BY TARGET")]
    for col in schema.TICKET_COLUMNS + schema.APP_COLUMNS:
        assert f" {col} =" not in matched, \
            f"sweep must not overwrite {col} - it belongs to another writer"
    for col in schema.SHEET_COLUMNS:
        assert f" {col} =" in matched, f"sweep is missing sheet column {col}"


@test("the sweep MERGE inserts full rows for orders the loader has not seen")
def _():
    sql = schema.build_sweep_merge()
    insert = sql[sql.index("WHEN NOT MATCHED BY TARGET"):sql.index("WHEN NOT MATCHED BY SOURCE")]
    for col in schema.TICKET_COLUMNS:
        assert col in insert, f"legacy sheet rows need {col} on insert"


@test("the sweep MERGE soft-deletes, scoped to the brand being swept")
def _():
    sql = schema.build_sweep_merge()
    arm = sql[sql.index("WHEN NOT MATCHED BY SOURCE"):]
    assert "T.brand = @brand" in arm, \
        "without this guard, sweeping HYPHEN soft-deletes every mCaffeine row"
    assert "deleted_from_sheet_at = CURRENT_TIMESTAMP()" in arm
    assert "DELETE" not in arm, "rows are soft-deleted, never hard-deleted"


@test("the sweep MERGE deduplicates its source")
def _():
    sql = schema.build_sweep_merge()
    assert "QUALIFY ROW_NUMBER() OVER" in sql
    assert "PARTITION BY brand, parent_order, awb_key ORDER BY row_number" in sql


@test("the ticket MERGE writes ticket columns only")
def _():
    sql = schema.build_ticket_merge()
    for col in schema.SHEET_COLUMNS + schema.APP_COLUMNS:
        assert f" {col} =" not in sql, f"loader must not touch {col}"
    for col in schema.TICKET_COLUMNS:
        assert f" {col} =" in sql, f"loader is missing ticket column {col}"


@test("count_duplicate_keys counts collisions on the row key")
def _():
    rows = [
        {"brand": "HYPHEN", "parent_order": "HYP1", "awb_key": "awb1"},
        {"brand": "HYPHEN", "parent_order": "HYP1", "awb_key": "awb1"},
        {"brand": "HYPHEN", "parent_order": "HYP2", "awb_key": "awb2"},
    ]
    assert schema.count_duplicate_keys(rows) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_escalation_ingest.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'escalation_bq_schema'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/escalation_bq_schema.py`:

```python
"""Single source of truth for the escalation BigQuery tables.

Imported by the ticket loader, the sheet sweep, and the migration, so all three agree on column
names, ownership, and the row key. Node has its own copy of the read/write SQL but issues no DDL
at all - the tables are created here and only here, so the two languages cannot drift.

THE ONE INVARIANT: three writers, disjoint column groups.

    loader  -> TICKET_COLUMNS   (from MySQL)
    sweep   -> SHEET_COLUMNS    (formulas L:P and the logistics paste Q:S)
    the app -> APP_COLUMNS      (resolutions and assignment)

No writer's statement may name another's column. Cross that line and one run silently destroys
the other's data, which is why scripts/test_escalation_ingest.py asserts it on the generated SQL
rather than trusting review.

ONE TABLE FOR BOTH BRANDS. escalation.orders holds HYPHEN and mCaffeine rows together, separated
by the `brand` column. Those literals match the sheet tab names and the hyphen_tickets /
mcaff_tickets MySQL split, so nothing anywhere has to translate them.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib

ORDERS = "orders"
STAGING = "orders_staging"
EVENTS = "assignment_events"

BRANDS = ["HYPHEN", "mCaffeine"]

IDENTITY_COLUMNS = ["brand", "parent_order", "awb_number", "awb_key"]

TICKET_COLUMNS = [
    "added_date", "query_class", "query_category", "delivery_partner_name",
    "order_date", "order_month", "query_date", "query_month", "wh_name", "ticket_number",
]

SHEET_COLUMNS = [
    "total_times_consumer_reached", "delivered_date", "status_as_per_awb", "solv_date",
    "tat", "update_from_logistics", "city", "state",
]

APP_COLUMNS = [
    "new_order_id", "new_awb", "status", "notes",
    "resolved_at", "resolved_by", "assigned_to", "assigned_at",
]

LIFECYCLE_COLUMNS = ["synced_at", "ticket_loaded_at", "deleted_from_sheet_at", "row_number"]

# Position in a 26-cell sheet row (A..Z) -> BigQuery column.
#
# sync_delivery_tickets_to_sheet.build_sheet_row() returns a list in exactly this order, so the
# loader maps its rows through the same table the sweep uses - one definition of "which cell is
# which", not two that can drift.
#
# 23 and 24 (columns X and Y) are absent on purpose: unused by the app, not carried across.
SHEET_INDEX_TO_COLUMN = {
    0: "added_date", 1: "query_class", 2: "query_category", 3: "parent_order",
    4: "awb_number", 5: "delivery_partner_name", 6: "order_date", 7: "order_month",
    8: "query_date", 9: "query_month", 10: "wh_name", 11: "total_times_consumer_reached",
    12: "delivered_date", 13: "status_as_per_awb", 14: "solv_date", 15: "tat",
    16: "update_from_logistics", 17: "city", 18: "state", 19: "new_order_id",
    20: "new_awb", 21: "status", 22: "notes", 25: "ticket_number",
}

_TIMESTAMP_COLUMNS = {"resolved_at", "assigned_at", "synced_at", "ticket_loaded_at",
                      "deleted_from_sheet_at"}


def _field(name):
    if name == "row_number":
        return {"name": name, "type": "INT64"}
    if name in _TIMESTAMP_COLUMNS:
        return {"name": name, "type": "TIMESTAMP"}
    return {"name": name, "type": "STRING"}


ORDERS_SCHEMA = (
    [{"name": "brand", "type": "STRING", "mode": "REQUIRED"},
     {"name": "parent_order", "type": "STRING", "mode": "REQUIRED"},
     {"name": "awb_number", "type": "STRING"},
     {"name": "awb_key", "type": "STRING", "mode": "REQUIRED"}]
    + [_field(c) for c in TICKET_COLUMNS + SHEET_COLUMNS + APP_COLUMNS + LIFECYCLE_COLUMNS]
)

# Staging holds exactly what a sheet row supplies: identity, ticket columns (legacy rows can
# carry these too, read straight off the sheet), sheet-computed columns, and the T:W cells
# (new_order_id/new_awb/status/notes) - not because the sweep's MERGE writes those on an existing
# row (it doesn't; build_sweep_merge's matched arm never names them), but because
# migrate_escalation_to_bq.py's historical-resolution backfill needs them off legacy rows that
# predate the ticket job. Listed explicitly rather than derived by subtraction, so the set is
# checkable by eye.
STAGING_SCHEMA = [
    _field(c) if c != "brand" else {"name": "brand", "type": "STRING", "mode": "REQUIRED"}
    for c in (["brand", "parent_order", "awb_number", "awb_key"] + TICKET_COLUMNS + SHEET_COLUMNS
              + ["new_order_id", "new_awb", "status", "notes", "row_number"])
]

EVENTS_SCHEMA = [
    {"name": "parent_order", "type": "STRING", "mode": "REQUIRED"},
    {"name": "brand", "type": "STRING"},
    {"name": "awb_key", "type": "STRING"},
    {"name": "email", "type": "STRING"},
    {"name": "event", "type": "STRING", "mode": "REQUIRED"},
    {"name": "resolution", "type": "STRING"},
    {"name": "agent_remarks", "type": "STRING"},
    {"name": "ts", "type": "TIMESTAMP", "mode": "REQUIRED"},
]


def awb_key(value):
    return ("" if value is None else str(value)).strip().lower()


def sheet_row_to_bq(cells, brand, row_number=None):
    """Map one sheet row (or one build_sheet_row() output) onto BigQuery columns.

    The Sheets API truncates trailing empty cells, so rows arrive short - every unmapped column
    defaults to empty string rather than raising or producing NULL.
    """
    row = {c: "" for c in
           list(SHEET_INDEX_TO_COLUMN.values()) + ["parent_order", "awb_number"]}
    for index, column in SHEET_INDEX_TO_COLUMN.items():
        if index < len(cells) and cells[index] is not None:
            row[column] = str(cells[index])
    row["brand"] = brand
    row["awb_key"] = awb_key(row.get("awb_number"))
    row["row_number"] = row_number
    return row


def count_duplicate_keys(rows):
    """How many rows the MERGE's QUALIFY will discard.

    Reported rather than silently dropped: a blank AWB makes two rows for the same parent order
    collide legitimately, but a sheet developing real key collisions is something to notice.
    """
    seen = set()
    duplicates = 0
    for r in rows:
        key = (r.get("brand"), r.get("parent_order"), r.get("awb_key"))
        if key in seen:
            duplicates += 1
        else:
            seen.add(key)
    return duplicates


def _ddl(table, schema, cluster_by=None):
    cols = ",\n".join(
        f"  {f['name']} {f['type']}" + (" NOT NULL" if f.get("mode") == "REQUIRED" else "")
        for f in schema
    )
    suffix = f"\nCLUSTER BY {cluster_by}" if cluster_by else ""
    return f"CREATE TABLE IF NOT EXISTS `{table}` (\n{cols}\n){suffix};"


def create_tables():
    """Not partitioned: a few thousand rows, where partition metadata costs more than it saves.
    Clustered on the row-key prefix so MERGEs and per-order writes prune."""
    bq_lib.query("\n".join([
        _ddl(ORDERS, ORDERS_SCHEMA, "brand, parent_order"),
        _ddl(STAGING, STAGING_SCHEMA),
        _ddl(EVENTS, EVENTS_SCHEMA, "parent_order"),
    ]))


_KEY_JOIN = ("ON  T.brand = S.brand\n"
             "AND T.parent_order = S.parent_order\n"
             "AND T.awb_key = S.awb_key")


def build_sweep_merge():
    """Sheet -> BigQuery. Matched updates sheet columns only; unmatched inserts the whole row.

    The insert arm carries ticket columns deliberately: rows predating the ticket job exist only
    in the sheet, and a sweep is the only thing that will ever bring them into BigQuery. The
    matched arm must never carry them, or a stale sheet value would overwrite fresh loader data.
    """
    matched = ",\n".join(f"  {c} = S.{c}" for c in SHEET_COLUMNS)
    insert_cols = IDENTITY_COLUMNS + TICKET_COLUMNS + SHEET_COLUMNS + ["row_number"]
    return f"""MERGE `{ORDERS}` T
USING (
  SELECT * FROM `{STAGING}`
  WHERE brand = @brand
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY brand, parent_order, awb_key ORDER BY row_number
  ) = 1
) S
{_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
{matched},
  row_number = S.row_number,
  synced_at = CURRENT_TIMESTAMP(),
  deleted_from_sheet_at = NULL
WHEN NOT MATCHED BY TARGET THEN
  INSERT ({', '.join(insert_cols)}, synced_at)
  VALUES ({', '.join('S.' + c for c in insert_cols)}, CURRENT_TIMESTAMP())
WHEN NOT MATCHED BY SOURCE
  AND T.brand = @brand
  AND T.deleted_from_sheet_at IS NULL
THEN UPDATE SET deleted_from_sheet_at = CURRENT_TIMESTAMP()"""


def build_ticket_merge():
    """MySQL -> BigQuery. Ticket columns only, so it can run before or after a sweep."""
    matched = ",\n".join(f"  {c} = S.{c}" for c in TICKET_COLUMNS)
    insert_cols = IDENTITY_COLUMNS + TICKET_COLUMNS
    return f"""MERGE `{ORDERS}` T
USING UNNEST(@items) S
{_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
{matched},
  ticket_loaded_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED BY TARGET THEN
  INSERT ({', '.join(insert_cols)}, ticket_loaded_at)
  VALUES ({', '.join('S.' + c for c in insert_cols)}, CURRENT_TIMESTAMP())"""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_escalation_ingest.py`
Expected: PASS — 18 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add scripts/escalation_bq_schema.py scripts/test_escalation_ingest.py
git commit -m "feat(bq): shared escalation schema, ownership lists and MERGE builders"
```

---

### Task 3: Ticket loader

**Files:**
- Create: `scripts/sync_delivery_tickets_to_bq.py`
- Modify: `scripts/test_escalation_ingest.py`

**Interfaces:**
- Consumes: `sync_delivery_tickets_to_sheet.{fetch_today_delivery_tickets, fill_missing_awb, build_sheet_row, TAB_TABLE}` (import only, no edits), `escalation_bq_schema`, `bq_lib`.
- Produces: `load_brand(brand, dry_run=False, since=None) -> dict` with keys `brand`, `fetched`, `new`, `merged`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_ingest.py` before the summary block:

```python
# ---------- Task 3: ticket loader ----------

import sync_delivery_tickets_to_bq as loader


@test("the loader reuses build_sheet_row's ordering rather than remapping cells")
def _():
    import sync_delivery_tickets_to_sheet as tickets
    import datetime
    db_row = ["TKT-1", "Delayed Order", "HYP1", "HYP1", "AWB1", "Delhivery",
              datetime.datetime(2026, 7, 20), datetime.datetime(2026, 8, 1),
              datetime.datetime(2026, 8, 9), "BLR"]
    cells = tickets.build_sheet_row(db_row)
    row = loader.ticket_row_to_bq(cells, "HYPHEN")
    assert row["parent_order"] == "HYP1"
    assert row["awb_number"] == "AWB1"
    assert row["awb_key"] == "awb1"
    assert row["ticket_number"] == "TKT-1"
    assert row["query_class"] == "Delivery"
    assert row["delivery_partner_name"] == "Delhivery"
    # Sheet-owned and app-owned columns are absent: the loader has no business supplying them.
    for col in schema.SHEET_COLUMNS + schema.APP_COLUMNS:
        assert col not in row, f"loader row must not carry {col}"


@test("the loader dedups against BigQuery ticket numbers, not the sheet")
def _():
    calls = []
    loader.bq_lib.query_rows = lambda sql, params=None: (
        calls.append(sql) or [{"ticket_number": "TKT-1"}]
    )
    existing = loader.existing_ticket_numbers("HYPHEN")
    assert existing == {"TKT-1"}
    assert "assignment_events" not in calls[0]
    assert "ticket_number" in calls[0]


@test("load_brand skips already-loaded tickets and merges the rest in one statement")
def _():
    import datetime
    statements = []

    loader.bq_lib.query_rows = lambda sql, params=None: [{"ticket_number": "TKT-1"}]
    loader.bq_lib.query = lambda sql, params=None: (
        statements.append((sql, params)) or {"numDmlAffectedRows": "1"}
    )
    loader.schema.create_tables = lambda: None
    loader.tickets.fetch_today_delivery_tickets = lambda table, since=None: [
        ["TKT-1", "Delayed Order", "HYP1", "HYP1", "AWB1", "Delhivery",
         datetime.datetime(2026, 7, 20), datetime.datetime(2026, 8, 1),
         datetime.datetime(2026, 8, 9), "BLR"],
        ["TKT-2", "Delayed Order", "HYP2", "HYP2", "AWB2", "Bluedart",
         datetime.datetime(2026, 7, 21), datetime.datetime(2026, 8, 2),
         datetime.datetime(2026, 8, 9), "BLR"],
    ]
    loader.tickets.fill_missing_awb = lambda rows: None

    out = loader.load_brand("HYPHEN")
    assert out["fetched"] == 2, out
    assert out["new"] == 1, "TKT-1 was already in BigQuery"
    assert len(statements) == 1, "one MERGE for the whole batch, never one per ticket"
    sql, params = statements[0]
    assert sql.startswith("MERGE")
    assert params[0]["parameterValue"]["arrayValues"][0]["structValues"]["ticket_number"]["value"] == "TKT-2"


@test("load_brand makes no BigQuery write when every ticket is already loaded")
def _():
    loader.bq_lib.query_rows = lambda sql, params=None: [{"ticket_number": "TKT-1"}]
    loader.bq_lib.query = lambda sql, params=None: (_ for _ in ()).throw(
        AssertionError("must not write when there is nothing new"))
    loader.schema.create_tables = lambda: None
    loader.tickets.fetch_today_delivery_tickets = lambda table, since=None: [
        ["TKT-1", "x", "HYP1", "HYP1", "AWB1", "D", None, None, None, "BLR"],
    ]
    loader.tickets.fill_missing_awb = lambda rows: None
    out = loader.load_brand("HYPHEN")
    assert out["new"] == 0
    assert out["merged"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_escalation_ingest.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'sync_delivery_tickets_to_bq'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/sync_delivery_tickets_to_bq.py`:

```python
"""Loads today's resolved Delivery-class tickets from PEP_CLS straight into BigQuery.

The BigQuery counterpart to sync_delivery_tickets_to_sheet.py, which is deliberately left
untouched and keeps writing the sheet. Two jobs, one destination each: a BigQuery outage cannot
break the sheet write that keeps the L:P formulas alive, and a Sheets outage cannot stop the
queue's data reaching BigQuery.

The two are unordered with respect to each other. This job owns the ticket columns; the sheet
sweep owns the formula and logistics columns. Whichever writes a row second fills in the other
half rather than fighting over it.

Query logic is imported from the sheet job rather than copied - fetch_today_delivery_tickets,
fill_missing_awb and build_sheet_row are pure MySQL reads with no sheet side effects, and that
file guards its entry point with __main__, so importing it runs nothing. One definition of
"which tickets count", two consumers.

Dedup is against escalation.orders.ticket_number, not the sheet's column Z, so neither job can
starve the other. The MERGE is idempotent on top of that, which makes a re-run - after a failure,
or with --since to backfill a missed day - always safe.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import escalation_bq_schema as schema
import sync_delivery_tickets_to_sheet as tickets

# Sheet tab name == brand == the key into the sheet job's MySQL table map. Same three things.
BRAND_TABLE = tickets.TAB_TABLE

MERGE_FIELDS = schema.IDENTITY_COLUMNS + schema.TICKET_COLUMNS


def ticket_row_to_bq(cells, brand):
    """One build_sheet_row() output -> the ticket-owned columns of escalation.orders.

    Routed through the shared sheet-index table, so this job and the sweep can never disagree
    about which cell is which. Sheet-owned and app-owned columns are dropped rather than sent as
    blanks: the MERGE would not name them anyway, and an empty string here would be a lie about
    who owns them.
    """
    row = schema.sheet_row_to_bq(cells, brand)
    return {k: row[k] for k in MERGE_FIELDS}


def existing_ticket_numbers(brand):
    rows = bq_lib.query_rows(
        f"SELECT DISTINCT ticket_number FROM `{schema.ORDERS}` "
        "WHERE brand = @brand AND ticket_number IS NOT NULL AND ticket_number != ''",
        [bq_lib.str_param("brand", brand)],
    )
    return {r["ticket_number"] for r in rows if r.get("ticket_number")}


def load_brand(brand, dry_run=False, since=None):
    table = BRAND_TABLE[brand]
    print(f"--- {brand} ({table}) ---")
    schema.create_tables()

    existing = existing_ticket_numbers(brand)
    print(f"  {len(existing)} ticket numbers already in BigQuery")

    db_rows = tickets.fetch_today_delivery_tickets(table, since=since)
    print(f"  {len(db_rows)} Delivery-class tickets resolved "
          f"{'since ' + since if since else 'today'} in DB")

    fresh = [r for r in db_rows if r[0] not in existing]
    print(f"  {len(fresh)} new tickets to load")
    if not fresh:
        return {"brand": brand, "fetched": len(db_rows), "new": 0, "merged": 0}

    tickets.fill_missing_awb(fresh)
    rows = [ticket_row_to_bq(tickets.build_sheet_row(r), brand) for r in fresh]

    duplicates = schema.count_duplicate_keys(rows)
    if duplicates:
        print(f"  note: {duplicates} row(s) share a (brand, parent_order, awb_key) key")

    if dry_run:
        for r in rows[:5]:
            print("   ", r)
        if len(rows) > 5:
            print(f"    ... and {len(rows) - 5} more")
        return {"brand": brand, "fetched": len(db_rows), "new": len(rows), "merged": 0}

    # One MERGE for the batch. Never a statement per ticket: BigQuery queues concurrent mutating
    # DML per table, and a backfill can carry thousands of rows.
    data = bq_lib.query(
        schema.build_ticket_merge(),
        [bq_lib.struct_array_param("items", MERGE_FIELDS, rows)],
    )
    merged = bq_lib.affected_rows(data)
    print(f"  merged {merged} row(s) into {schema.ORDERS}")
    return {"brand": brand, "fetched": len(db_rows), "new": len(rows), "merged": merged}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=sorted(BRAND_TABLE))
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch and print only, no BigQuery writes")
    parser.add_argument("--since",
                        help="YYYY-MM-DD: backfill tickets resolved from this date through today")
    args = parser.parse_args()
    if not args.brand:
        parser.error("--brand is required")
    load_brand(args.brand, args.dry_run, args.since)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_escalation_ingest.py`
Expected: PASS — 22 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add scripts/sync_delivery_tickets_to_bq.py scripts/test_escalation_ingest.py
git commit -m "feat(bq): load delivery tickets from MySQL into BigQuery"
```

---

### Task 4: Sheet sweep

**Files:**
- Create: `scripts/sync_escalation_sheet_to_bq.py`
- Modify: `scripts/test_escalation_ingest.py`

**Interfaces:**
- Consumes: `lib.get_sheet_values`, `escalation_bq_schema`, `bq_lib`.
- Produces: `sweep_brand(brand, dry_run=False) -> dict` with keys `brand`, `read`, `loaded`, `duplicates`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_ingest.py` before the summary block:

```python
# ---------- Task 4: sheet sweep ----------

import sync_escalation_sheet_to_bq as sweep


@test("sweep_brand rejects a brand outside the allowlist")
def _():
    for bad in ["Sheet1", "../HYPHEN", ""]:
        try:
            sweep.sweep_brand(bad)
            raise AssertionError(f"expected {bad!r} to be rejected")
        except ValueError as e:
            assert "Unknown brand" in str(e), e


@test("sweep_brand numbers rows from 2 and reports duplicate keys")
def _():
    loaded = {}
    sweep.lib.get_sheet_values = lambda sid, rng, **kw: [
        ["Aug 9", "Delivery", "Delayed", "HYP1", "AWB1"],
        ["Aug 9", "Delivery", "Delayed", "HYP1", " awb1 "],
        ["Aug 9", "Delivery", "Delayed", "HYP2", "AWB2"],
    ]
    sweep.bq_lib.load_ndjson = lambda table, ndjson, fields: (
        loaded.update({"ndjson": ndjson, "table": table}) or 3
    )
    sweep.bq_lib.query = lambda sql, params=None: {"numDmlAffectedRows": "2"}
    sweep.schema.create_tables = lambda: None

    out = sweep.sweep_brand("HYPHEN")
    assert out["read"] == 3, out
    assert out["loaded"] == 3
    assert out["duplicates"] == 1, "the two AWB1 rows collapse to one key"

    lines = [json.loads(line) for line in loaded["ndjson"].strip().split("\n")]
    assert lines[0]["row_number"] == 2, "the sheet's first data row is row 2"
    assert lines[2]["row_number"] == 4
    assert lines[1]["awb_key"] == "awb1", "awb_key is normalised before upload"
    assert loaded["table"] == schema.STAGING


@test("sweep_brand passes the brand to the MERGE, not a hardcoded tab")
def _():
    captured = {}
    sweep.lib.get_sheet_values = lambda sid, rng, **kw: [["", "", "", "MC1", "AWB9"]]
    sweep.bq_lib.load_ndjson = lambda table, ndjson, fields: 1
    sweep.bq_lib.query = lambda sql, params=None: (
        captured.update({"sql": sql, "params": params}) or {"numDmlAffectedRows": "1"}
    )
    sweep.schema.create_tables = lambda: None
    sweep.sweep_brand("mCaffeine")
    assert captured["params"] == [
        {"name": "brand", "parameterType": {"type": "STRING"},
         "parameterValue": {"value": "mCaffeine"}}
    ]
    assert captured["sql"].startswith("MERGE")


@test("sweep_brand reads the whole tab, A2:Z")
def _():
    ranges = []
    sweep.lib.get_sheet_values = lambda sid, rng, **kw: ranges.append(rng) or []
    sweep.bq_lib.load_ndjson = lambda table, ndjson, fields: 0
    sweep.bq_lib.query = lambda sql, params=None: {"numDmlAffectedRows": "0"}
    sweep.schema.create_tables = lambda: None
    sweep.sweep_brand("HYPHEN")
    assert ranges == ["'HYPHEN'!A2:Z"], ranges
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_escalation_ingest.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'sync_escalation_sheet_to_bq'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/sync_escalation_sheet_to_bq.py`:

```python
"""Sweeps the escalation sheet's computed columns into BigQuery.

Columns L:P are formulas the spreadsheet itself computes, and Q:S are pasted by an external
logistics pipeline. Neither has a source this repo can reach, so the sheet remains their only
implementation and this job is how they reach the application. Everything else about the sheet
is now downstream of BigQuery, not upstream of it.

The MERGE's three arms do different jobs, and the difference is the whole design:

  matched              -> sheet columns only, so a stale sheet value can never overwrite the
                          ticket loader's fresher data
  not matched by target-> the whole row including ticket columns, which is what backfills the
                          legacy rows predating the ticket job and repairs any row whose loader
                          MERGE failed
  not matched by source-> soft-delete stamp scoped to this brand; never a hard DELETE, which
                          would destroy agent resolutions the moment someone filters the sheet

TRIGGER: none yet. Run it by hand or via workflow_dispatch until a cadence is decided. Until
then, formula recalculations and logistics pastes do not reach the queue on their own.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import escalation_bq_schema as schema
import lib

SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"

# What actually gets uploaded to staging. The MERGE decides which of these survive onto an
# existing row; staging itself carries the full sheet row so the insert arm has everything.
STAGING_FIELDS = [f["name"] for f in schema.STAGING_SCHEMA]


def sweep_brand(brand, dry_run=False):
    if brand not in schema.BRANDS:
        raise ValueError(f"Unknown brand: {brand!r}")
    print(f"--- {brand} ---")
    schema.create_tables()

    # A2:Z - row 1 is the header. The Sheets API truncates trailing empties, so rows arrive
    # ragged; sheet_row_to_bq pads them.
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
    rows = [schema.sheet_row_to_bq(cells, brand, row_number=i + 2)
            for i, cells in enumerate(values)]
    print(f"  read {len(rows)} row(s)")

    duplicates = schema.count_duplicate_keys(rows)
    if duplicates:
        print(f"  note: {duplicates} row(s) share a (brand, parent_order, awb_key) key "
              f"and will collapse to one")

    if dry_run:
        for r in rows[:3]:
            print("   ", {k: r[k] for k in ("row_number", "parent_order", "awb_key",
                                            "status_as_per_awb", "tat")})
        if len(rows) > 3:
            print(f"    ... and {len(rows) - 3} more")
        return {"brand": brand, "read": len(rows), "loaded": 0, "duplicates": duplicates}

    # WRITE_TRUNCATE on staging, so a retried sweep never accumulates. Load job, not a streaming
    # insert - streamed rows would be un-MERGEable for up to 90 minutes.
    ndjson = "".join(
        json.dumps({k: r.get(k) for k in STAGING_FIELDS}) + "\n" for r in rows
    )
    loaded = bq_lib.load_ndjson(schema.STAGING, ndjson, schema.STAGING_SCHEMA)
    print(f"  loaded {loaded} row(s) into {schema.STAGING}")

    bq_lib.query(schema.build_sweep_merge(), [bq_lib.str_param("brand", brand)])
    print(f"  merged into {schema.ORDERS}")
    return {"brand": brand, "read": len(rows), "loaded": loaded, "duplicates": duplicates}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=sorted(schema.BRANDS),
                        help="Omit to sweep every brand")
    parser.add_argument("--dry-run", action="store_true",
                        help="Read and print only, no BigQuery writes")
    args = parser.parse_args()
    for brand in ([args.brand] if args.brand else schema.BRANDS):
        sweep_brand(brand, args.dry_run)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_escalation_ingest.py`
Expected: PASS — 26 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add scripts/sync_escalation_sheet_to_bq.py scripts/test_escalation_ingest.py
git commit -m "feat(bq): sweep the escalation sheet's formula columns into BigQuery"
```

---

### Task 5: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/sync-escalation-bq.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/sync-escalation-bq.yml`:

```yaml
# Escalation -> BigQuery ingest. Two jobs, deliberately separate from
# sync-delivery-tickets.yml, which keeps writing the sheet and is untouched.
#
# The loader runs on the same 2-hourly cadence as the sheet job - both read the same MySQL rows
# on the same definition of "today", so there is no reason for them to drift.
#
# The sweep has NO schedule yet: its cadence is still to be decided, and until then it is run by
# hand from the Actions tab. Adding one is a `schedule:` block here and nothing else.
name: Sync escalation to BigQuery

on:
  schedule:
    - cron: '0 */2 * * *'
  workflow_dispatch:
    inputs:
      job:
        description: "Which job to run"
        type: choice
        options: [loader, sweep, both]
        default: both
      since:
        description: "Loader only - backfill from YYYY-MM-DD through today"
        required: false

permissions:
  contents: read

concurrency:
  group: sync-escalation-bq
  cancel-in-progress: false

jobs:
  ingest:
    runs-on: ubuntu-latest
    env:
      GOOGLE_SA_KEY_JSON: ${{ secrets.GOOGLE_SA_KEY }}
      MYSQL_HOST: ${{ secrets.MYSQL_HOST }}
      MYSQL_USER: ${{ secrets.MYSQL_USER }}
      MYSQL_PASSWORD: ${{ secrets.MYSQL_PASSWORD }}
      MYSQL_DATABASE: ${{ secrets.MYSQL_DATABASE }}
      BQ_PROJECT_ID: ${{ secrets.BQ_PROJECT_ID }}
      BQ_DATASET: ${{ vars.BQ_DATASET || 'escalation' }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Self-check
        run: python scripts/test_escalation_ingest.py

      - name: Load tickets - HYPHEN
        if: github.event_name == 'schedule' || inputs.job != 'sweep'
        run: python scripts/sync_delivery_tickets_to_bq.py --brand HYPHEN ${{ inputs.since && format('--since {0}', inputs.since) || '' }}

      - name: Load tickets - mCaffeine
        if: github.event_name == 'schedule' || inputs.job != 'sweep'
        run: python scripts/sync_delivery_tickets_to_bq.py --brand mCaffeine ${{ inputs.since && format('--since {0}', inputs.since) || '' }}

      # No schedule yet - only runs when dispatched with job=sweep or job=both.
      - name: Sweep sheet columns
        if: github.event_name == 'workflow_dispatch' && inputs.job != 'loader'
        run: python scripts/sync_escalation_sheet_to_bq.py
```

- [ ] **Step 2: Verify the YAML parses**

Run: `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/sync-escalation-bq.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/sync-escalation-bq.yml
git commit -m "ci: escalation BigQuery ingest workflow"
```

---

### Task 6: Node BigQuery transport

**Files:**
- Create: `api/_lib/bigquery.js`
- Create: `scripts/test_escalation_bq.js`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `query(sql, params?, opts?) => Promise<{rows, affectedRows}>`
  - `strParam(name, value)`, `structArrayParam(name, fields, rows)`
  - `projectId()`, `datasetId()`
  - `_setAuthHeaderForTests(fn)`

Note: no `loadNdjson` here. Node never ingests — that is Python's job — so the transport carries only what the request path needs.

- [ ] **Step 1: Write the failing test**

Create `scripts/test_escalation_bq.js`:

```javascript
// Self-check for the Escalation BigQuery layer used by the API. No framework, no live BigQuery:
// every test stubs globalThis.fetch, so this is safe to run anywhere.
//
//   npm run test:escalation
//
// Ingest is not tested here - it lives in Python, checked by scripts/test_escalation_ingest.py.
'use strict';
const assert = require('assert');

process.env.BQ_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'escalation';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

function stubFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body };
  };
  return calls;
}

const bq = require('../api/_lib/bigquery');
bq._setAuthHeaderForTests(async () => ({ Authorization: 'Bearer test-token' }));

/* ---------- Task 6: transport ---------- */

test('strParam encodes a named STRING parameter', () => {
  assert.deepStrictEqual(bq.strParam('brand', 'HYPHEN'), {
    name: 'brand',
    parameterType: { type: 'STRING' },
    parameterValue: { value: 'HYPHEN' },
  });
});

test('strParam passes null through instead of stringifying it', () => {
  assert.strictEqual(bq.strParam('notes', null).parameterValue.value, null);
});

test('structArrayParam encodes an array of all-STRING structs', () => {
  const p = bq.structArrayParam('items', ['parent_order', 'status'], [
    { parent_order: 'HYP1', status: 'Delivered' },
  ]);
  assert.strictEqual(p.parameterType.arrayType.type, 'STRUCT');
  assert.deepStrictEqual(p.parameterType.arrayType.structTypes, [
    { name: 'parent_order', type: { type: 'STRING' } },
    { name: 'status', type: { type: 'STRING' } },
  ]);
  assert.strictEqual(p.parameterValue.arrayValues[0].structValues.parent_order.value, 'HYP1');
});

testAsync('query posts NAMED parameters and maps the row shape', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'parent_order' }, { name: 'status' }] },
    rows: [{ f: [{ v: 'HYP1' }, { v: 'Delivered' }] }],
  } }]);
  const out = await bq.query('SELECT 1', [bq.strParam('brand', 'HYPHEN')]);
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.useLegacySql, false);
  assert.strictEqual(sent.parameterMode, 'NAMED');
  assert.deepStrictEqual(out.rows, [{ parent_order: 'HYP1', status: 'Delivered' }]);
});

testAsync('query reports DML affected rows', async () => {
  stubFetch([{ body: { jobComplete: true, numDmlAffectedRows: '7' } }]);
  const out = await bq.query('UPDATE x SET y = 1');
  assert.strictEqual(out.affectedRows, 7);
  assert.deepStrictEqual(out.rows, []);
});

testAsync('query surfaces the BigQuery error message, not a bare status code', async () => {
  stubFetch([{ ok: false, status: 400, body: { error: { message: 'Syntax error near MERGE' } } }]);
  await assert.rejects(bq.query('MERGE bad'), /Syntax error near MERGE/);
});

test('the transport exposes no ingest surface', () => {
  assert.strictEqual(bq.loadNdjson, undefined, 'ingest belongs to Python, not the request path');
});

/* ---------- summary ---------- */
process.on('exit', () => {
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES ABOVE' : ''}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_escalation_bq.js`
Expected: FAIL — `Cannot find module '../api/_lib/bigquery'`

- [ ] **Step 3: Write minimal implementation**

Create `api/_lib/bigquery.js`:

```javascript
// BigQuery transport for the request path. Reads and writes only - all ingest is Python
// (scripts/bq_lib.py), so there is deliberately no load-job support here.
//
// Not @google-cloud/bigquery: that client pulls in a large dependency tree, and this Lambda
// bundle already runs close to the 6MB payload ceiling. The pattern here matches api/rto/sheet.js
// and api/ndr/sheet.js - a google-auth-library JWT plus plain fetch.
//
// The tables are created by scripts/escalation_bq_schema.py and nowhere else. Nothing in this
// module issues DDL, so the two languages cannot drift on table definitions.
const { JWT } = require('google-auth-library');

const API = 'https://bigquery.googleapis.com/bigquery/v2';

function projectId() {
  const id = process.env.BQ_PROJECT_ID;
  if (!id) throw new Error('Missing BQ_PROJECT_ID env var');
  return id;
}
function datasetId() {
  return process.env.BQ_DATASET || 'escalation';
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  // Same service account the Sheets access uses, with the bigquery scope added. It needs the
  // BigQuery Data Editor and BigQuery Job User roles on BQ_PROJECT_ID.
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/bigquery'] });
  return _client;
}

let _authHeader = async () => {
  const { token } = await getClient().getAccessToken();
  return { Authorization: `Bearer ${token}` };
};
// Test seam: the self-check stubs fetch, but minting a real JWT would still need a real key.
function _setAuthHeaderForTests(fn) { _authHeader = fn; }

// Only STRING scalars and arrays of all-STRING structs - all this desk needs.
function strParam(name, value) {
  return {
    name,
    parameterType: { type: 'STRING' },
    parameterValue: { value: value == null ? null : String(value) },
  };
}

function structArrayParam(name, fields, rows) {
  return {
    name,
    parameterType: {
      type: 'ARRAY',
      arrayType: { type: 'STRUCT', structTypes: fields.map((f) => ({ name: f, type: { type: 'STRING' } })) },
    },
    parameterValue: {
      arrayValues: rows.map((r) => ({
        structValues: Object.fromEntries(
          fields.map((f) => [f, { value: r[f] == null ? null : String(r[f]) }])
        ),
      })),
    },
  };
}

// BigQuery returns rows positionally against a separate schema; callers want plain objects.
function rowsOf(data) {
  const fields = (data.schema && data.schema.fields) || [];
  return (data.rows || []).map((row) => {
    const obj = {};
    fields.forEach((field, i) => { obj[field.name] = row.f[i] ? row.f[i].v : null; });
    return obj;
  });
}

async function query(sql, params = [], { useQueryCache = true } = {}) {
  const res = await fetch(`${API}/projects/${projectId()}/queries`, {
    method: 'POST',
    headers: { ...(await _authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      useQueryCache,
      parameterMode: 'NAMED',
      queryParameters: params,
      timeoutMs: 60000,
      defaultDataset: { projectId: projectId(), datasetId: datasetId() },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `BigQuery query failed (${res.status})`);
  if (data.errors && data.errors.length) throw new Error(data.errors[0].message);
  return { rows: rowsOf(data), affectedRows: Number(data.numDmlAffectedRows || 0) };
}

module.exports = { query, strParam, structArrayParam, projectId, datasetId, _setAuthHeaderForTests };
```

- [ ] **Step 4: Add the test script to package.json**

In `package.json`, add to `"scripts"`:

```json
"test:escalation": "node scripts/test_escalation_bq.js"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 7 passed

- [ ] **Step 6: Commit**

```bash
git add api/_lib/bigquery.js scripts/test_escalation_bq.js package.json
git commit -m "feat(bq): BigQuery transport for the escalation request path"
```

---

### Task 7: Application read path

**Files:**
- Create: `api/_lib/escalationBq.js`
- Modify: `scripts/test_escalation_bq.js`

**Interfaces:**
- Produces:
  - `buildQueueQuery(view: 'queue'|'freshLeads') => string`
  - `getEligibleOrders()`, `getFreshLeads()` — arrays of order objects
  - `getLiveEscalationAssignments()`, `getEscalationAssignments()`
  - `getOrderIndex() => Promise<{byParent: Map, byParentAwb: Map}>`
  - `awbKeyOf(value) => string`

Order objects keep the camelCase keys the client already renders, including `sheetTab` — mapped from the `brand` column so `rowKey()` in the client is untouched.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 7: reads ---------- */

const ebq = require('../api/_lib/escalationBq');

test('the queue predicate matches the old JS filter, including the forced-RTO TAT case', () => {
  const sql = ebq.buildQueueQuery('queue');
  assert.match(sql, /LOWER\(status_as_per_awb\)\s+LIKE\s+'%rto%'/);
  assert.match(sql, /LOWER\(update_from_logistics\)\s+LIKE\s+'%rto%'/);
  assert.match(sql, /COALESCE\(status,\s*''\)\s*=\s*''/);
  assert.match(sql, /deleted_from_sheet_at IS NULL/);
  // Deliberately NOT filtered on tat: every pending RTO row carries "Forced to be marked as
  // RTO" there, so gating the queue on the open-TAT values empties it.
  assert.ok(!/\btat\b/.test(sql.slice(sql.indexOf('WHERE'))), 'queue must not filter on tat');
});

test('the fresh-leads predicate filters on tat alone', () => {
  const sql = ebq.buildQueueQuery('freshLeads');
  assert.match(sql, /LOWER\(TRIM\(COALESCE\(tat,\s*''\)\)\)\s+IN\s+\('',\s*'unresolved',\s*'#n\/a'\)/);
  const where = sql.slice(sql.indexOf('WHERE'));
  assert.ok(!/status_as_per_awb/.test(where), 'fresh leads ignore the RTO columns');
  assert.ok(!/COALESCE\(status,/.test(where), 'fresh leads ignore resolution status');
});

testAsync('order objects expose brand as sheetTab so the client is unchanged', async () => {
  stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [
      { name: 'brand' }, { name: 'parent_order' }, { name: 'awb_number' },
      { name: 'status_as_per_awb' }, { name: 'query_category' }, { name: 'row_number' },
      { name: 'ticket_number' },
    ] },
    rows: [{ f: [
      { v: 'HYPHEN' }, { v: 'HYP32557370' }, { v: 'AWB1' }, { v: 'RTO' },
      { v: 'Delayed Order' }, { v: '2' }, { v: 'TKT-9' },
    ] }],
  } }]);
  const [order] = await ebq.getEligibleOrders();
  assert.strictEqual(order.sheetTab, 'HYPHEN', 'brand is surfaced under the key rowKey() uses');
  assert.strictEqual(order.parentOrder, 'HYP32557370');
  assert.strictEqual(order.awbNumber, 'AWB1');
  assert.strictEqual(order.statusAsPerAwb, 'RTO');
  assert.strictEqual(order.rowNumber, 2, 'row_number comes back as a number');
  assert.strictEqual(order.ticketNumber, 'TKT-9');
});

testAsync('getLiveEscalationAssignments reads orders, not the event log', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'parent_order' }, { name: 'assigned_to' }] },
    rows: [{ f: [{ v: 'HYP1' }, { v: 'a@x.com' }] }],
  } }]);
  const live = await ebq.getLiveEscalationAssignments();
  assert.deepStrictEqual(live, [{ parentOrder: 'HYP1', email: 'a@x.com' }]);
  const sql = JSON.parse(calls[0].init.body).query;
  assert.ok(!/assignment_events/.test(sql), 'the live map must not scan the event log');
  assert.match(sql, /assigned_to IS NOT NULL/);
  assert.match(sql, /resolved_at IS NULL/);
});

testAsync('getEscalationAssignments pivots events into assignment cycles', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [
      { name: 'parent_order' }, { name: 'email' }, { name: 'assigned_at' },
      { name: 'reassigned_away_at' }, { name: 'resolved_at' }, { name: 'resolution' },
      { name: 'agent_remarks' },
    ] },
    rows: [{ f: [
      { v: 'HYP1' }, { v: 'a@x.com' }, { v: '2026-08-09T05:00:00Z' },
      { v: null }, { v: '2026-08-09T06:00:00Z' }, { v: 'Delivered' }, { v: 'ok' },
    ] }],
  } }]);
  const [row] = await ebq.getEscalationAssignments();
  assert.deepStrictEqual(row, {
    parentOrder: 'HYP1', email: 'a@x.com', assignedAt: '2026-08-09T05:00:00Z',
    reassignedAwayAt: null, resolvedAt: '2026-08-09T06:00:00Z',
    resolution: 'Delivered', agentRemarks: 'ok',
  });
  assert.match(JSON.parse(calls[0].init.body).query, /LIMIT 5000/);
});

testAsync('getOrderIndex builds the parent and parent+awb maps the CSV import needs', async () => {
  stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'brand' }, { name: 'parent_order' }, { name: 'awb_number' }, { name: 'awb_key' }] },
    rows: [
      { f: [{ v: 'HYPHEN' }, { v: 'HYP1' }, { v: 'AWB1' }, { v: 'awb1' }] },
      { f: [{ v: 'HYPHEN' }, { v: 'HYP1' }, { v: 'AWB9' }, { v: 'awb9' }] },
    ],
  } }]);
  const { byParent, byParentAwb } = await ebq.getOrderIndex();
  assert.deepStrictEqual(byParent.get('hyp1'),
    { sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' });
  assert.strictEqual(byParentAwb.get('hyp1||awb9').awbNumber, 'AWB9',
    'the exact key still resolves the second row');
});

test('the data layer creates no tables', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../api/_lib/escalationBq.js'), 'utf8');
  assert.ok(!/CREATE TABLE/i.test(src), 'DDL belongs to scripts/escalation_bq_schema.py only');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — `Cannot find module '../api/_lib/escalationBq'`

- [ ] **Step 3: Write minimal implementation**

Create `api/_lib/escalationBq.js`:

```javascript
// The Escalation desk's data layer, on BigQuery. Replaces api/_lib/escalationSheet.js and the
// escalation_* functions in api/_lib/db.js.
//
// READS AND WRITES ONLY. Ingest is Python (scripts/sync_delivery_tickets_to_bq.py and
// scripts/sync_escalation_sheet_to_bq.py) and the tables are created by
// scripts/escalation_bq_schema.py. Nothing here issues DDL or loads data, so the two languages
// cannot drift on table definitions.
//
// APP-OWNED COLUMNS ONLY on the write side. The ticket loader owns the ticket columns and the
// sheet sweep owns the formula/logistics columns; naming either from here would silently destroy
// another writer's data on its next run.
//
// KEYED ON (brand, parent_order, awb_key), NOT row_number. The old sheet write path targeted
// `{tab}!T{rowNumber}:W{rowNumber}`, correct only while nobody sorted the sheet.
const bq = require('./bigquery');

const ORDERS = 'orders';
const EVENTS = 'assignment_events';

// BigQuery column -> the camelCase key the client renders. `brand` deliberately surfaces as
// `sheetTab`: app/escalation/EscalationClient.js builds every row key from it, and renaming the
// column in BigQuery is not a reason to churn the client.
const COLUMN_TO_ORDER_KEY = {
  brand: 'sheetTab', row_number: 'rowNumber', parent_order: 'parentOrder',
  awb_number: 'awbNumber', added_date: 'addedDate', query_class: 'queryClass',
  query_category: 'queryCategory', delivery_partner_name: 'deliveryPartnerName',
  order_date: 'orderDate', order_month: 'orderMonth', query_date: 'queryDate',
  query_month: 'queryMonth', wh_name: 'whName',
  total_times_consumer_reached: 'totalTimesConsumerReached',
  delivered_date: 'deliveredDate', status_as_per_awb: 'statusAsPerAwb',
  solv_date: 'solvDate', tat: 'tat', update_from_logistics: 'updateFromLogistics',
  city: 'city', state: 'state', ticket_number: 'ticketNumber',
  new_order_id: 'newOrderId', new_awb: 'awb', status: 'status', notes: 'notes',
};

const ORDER_SELECT_COLUMNS = Object.keys(COLUMN_TO_ORDER_KEY);

function bqRowToOrder(r) {
  const out = {};
  Object.entries(COLUMN_TO_ORDER_KEY).forEach(([column, key]) => {
    out[key] = r[column] == null ? '' : r[column];
  });
  out.rowNumber = r.row_number == null ? null : Number(r.row_number);
  return out;
}

function awbKeyOf(awbNumber) {
  return String(awbNumber == null ? '' : awbNumber).trim().toLowerCase();
}

// The queue: RTO per BOTH the courier (status_as_per_awb) and logistics
// (update_from_logistics), and not yet actioned. Deliberately NOT filtered on tat - every
// currently-pending RTO row carries "Forced to be marked as RTO" there, so gating on the
// open-TAT values empties the queue. That rule belongs to fresh leads below, which has no RTO
// requirement at all.
const QUEUE_WHERE = `LOWER(status_as_per_awb) LIKE '%rto%'
    AND LOWER(update_from_logistics) LIKE '%rto%'
    AND COALESCE(status, '') = ''
    AND deleted_from_sheet_at IS NULL`;

// Fresh leads: tat hasn't landed in a computed bucket yet. Irrespective of status or the RTO
// columns - an already-actioned row still counts if its tat is still open.
const FRESH_LEADS_WHERE = `LOWER(TRIM(COALESCE(tat, ''))) IN ('', 'unresolved', '#n/a')
    AND deleted_from_sheet_at IS NULL`;

function buildQueueQuery(view) {
  return `SELECT ${ORDER_SELECT_COLUMNS.join(', ')}
  FROM \`${ORDERS}\`
  WHERE ${view === 'freshLeads' ? FRESH_LEADS_WHERE : QUEUE_WHERE}`;
}

async function getEligibleOrders() {
  const { rows } = await bq.query(buildQueueQuery('queue'));
  return rows.map(bqRowToOrder);
}

async function getFreshLeads() {
  const { rows } = await bq.query(buildQueueQuery('freshLeads'));
  return rows.map(bqRowToOrder);
}

// Cheap: reads the orders table's own assignment columns rather than scanning the event log.
async function getLiveEscalationAssignments() {
  const { rows } = await bq.query(`SELECT parent_order, assigned_to
  FROM \`${ORDERS}\`
  WHERE assigned_to IS NOT NULL AND resolved_at IS NULL`);
  return rows.map((r) => ({ parentOrder: r.parent_order, email: r.assigned_to }));
}

// Rebuilds the Postgres table's cycle shape from the event log: one row per assignment cycle,
// carrying the timestamps of the events that closed it. No date filtering on purpose - "assigned
// this week" and "resolved this week" are different questions about different timestamps, and a
// single WHERE would miscount whichever metric doesn't share it. AssignmentsPanel scopes each
// metric client-side. LIMIT is the same soft ceiling the Postgres version carried.
async function getEscalationAssignments() {
  const { rows } = await bq.query(`WITH cycles AS (
    SELECT parent_order, email, ts AS assigned_at,
           LEAD(ts) OVER (PARTITION BY parent_order ORDER BY ts) AS next_ts
    FROM \`${EVENTS}\`
    WHERE event = 'assigned'
  ),
  closes AS (
    SELECT c.parent_order, c.email, c.assigned_at,
      MIN(IF(e.event IN ('reassigned_away', 'unassigned'), e.ts, NULL)) AS reassigned_away_at,
      MIN(IF(e.event = 'resolved', e.ts, NULL)) AS resolved_at,
      ANY_VALUE(IF(e.event = 'resolved', e.resolution, NULL)) AS resolution,
      ANY_VALUE(IF(e.event = 'resolved', e.agent_remarks, NULL)) AS agent_remarks
    FROM cycles c
    LEFT JOIN \`${EVENTS}\` e
      ON e.parent_order = c.parent_order
     AND e.ts > c.assigned_at
     AND (c.next_ts IS NULL OR e.ts < c.next_ts)
    GROUP BY c.parent_order, c.email, c.assigned_at
  )
  SELECT * FROM closes ORDER BY assigned_at DESC LIMIT 5000`);
  return rows.map((r) => ({
    parentOrder: r.parent_order,
    email: r.email,
    assignedAt: r.assigned_at,
    reassignedAwayAt: r.reassigned_away_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    agentRemarks: r.agent_remarks,
  }));
}

// Replaces escalationSheet.getSheetIndex - same two maps and the same "prefer an exact
// parent+AWB match, fall back to parent only" contract the CSV import depends on, but read from
// BigQuery instead of re-reading both sheet tabs. Values carry the write key, not a row number.
async function getOrderIndex() {
  const { rows } = await bq.query(
    `SELECT brand, parent_order, awb_number, awb_key
     FROM \`${ORDERS}\` WHERE deleted_from_sheet_at IS NULL`
  );
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((r) => {
    const parent = String(r.parent_order || '').trim().toLowerCase();
    if (!parent) return;
    const key = { sheetTab: r.brand, parentOrder: r.parent_order, awbNumber: r.awb_number || '' };
    if (!byParent.has(parent)) byParent.set(parent, key);
    if (r.awb_key) byParentAwb.set(`${parent}||${r.awb_key}`, key);
  });
  return { byParent, byParentAwb };
}

module.exports = {
  ORDERS, EVENTS, awbKeyOf, buildQueueQuery,
  getEligibleOrders, getFreshLeads,
  getLiveEscalationAssignments, getEscalationAssignments, getOrderIndex,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 14 passed

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js scripts/test_escalation_bq.js
git commit -m "feat(bq): escalation read path on BigQuery"
```

---

### Task 8: Application write path

**Files:**
- Modify: `api/_lib/escalationBq.js`
- Modify: `scripts/test_escalation_bq.js`

**Interfaces:**
- Produces:
  - `updateOrder(key, {newOrderId, newAwb, newStatus, notes, resolvedBy}) => Promise<number>`
  - `batchUpdateOrders(items) => Promise<number>`
  - `assignEscalationOrder(key, email)`, `unassignEscalationOrder(key)`
  - `assignEscalationOrdersBulk(items) => Promise<number>`
  - `buildBulkUpdateMerge()`, `buildBulkAssignMerge()`

`key` is `{sheetTab, parentOrder, awbNumber}` throughout; `sheetTab` is written to the `brand` column and `awbKey` is derived internally.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 8: writes ---------- */

// The column groups the app must never write. Kept in sync with
// scripts/escalation_bq_schema.py's TICKET_COLUMNS and SHEET_COLUMNS by these tests failing loudly
// if a write statement ever names one.
const TICKET_COLUMNS = [
  'added_date', 'query_class', 'query_category', 'delivery_partner_name', 'order_date',
  'order_month', 'query_date', 'query_month', 'wh_name', 'ticket_number',
];
const SHEET_OWNED_COLUMNS = [
  'total_times_consumer_reached', 'delivered_date', 'status_as_per_awb', 'solv_date',
  'tat', 'update_from_logistics', 'city', 'state',
];

test('write statements never name a column owned by an ingest path', () => {
  const statements = [ebq.buildBulkUpdateMerge(), ebq.buildBulkAssignMerge()];
  statements.forEach((sql) => {
    [...TICKET_COLUMNS, ...SHEET_OWNED_COLUMNS].forEach((c) => {
      assert.ok(!new RegExp(`\\b${c}\\b`).test(sql),
        `write statement must not touch ingest-owned "${c}"`);
    });
  });
});

testAsync('updateOrder issues one UPDATE on the row key, plus one event', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
  ]);
  const affected = await ebq.updateOrder(
    { sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: ' AWB1 ' },
    { newOrderId: 'HYP2', newAwb: 'AWB9', newStatus: 'Reshipped', notes: 'done', resolvedBy: 'a@x.com' }
  );
  assert.strictEqual(affected, 1);
  const update = JSON.parse(calls[0].init.body);
  assert.match(update.query, /^UPDATE/);
  assert.match(update.query, /brand\s*=\s*@brand/);
  assert.match(update.query, /awb_key\s*=\s*@awb_key/);
  assert.strictEqual(update.queryParameters.find((p) => p.name === 'brand').parameterValue.value, 'HYPHEN');
  assert.strictEqual(update.queryParameters.find((p) => p.name === 'awb_key').parameterValue.value, 'awb1');
  const event = JSON.parse(calls[1].init.body);
  assert.match(event.query, /INSERT INTO `assignment_events`/);
  assert.strictEqual(event.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'resolved');
});

testAsync('batchUpdateOrders compiles N items into ONE statement', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '3' } },
    { body: { jobComplete: true, numDmlAffectedRows: '3' } },
  ]);
  const items = ['HYP1', 'HYP2', 'HYP3'].map((p) => ({
    sheetTab: 'HYPHEN', parentOrder: p, awbNumber: `awb-${p}`,
    newOrderId: '-', newAwb: '-', newStatus: 'Delivered', notes: '', resolvedBy: 'a@x.com',
  }));
  assert.strictEqual(await ebq.batchUpdateOrders(items), 3);
  assert.strictEqual(calls.length, 2, 'one MERGE and one event insert, never one per item');
  assert.match(JSON.parse(calls[0].init.body).query, /UNNEST\(@items\)/);
});

testAsync('batchUpdateOrders with an empty list makes no BigQuery calls', async () => {
  const calls = stubFetch([]);
  assert.strictEqual(await ebq.batchUpdateOrders([]), 0);
  assert.strictEqual(calls.length, 0);
});

testAsync('assignEscalationOrdersBulk compiles 4048 assignments into ONE statement', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '4048' } },
    { body: { jobComplete: true, numDmlAffectedRows: '4048' } },
  ]);
  const items = Array.from({ length: 4048 }, (_, i) => ({
    sheetTab: 'HYPHEN', parentOrder: `HYP${i}`, awbNumber: `AWB${i}`, agentId: 'a@x.com',
  }));
  assert.strictEqual(await ebq.assignEscalationOrdersBulk(items), 4048);
  assert.strictEqual(calls.length, 2, '4048 rows must not become 4048 DML statements');
});

testAsync('reassignment closes the previous cycle before opening the new one', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, schema: { fields: [{ name: 'assigned_to' }] }, rows: [{ f: [{ v: 'old@x.com' }] }] } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
  ]);
  await ebq.assignEscalationOrder({ sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' }, 'new@x.com');
  const away = JSON.parse(calls[1].init.body);
  assert.strictEqual(away.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'reassigned_away');
  assert.strictEqual(away.queryParameters.find((p) => p.name === 'email').parameterValue.value, 'old@x.com');
  const assigned = JSON.parse(calls[3].init.body);
  assert.strictEqual(assigned.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'assigned');
});

testAsync('re-assigning to the same agent writes no reassigned_away event', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, schema: { fields: [{ name: 'assigned_to' }] }, rows: [{ f: [{ v: 'same@x.com' }] }] } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
  ]);
  await ebq.assignEscalationOrder({ sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' }, 'same@x.com');
  const inserts = calls
    .map((c) => JSON.parse(c.init.body).query)
    .filter((q) => /INSERT INTO/.test(q));
  assert.strictEqual(inserts.length, 1, 'only the assigned event');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — `ebq.buildBulkUpdateMerge is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `api/_lib/escalationBq.js` above `module.exports`:

```javascript
function keyParams({ sheetTab, parentOrder, awbNumber }) {
  return [
    bq.strParam('brand', sheetTab),
    bq.strParam('parent_order', parentOrder),
    bq.strParam('awb_key', awbKeyOf(awbNumber)),
  ];
}

const KEY_WHERE = 'brand = @brand AND parent_order = @parent_order AND awb_key = @awb_key';

// One row per agent action. Append-only: this is the history AssignmentsPanel reads, and the
// reason a current-state-only orders table isn't enough on its own.
async function insertEvent(key, event, { email = null, resolution = null, agentRemarks = null } = {}) {
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
     VALUES (@parent_order, @brand, @awb_key, @email, @event, @resolution, @agent_remarks, CURRENT_TIMESTAMP())`,
    [
      ...keyParams(key),
      bq.strParam('email', email),
      bq.strParam('event', event),
      bq.strParam('resolution', resolution),
      bq.strParam('agent_remarks', agentRemarks),
    ],
    { useQueryCache: false }
  );
}

const KEY_FIELDS = ['brand', 'parent_order', 'awb_key'];
const BULK_UPDATE_FIELDS = [...KEY_FIELDS, 'new_order_id', 'new_awb', 'status', 'notes', 'resolved_by'];
const BULK_ASSIGN_FIELDS = [...KEY_FIELDS, 'assigned_to'];

const BULK_KEY_JOIN = 'ON  T.brand = S.brand AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key';

function buildBulkUpdateMerge() {
  return `MERGE \`${ORDERS}\` T
USING UNNEST(@items) S
${BULK_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
  new_order_id = S.new_order_id,
  new_awb = S.new_awb,
  status = S.status,
  notes = S.notes,
  resolved_at = CURRENT_TIMESTAMP(),
  resolved_by = S.resolved_by`;
}

function buildBulkAssignMerge() {
  return `MERGE \`${ORDERS}\` T
USING UNNEST(@items) S
${BULK_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
  assigned_to = S.assigned_to,
  assigned_at = CURRENT_TIMESTAMP()`;
}

function bulkKeyOf(i) {
  return { brand: i.sheetTab, parent_order: i.parentOrder, awb_key: awbKeyOf(i.awbNumber) };
}

async function updateOrder(key, { newOrderId, newAwb, newStatus, notes = '', resolvedBy = null }) {
  const { affectedRows } = await bq.query(
    `UPDATE \`${ORDERS}\` SET
       new_order_id = @new_order_id,
       new_awb = @new_awb,
       status = @status,
       notes = @notes,
       resolved_at = CURRENT_TIMESTAMP(),
       resolved_by = @resolved_by
     WHERE ${KEY_WHERE}`,
    [
      ...keyParams(key),
      bq.strParam('new_order_id', newOrderId == null ? '-' : newOrderId),
      bq.strParam('new_awb', newAwb == null ? '-' : newAwb),
      bq.strParam('status', newStatus),
      bq.strParam('notes', notes),
      bq.strParam('resolved_by', resolvedBy),
    ],
    { useQueryCache: false }
  );
  await insertEvent(key, 'resolved', { email: resolvedBy, resolution: newStatus, agentRemarks: notes });
  return affectedRows;
}

// One MERGE, never a loop: bulk-update and CSV import can carry thousands of rows, and thousands
// of individual UPDATE statements would exhaust BigQuery's DML queue.
async function batchUpdateOrders(items) {
  if (!items.length) return 0;
  const rows = items.map((i) => ({
    ...bulkKeyOf(i),
    new_order_id: i.newOrderId == null ? '-' : i.newOrderId,
    new_awb: i.newAwb == null ? '-' : i.newAwb,
    status: i.newStatus,
    notes: i.notes == null ? '' : i.notes,
    resolved_by: i.resolvedBy == null ? '' : i.resolvedBy,
  }));
  const { affectedRows } = await bq.query(
    buildBulkUpdateMerge(),
    [bq.structArrayParam('items', BULK_UPDATE_FIELDS, rows)],
    { useQueryCache: false }
  );
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
     SELECT parent_order, brand, awb_key, resolved_by, 'resolved', status, notes, CURRENT_TIMESTAMP()
     FROM UNNEST(@items)`,
    [bq.structArrayParam('items', BULK_UPDATE_FIELDS, rows)],
    { useQueryCache: false }
  );
  return affectedRows;
}

async function currentAssignee(key) {
  const { rows } = await bq.query(
    `SELECT assigned_to FROM \`${ORDERS}\` WHERE ${KEY_WHERE} AND resolved_at IS NULL`,
    keyParams(key),
    { useQueryCache: false }
  );
  return rows.length ? rows[0].assigned_to : null;
}

// Mirrors the Postgres cycle model: a different agent's live assignment is closed with a
// reassigned_away event before the new one opens, so history is preserved rather than
// overwritten. Re-assigning to the SAME agent closes nothing.
async function assignEscalationOrder(key, email) {
  const previous = await currentAssignee(key);
  if (previous && previous !== email) await insertEvent(key, 'reassigned_away', { email: previous });
  await bq.query(
    `UPDATE \`${ORDERS}\` SET assigned_to = @assigned_to, assigned_at = CURRENT_TIMESTAMP()
     WHERE ${KEY_WHERE}`,
    [...keyParams(key), bq.strParam('assigned_to', email)],
    { useQueryCache: false }
  );
  await insertEvent(key, 'assigned', { email });
}

async function unassignEscalationOrder(key) {
  const previous = await currentAssignee(key);
  await bq.query(
    `UPDATE \`${ORDERS}\` SET assigned_to = NULL, assigned_at = NULL
     WHERE ${KEY_WHERE} AND resolved_at IS NULL`,
    keyParams(key),
    { useQueryCache: false }
  );
  await insertEvent(key, 'unassigned', { email: previous });
}

// Auto-Assign All's write path. The client used to fire one request per unassigned order; against
// BigQuery that is thousands of concurrent DML statements and a guaranteed failure.
async function assignEscalationOrdersBulk(items) {
  if (!items.length) return 0;
  const rows = items.map((i) => ({ ...bulkKeyOf(i), assigned_to: i.agentId }));
  const { affectedRows } = await bq.query(
    buildBulkAssignMerge(),
    [bq.structArrayParam('items', BULK_ASSIGN_FIELDS, rows)],
    { useQueryCache: false }
  );
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
     SELECT parent_order, brand, awb_key, assigned_to, 'assigned', NULL, NULL, CURRENT_TIMESTAMP()
     FROM UNNEST(@items)`,
    [bq.structArrayParam('items', BULK_ASSIGN_FIELDS, rows)],
    { useQueryCache: false }
  );
  return affectedRows;
}
```

Add `updateOrder`, `batchUpdateOrders`, `assignEscalationOrder`, `unassignEscalationOrder`, `assignEscalationOrdersBulk`, `buildBulkUpdateMerge`, `buildBulkAssignMerge` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 21 passed

- [ ] **Step 5: Commit**

```bash
git add api/_lib/escalationBq.js scripts/test_escalation_bq.js
git commit -m "feat(bq): escalation write path, every bulk action a single MERGE"
```

---

### Task 9: Wire the API handler

**Files:**
- Modify: `api/escalation/[action].js`
- Delete: `api/_lib/escalationSheet.js`
- Modify: `api/_lib/db.js`
- Modify: `scripts/test_escalation_bq.js`

- [ ] **Step 1: Write the failing test**

Append to `scripts/test_escalation_bq.js` before the summary block:

```javascript
/* ---------- Task 9: handler wiring ---------- */

const fs = require('fs');
const path = require('path');
const repo = (p) => path.join(__dirname, '..', p);
const handlerSrc = fs.readFileSync(repo('api/escalation/[action].js'), 'utf8');
const dbSrc = fs.readFileSync(repo('api/_lib/db.js'), 'utf8');

test('api/_lib/escalationSheet.js is gone', () => {
  assert.ok(!fs.existsSync(repo('api/_lib/escalationSheet.js')),
    'the API no longer touches the sheet at all');
});

test('nothing under api/ imports escalationSheet or calls the Sheets API', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
  walk(repo('api')).forEach((file) => {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/escalationSheet/.test(src), `${file} still references escalationSheet`);
  });
});

test('the handler imports the BigQuery data layer', () => {
  assert.match(handlerSrc, /require\('\.\.\/_lib\/escalationBq'\)/);
});

test('the handler has no sync route and no shared secret', () => {
  assert.ok(!/ESCALATION_SYNC_SECRET/.test(handlerSrc), 'ingest is Python; no secret is needed');
  assert.ok(!/action === 'sync'/.test(handlerSrc), 'the API does not ingest');
});

test('assign-bulk exists and sits behind the session gate', () => {
  assert.match(handlerSrc, /action === 'assign-bulk'/);
  assert.ok(
    handlerSrc.indexOf("action === 'assign-bulk'") > handlerSrc.indexOf('const denied = checkAccess(session)'),
    'assign-bulk must be session-gated'
  );
});

test('db.js drops the escalation functions and exports pgSql', () => {
  const exportBlock = dbSrc.slice(dbSrc.lastIndexOf('module.exports'));
  [
    'assignEscalationOrder', 'unassignEscalationOrder', 'resolveEscalationAssignment',
    'resolveEscalationAssignmentsBulk', 'getEscalationAssignments', 'getLiveEscalationAssignments',
  ].forEach((fn) => assert.ok(!new RegExp(`\\b${fn}\\b`).test(exportBlock),
    `${fn} must be removed from exports`));
  assert.match(exportBlock, /\bpgSql\b/, 'the migration script needs pgSql exported');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:escalation`
Expected: FAIL — 6 failures in the Task 9 section

- [ ] **Step 3: Rewrite the handler's imports**

In `api/escalation/[action].js`, replace the import block (lines 15–24) with:

```javascript
const { getSession } = require('../_lib/session');
const {
  getEligibleOrders, getFreshLeads, updateOrder, batchUpdateOrders, getOrderIndex,
  assignEscalationOrder, unassignEscalationOrder, assignEscalationOrdersBulk,
  getEscalationAssignments, getLiveEscalationAssignments,
} = require('../_lib/escalationBq');
const { CSV_HEADERS, parseCSV, toCSV } = require('../_lib/escalationCsv');
const { getCallingProcessAgents } = require('../_lib/db');
```

Also update the file's header comment: the action list becomes
`agents | orders | assign | assign-bulk | assignments | update | bulk-update | import | export | sample`,
and the note about writing to the sheet becomes a note that all reads and writes go to BigQuery
while ingest lives in `scripts/`.

- [ ] **Step 4: Point the actions at BigQuery**

`assign` POST branch:

```javascript
      if (req.method === 'POST') {
        const { sheetTab, parentOrder, awbNumber, agentId } = body;
        if (!sheetTab || !parentOrder) return res.status(400).json({ error: 'sheetTab and parentOrder are required' });
        const key = { sheetTab, parentOrder, awbNumber: awbNumber || '' };
        if (!agentId) await unassignEscalationOrder(key);
        else await assignEscalationOrder(key, agentId);
        return res.status(200).json({ ok: true });
      }
```

New `assign-bulk` branch, directly after the `assign` branch:

```javascript
    // Auto-Assign All's endpoint. One MERGE for the whole selection - the client used to fire one
    // request per order, which against BigQuery is thousands of concurrent DML statements.
    if (action === 'assign-bulk') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { items } = body;
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });
      if (items.some((i) => !i.sheetTab || !i.parentOrder || !i.agentId)) {
        return res.status(400).json({ error: 'Every item requires sheetTab, parentOrder and agentId' });
      }
      return res.status(200).json({ ok: true, assigned: await assignEscalationOrdersBulk(items) });
    }
```

`update` branch:

```javascript
    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { sheetTab, parentOrder, awbNumber, newOrderId, newAwb, newStatus, notes } = body;
      if (!sheetTab || !parentOrder || !newOrderId || !newAwb || !newStatus) {
        return res.status(400).json({ error: 'sheetTab, parentOrder, newOrderId, newAwb, and newStatus are all required' });
      }
      await updateOrder(
        { sheetTab, parentOrder, awbNumber: awbNumber || '' },
        { newOrderId, newAwb, newStatus, notes: notes || '', resolvedBy: session.email }
      );
      return res.status(200).json({ ok: true });
    }
```

`bulk-update` branch — `batchUpdateOrders` now writes the events itself, so the separate
`resolveEscalationAssignmentsBulk` call is deleted:

```javascript
      if (items.some((i) => !i.sheetTab || !i.parentOrder)) {
        return res.status(400).json({ error: 'Every item requires sheetTab and parentOrder' });
      }
      const updated = await batchUpdateOrders(
        items.map(({ sheetTab, parentOrder, awbNumber }) => ({
          sheetTab, parentOrder, awbNumber: awbNumber || '',
          newOrderId: '-', newAwb: '-', newStatus: status, notes: '', resolvedBy: session.email,
        }))
      );
      return res.status(200).json({ ok: true, updated });
```

`import` branch — swap `getSheetIndex()` for `getOrderIndex()`, and replace the `seenKey` line,
the `updates.push({...})` call, and the response's `rowNumbers` field:

```javascript
      const { byParent, byParentAwb } = await getOrderIndex();
```

```javascript
        const seenKey = `${ref.sheetTab}:${ref.parentOrder}:${ref.awbNumber}`;
        if (seenRows.has(seenKey)) return errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Duplicate row in file (skipped)' });
        seenRows.add(seenKey);

        updates.push({
          sheetTab: ref.sheetTab,
          parentOrder: ref.parentOrder,
          awbNumber: ref.awbNumber,
          newOrderId: String(row['New Order ID'] ?? '').trim() || '-',
          newAwb: String(row['New AWB / Tracking'] ?? '').trim() || '-',
          newStatus: status,
          notes: String(row.Notes ?? '').trim(),
          resolvedBy: session.email,
        });
```

```javascript
        rowNumbers: updates.map((u) => `${u.sheetTab}:${u.parentOrder}`),
```

- [ ] **Step 5: Delete escalationSheet.js**

```bash
git rm api/_lib/escalationSheet.js
```

The sheet is still read — by `scripts/sync_escalation_sheet_to_bq.py`, using `lib.get_sheet_values`.
Nothing in `api/` needs it.

- [ ] **Step 6: Update db.js**

Delete `assignEscalationOrder`, `unassignEscalationOrder`, `resolveEscalationAssignment`,
`resolveEscalationAssignmentsBulk`, `getEscalationAssignments`, and `getLiveEscalationAssignments`
— both the definitions and their `module.exports` entries.

Add `pgSql` to `module.exports`, which the migration script needs:

```javascript
  sql, pgSql, ensureSchema, CARD_KEYS, CARD_LABELS,
```

Leave the `escalation_lead_assignments` DDL in `bootstrapPgSchema` in place, with a comment:

```javascript
  // Retained deliberately. Escalation assignments moved to BigQuery in the 2026-08 migration;
  // this table is no longer read or written, and stays only as the rollback path. Drop it in a
  // later cleanup once BigQuery has run clean for a few weeks.
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test:escalation`
Expected: PASS — 27 passed

- [ ] **Step 8: Commit**

```bash
git add api/escalation/[action].js api/_lib/db.js scripts/test_escalation_bq.js
git commit -m "feat(bq): point the escalation API at BigQuery, drop the sheet layer"
```

---

### Task 10: Client changes

**Files:**
- Modify: `app/escalation/EscalationClient.js`

- [ ] **Step 1: Send the new update payload and fix the toast copy**

At [lines 718-726](../../../app/escalation/EscalationClient.js#L718-L726):

```javascript
        body: JSON.stringify({
          sheetTab: order.sheetTab,
          parentOrder: order.parentOrder,
          awbNumber: order.awbNumber || '',
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
```

At [line 731](../../../app/escalation/EscalationClient.js#L731) the toast no longer describes what happens:

```javascript
      onToast('success', `Resolved — ${order.parentOrder || 'row'} saved`);
```

- [ ] **Step 2: Make single assignment optimistic**

BigQuery writes take 2–5s, and blocking the dropdown that long reads as a hang. Replace
`handleAssign` ([lines 741-758](../../../app/escalation/EscalationClient.js#L741-L758)):

```javascript
  async function handleAssign(e) {
    const agentId = e.target.value;
    const agent = agents.find((a) => a.email === agentId);
    const previous = assignment; // OrderRow already receives this prop — see its signature
    setAssigning(true);
    // Optimistic, reverted below if the write fails.
    onAssign(rowKey(order), agentId ? { agentId } : null);
    try {
      const res = await fetch('/api/escalation/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheetTab: order.sheetTab,
          parentOrder: order.parentOrder,
          awbNumber: order.awbNumber || '',
          agentId: agentId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save assignment');
      onToast('success', agentId ? `Assigned to ${agent?.name || agentId}` : 'Assignment cleared');
    } catch (err) {
      onAssign(rowKey(order), previous);
      onToast('error', err.message || 'Failed to save assignment');
    } finally { setAssigning(false); }
  }
```

No new prop is needed: `OrderRow` already destructures `assignment` at
[line 673](../../../app/escalation/EscalationClient.js#L673) and is passed
`assignment={assignments[rowKey(o)] || null}` at
[line 1693](../../../app/escalation/EscalationClient.js#L1693).

- [ ] **Step 3: Carry awbNumber through bulk update**

At [lines 1198-1201](../../../app/escalation/EscalationClient.js#L1198-L1201):

```javascript
    const items = Array.from(selectedRows).map((key) => {
      const o = orders.find((o) => rowKey(o) === key);
      return { sheetTab: o?.sheetTab, parentOrder: o?.parentOrder, awbNumber: o?.awbNumber || '' };
    }).filter((i) => i.sheetTab && i.parentOrder);
```

- [ ] **Step 4: Collapse Auto-Assign All to one request**

Replace the body of `handleAutoAssign` ([lines 1261-1305](../../../app/escalation/EscalationClient.js#L1261-L1305)):

```javascript
  async function handleAutoAssign() {
    if (!isAdmin && !googleUser?.email) return;

    setAutoAssigning(true);
    try {
      const unassigned = orders.filter((o) => !assignments[rowKey(o)]);
      if (unassigned.length === 0) { showToast('success', 'All orders already assigned!'); return; }
      if (isAdmin && agents.length === 0) { showToast('error', 'No agents available'); return; }

      // One request for the whole queue. This used to be one fetch per order in a Promise.all -
      // fine against Postgres, fatal against BigQuery, where it becomes one DML statement per row.
      const items = unassigned.map((o, i) => ({
        sheetTab: o.sheetTab,
        parentOrder: o.parentOrder,
        awbNumber: o.awbNumber || '',
        agentId: isAdmin ? agents[i % agents.length].email : googleUser.email,
      }));

      const res = await fetch('/api/escalation/assign-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Auto-assign failed');

      const newMap = {};
      unassigned.forEach((o, i) => { newMap[rowKey(o)] = { agentId: items[i].agentId }; });
      setAssignments((p) => ({ ...p, ...newMap }));
      showToast('success', isAdmin
        ? `Auto-assigned ${unassigned.length} orders (round-robin across ${agents.length} agents)`
        : `Auto-assigned ${unassigned.length} orders to you`);
    } catch (err) {
      showToast('error', err.message || 'Auto-assign failed');
    } finally { setAutoAssigning(false); }
  }
```

- [ ] **Step 5: Verify no lingering rowNumber in request bodies**

Run: `grep -n "rowNumber" app/escalation/EscalationClient.js`
Expected: matches only in `rowKey()`, the `fId` DOM id, and their comments — no `JSON.stringify`
body may contain `rowNumber`.

- [ ] **Step 6: Commit**

```bash
git add app/escalation/EscalationClient.js
git commit -m "feat(escalation): key writes on parent+AWB, single-call auto-assign, optimistic writes"
```

---

### Task 11: Migration and reconciliation

**Files:**
- Create: `scripts/migrate_escalation_to_bq.py`

Run once by the user against real infrastructure. Safe to re-run.

- [ ] **Step 1: Write the script**

Create `scripts/migrate_escalation_to_bq.py`:

```python
"""One-off backfill: escalation sheet + Postgres assignments -> BigQuery.

    python scripts/migrate_escalation_to_bq.py --dry-run    # report only, writes nothing
    python scripts/migrate_escalation_to_bq.py              # apply

Safe to re-run. The sweep is WRITE_TRUNCATE + MERGE, the historical-resolution backfill only
touches rows with no resolution in BigQuery yet, and the assignment backfill clears its own
previously-written events before re-inserting. A second run converges rather than duplicating.

This is the one script here that talks to live infrastructure. It reconciles at the end and exits
non-zero on any mismatch, so a partial migration cannot be mistaken for a clean one.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import escalation_bq_schema as schema
import sync_escalation_sheet_to_bq as sweep

DRY_RUN = False


def backfill_orders():
    print("\n== Orders ==")
    schema.create_tables()
    for brand in schema.BRANDS:
        out = sweep.sweep_brand(brand, dry_run=DRY_RUN)
        print(f"  {brand}: read {out['read']}, loaded {out['loaded']}, "
              f"duplicate keys {out['duplicates']}")


def backfill_historical_resolutions():
    """The sheet's T-W columns hold real resolutions agents typed before this migration.

    The sweep's matched arm writes sheet columns only, so it does not carry them across - that
    separation is deliberate and must not be relaxed. They are backfilled here instead, onto rows
    with no resolution in BigQuery yet, so re-running never overwrites work done since cutover.
    """
    print("\n== Historical resolutions (sheet columns T-W) ==")
    rows = []
    for brand in schema.BRANDS:
        values = sweep.lib.get_sheet_values(sweep.SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
        for i, cells in enumerate(values):
            r = schema.sheet_row_to_bq(cells, brand, row_number=i + 2)
            if str(r.get("status") or "").strip():
                rows.append({
                    "brand": r["brand"],
                    "parent_order": r["parent_order"],
                    "awb_key": r["awb_key"],
                    "new_order_id": r.get("new_order_id") or "-",
                    "new_awb": r.get("new_awb") or "-",
                    "status": r["status"],
                    "notes": r.get("notes") or "",
                })
    print(f"  {len(rows)} resolved row(s) found in the sheet")
    if DRY_RUN or not rows:
        return

    fields = ["brand", "parent_order", "awb_key", "new_order_id", "new_awb", "status", "notes"]
    bq_lib.query(
        f"""MERGE `{schema.ORDERS}` T
        USING UNNEST(@items) S
        ON  T.brand = S.brand AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key
        WHEN MATCHED AND COALESCE(T.status, '') = '' THEN UPDATE SET
          new_order_id = S.new_order_id,
          new_awb = S.new_awb,
          status = S.status,
          notes = S.notes""",
        [bq_lib.struct_array_param("items", fields, rows)],
    )
    print("  backfilled")


def backfill_assignments():
    """Each Postgres assignment row becomes up to three events, reproducing the cycles the
    Assignments panel renders today."""
    print("\n== Assignments ==")
    try:
        import psycopg
    except ImportError:
        print("  psycopg not installed - run `pip install -r requirements.txt` first")
        raise

    conn_str = __import__("os").environ.get("DATABASE_URL")
    if not conn_str:
        raise RuntimeError("DATABASE_URL is not set - cannot read escalation_lead_assignments.")

    import lib
    with lib.get_pg_connection(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT parent_order, email, assigned_at, reassigned_away_at,
                       resolved_at, resolution, agent_remarks
                FROM escalation_lead_assignments
                ORDER BY assigned_at ASC
            """)
            pg_rows = cur.fetchall()
    print(f"  {len(pg_rows)} Postgres assignment row(s)")
    if DRY_RUN or not pg_rows:
        return

    events = []
    for parent, email, assigned_at, away_at, resolved_at, resolution, remarks in pg_rows:
        events.append({"parent_order": parent, "email": email, "event": "assigned",
                       "resolution": None, "agent_remarks": None, "ts": assigned_at.isoformat()})
        if away_at:
            events.append({"parent_order": parent, "email": email, "event": "reassigned_away",
                           "resolution": None, "agent_remarks": None, "ts": away_at.isoformat()})
        if resolved_at:
            events.append({"parent_order": parent, "email": email, "event": "resolved",
                           "resolution": resolution, "agent_remarks": remarks,
                           "ts": resolved_at.isoformat()})

    # Idempotence: clear whatever a previous run of this script wrote before re-inserting.
    bq_lib.query(f"DELETE FROM `{schema.EVENTS}` WHERE TRUE")
    fields = ["parent_order", "email", "event", "resolution", "agent_remarks", "ts"]
    bq_lib.query(
        f"""INSERT INTO `{schema.EVENTS}`
              (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
            SELECT parent_order, NULL, NULL, email, event, resolution, agent_remarks, TIMESTAMP(ts)
            FROM UNNEST(@events)""",
        [bq_lib.struct_array_param("events", fields, events)],
    )
    print(f"  {len(events)} event(s) inserted")

    live = [(p, e, a) for p, e, a, away, res, _, _ in pg_rows if not away and not res]
    if live:
        bq_lib.query(
            f"""MERGE `{schema.ORDERS}` T
            USING UNNEST(@items) S
            ON T.parent_order = S.parent_order
            WHEN MATCHED AND T.assigned_to IS NULL THEN UPDATE SET
              assigned_to = S.email, assigned_at = TIMESTAMP(S.assigned_at)""",
            [bq_lib.struct_array_param(
                "items", ["parent_order", "email", "assigned_at"],
                [{"parent_order": p, "email": e, "assigned_at": a.isoformat()} for p, e, a in live])],
        )
        print(f"  {len(live)} live assignment(s) stamped onto orders")
    return len(live)


def reconcile(live_pg_count):
    print("\n== Reconcile ==")
    failures = 0

    for brand in schema.BRANDS:
        values = sweep.lib.get_sheet_values(sweep.SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
        rows = [schema.sheet_row_to_bq(c, brand, row_number=i + 2) for i, c in enumerate(values)]
        dupes = schema.count_duplicate_keys(rows)
        bq_count = int(bq_lib.query_rows(
            f"SELECT COUNT(*) AS n FROM `{schema.ORDERS}` "
            "WHERE brand = @brand AND deleted_from_sheet_at IS NULL",
            [bq_lib.str_param("brand", brand)])[0]["n"])
        expected = len(rows) - dupes
        ok = bq_count >= expected
        print(f"  {'ok  ' if ok else 'FAIL'} {brand}: sheet={len(rows)} "
              f"(minus {dupes} duplicate keys = {expected}), bigquery={bq_count}")
        if not ok:
            failures += 1

    sheet_resolved = 0
    for brand in schema.BRANDS:
        values = sweep.lib.get_sheet_values(sweep.SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
        sheet_resolved += sum(
            1 for c in values
            if str(schema.sheet_row_to_bq(c, brand).get("status") or "").strip())
    bq_resolved = int(bq_lib.query_rows(
        f"SELECT COUNT(*) AS n FROM `{schema.ORDERS}` WHERE COALESCE(status, '') != ''"
    )[0]["n"])
    ok = bq_resolved >= sheet_resolved
    print(f"  {'ok  ' if ok else 'FAIL'} resolved rows: sheet={sheet_resolved} bigquery={bq_resolved}")
    if not ok:
        failures += 1

    bq_live = int(bq_lib.query_rows(
        f"SELECT COUNT(*) AS n FROM `{schema.ORDERS}` "
        "WHERE assigned_to IS NOT NULL AND resolved_at IS NULL")[0]["n"])
    ok = bq_live == live_pg_count
    print(f"  {'ok  ' if ok else 'FAIL'} live assignments: postgres={live_pg_count} bigquery={bq_live}")
    if not ok:
        failures += 1

    if failures:
        print(f"\n{failures} reconciliation check(s) failed - do not cut over.")
        return 1
    print("\nReconciliation clean.")
    return 0


def main():
    global DRY_RUN
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    DRY_RUN = args.dry_run

    print("DRY RUN - nothing will be written\n" if DRY_RUN else "APPLYING migration\n")
    backfill_orders()
    backfill_historical_resolutions()
    live_pg_count = backfill_assignments() or 0
    sys.exit(0 if DRY_RUN else reconcile(live_pg_count))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify the file parses**

Run: `python -m py_compile scripts/migrate_escalation_to_bq.py && echo ok`
Expected: `ok`

**Do not run the script** — it writes to live BigQuery and reads the live sheet and database.
The user runs it.

- [ ] **Step 3: Run both self-checks one final time**

Run: `python scripts/test_escalation_ingest.py && npm run test:escalation`
Expected: PASS — 26 passed (Python), 27 passed (Node)

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate_escalation_to_bq.py
git commit -m "feat(bq): one-off escalation migration with reconciliation"
```

---

## Handover notes for the user

Outside the repo, and not doable by the implementer:

1. Grant **BigQuery Data Editor** and **BigQuery Job User** on `BQ_PROJECT_ID` to both principals: the `GOOGLE_SA_KEY` service account used by Actions, and the `GOOGLE_SHEETS_CLIENT_EMAIL` account used by the Lambda.
2. Add repository secret `BQ_PROJECT_ID` and (optionally) repository variable `BQ_DATASET`.
3. Set `BQ_PROJECT_ID` and `BQ_DATASET` in the Lambda environment.
4. Run `python scripts/migrate_escalation_to_bq.py --dry-run`, then without the flag. Confirm reconciliation is clean before cutting over.
5. **Decide the sweep cadence.** Until you add a `schedule:` block to `.github/workflows/sync-escalation-bq.yml`, formula recalculations and the logistics paste only reach the queue when someone dispatches the sweep by hand.
6. Later, to retire the sheet: re-express the five L:P formulas as SQL and re-home the Q:S logistics paste. `city` and `state` already have a known MySQL source (`Item_level_data.Shipping_Address_City` / `_State` by `Tracking_Number`), so those two are the easy first step.
