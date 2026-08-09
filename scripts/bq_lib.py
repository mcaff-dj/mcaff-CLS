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


def ensure_dataset(location="US"):
    """Creates the dataset if it doesn't exist yet. BigQuery does NOT auto-create a dataset when
    a query targets one - CREATE TABLE IF NOT EXISTS only handles tables within an already-real
    dataset, so a brand-new project needs this run once before create_tables() can succeed.
    Idempotent: a 409 (already exists) is not an error, matching every other "IF NOT EXISTS"
    statement in this module.
    """
    resp = requests.post(
        f"{API}/projects/{project_id()}/datasets",
        headers=_headers(),
        json={"datasetReference": {"projectId": project_id(), "datasetId": dataset_id()},
              "location": location},
        timeout=60,
    )
    if resp.status_code == 409:
        return
    data = resp.json()
    if resp.status_code >= 400:
        raise RuntimeError(data.get("error", {}).get("message", f"BigQuery dataset create failed ({resp.status_code})"))


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
