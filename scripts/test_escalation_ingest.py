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


# ---------- summary ----------
if __name__ == "__main__":
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
