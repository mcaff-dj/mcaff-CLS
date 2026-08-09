"""Offline self-check for the escalation BigQuery ingest scripts.

    python scripts/test_escalation_ingest.py

No network, no BigQuery, no sheet, no MySQL: every test monkeypatches the transport, so this is
safe to run anywhere. Each task in the implementation plan appends its own section; keep them in
task order.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("BQ_PROJECT_ID", "test-project")
os.environ.setdefault("BQ_DATASET", "escalation")

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
    body_text = kw["data"].decode("utf-8") if isinstance(kw["data"], bytes) else kw["data"]
    assert '"writeDisposition": "WRITE_TRUNCATE"' in body_text or \
           '"writeDisposition":"WRITE_TRUNCATE"' in body_text, body_text[:300]


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


# ---------- summary ----------
if __name__ == "__main__":
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
