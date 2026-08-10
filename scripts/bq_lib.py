"""BigQuery over REST, reusing lib.py's hand-rolled service-account JWT (same
_get_token cache/refresh machinery lib.py already uses for Sheets/Drive) - no
google-cloud-bigquery dependency, no new pip package.

Load jobs only, never streaming inserts: tabledata.insertAll is flatly rejected
("Streaming insert is not allowed in the free tier") on a BigQuery project
running in the free Sandbox - no billing account linked, the same reason a
Sandbox dataset carries a 60-day default table expiration. Load jobs are
allowed in Sandbox and don't have the streaming buffer's ~90min UPDATE-
visibility lag either, so this also matches what
docs/superpowers/specs/2026-08-09-escalation-bigquery-direct-ingest-design.md
already recommends for its own (MERGE-based) loader, for the MERGE reason
rather than the Sandbox one.
"""
import json
import time

import requests

import lib

BASE = "https://bigquery.googleapis.com/bigquery/v2"


def _get_bq_token():
    return lib._get_token("https://www.googleapis.com/auth/bigquery", "bigquery")


def _headers():
    return {"Authorization": f"Bearer {_get_bq_token()}", "Content-Type": "application/json"}


def run_query(project, sql, params=None, timeout_sec=60):
    """Runs a SQL query, returns every row as a list of {column: value} dicts.
    Polls jobComplete and pages through pageToken - a query that doesn't finish
    inside the initial timeout, or returns more rows than one page, still comes
    back complete rather than silently truncated."""
    body = {"query": sql, "useLegacySql": False, "timeoutMs": timeout_sec * 1000}
    if params:
        body["parameterMode"] = "NAMED"
        body["queryParameters"] = [
            {"name": k, "parameterType": {"type": "STRING"}, "parameterValue": {"value": v}}
            for k, v in params.items()
        ]
    resp = requests.post(f"{BASE}/projects/{project}/queries", headers=_headers(), json=body, timeout=timeout_sec + 10)
    resp.raise_for_status()
    data = resp.json()
    job_id = data["jobReference"]["jobId"]
    location = data["jobReference"].get("location")
    loc_param = {"location": location} if location else {}

    while not data.get("jobComplete"):
        time.sleep(1)
        resp = requests.get(f"{BASE}/projects/{project}/queries/{job_id}", headers=_headers(), params=loc_param, timeout=timeout_sec)
        resp.raise_for_status()
        data = resp.json()

    fields = [f["name"] for f in data.get("schema", {}).get("fields", [])]
    rows = []

    def consume(d):
        for row in d.get("rows", []):
            rows.append({f: v.get("v") for f, v in zip(fields, row["f"])})

    consume(data)
    page_token = data.get("pageToken")
    while page_token:
        resp = requests.get(
            f"{BASE}/projects/{project}/queries/{job_id}",
            headers=_headers(), params={**loc_param, "pageToken": page_token}, timeout=timeout_sec,
        )
        resp.raise_for_status()
        data = resp.json()
        consume(data)
        page_token = data.get("pageToken")
    return rows


def ensure_table(project, dataset, table, schema_fields):
    """Creates the table if it doesn't already exist. schema_fields:
    [{"name": ..., "type": ...}, ...]. A 409 on create means another concurrent
    run (e.g. the HYPHEN and mCaffeine tabs syncing back to back) won it first -
    that's success too, not an error."""
    resp = requests.get(f"{BASE}/projects/{project}/datasets/{dataset}/tables/{table}", headers=_headers())
    if resp.status_code == 200:
        return
    if resp.status_code != 404:
        resp.raise_for_status()
    body = {
        "tableReference": {"projectId": project, "datasetId": dataset, "tableId": table},
        "schema": {"fields": schema_fields},
    }
    resp = requests.post(f"{BASE}/projects/{project}/datasets/{dataset}/tables", headers=_headers(), json=body)
    if resp.status_code == 409:
        return
    resp.raise_for_status()


def load_ndjson(project, dataset, table, rows, timeout_sec=180):
    """Appends rows via a load job (NEWLINE_DELIMITED_JSON, WRITE_APPEND),
    uploaded as a multipart request (job config JSON + ndjson body) since
    there's no google-cloud-bigquery client here to build one. Dedup is the
    caller's job (query BigQuery for known keys before calling this) - a load
    job has no per-row insertId dedup the way streaming inserts do, but this
    project can't stream anyway (see module docstring)."""
    if not rows:
        return 0
    ndjson = "\n".join(json.dumps(r) for r in rows)
    job_config = {
        "configuration": {
            "load": {
                "destinationTable": {"projectId": project, "datasetId": dataset, "tableId": table},
                "sourceFormat": "NEWLINE_DELIMITED_JSON",
                "writeDisposition": "WRITE_APPEND",
            }
        }
    }
    boundary = "bq_load_boundary"
    body = (
        f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(job_config)}\r\n"
        f"--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n{ndjson}\r\n"
        f"--{boundary}--"
    ).encode("utf-8")

    resp = requests.post(
        f"https://bigquery.googleapis.com/upload/bigquery/v2/projects/{project}/jobs?uploadType=multipart",
        headers={"Authorization": f"Bearer {_get_bq_token()}", "Content-Type": f"multipart/related; boundary={boundary}"},
        data=body, timeout=timeout_sec,
    )
    resp.raise_for_status()
    job = resp.json()
    job_id = job["jobReference"]["jobId"]
    loc_param = {"location": job["jobReference"]["location"]} if job["jobReference"].get("location") else {}

    status = job.get("status", {})
    while status.get("state") != "DONE":
        time.sleep(2)
        resp = requests.get(f"{BASE}/projects/{project}/jobs/{job_id}", headers=_headers(), params=loc_param, timeout=timeout_sec)
        resp.raise_for_status()
        job = resp.json()
        status = job.get("status", {})

    if status.get("errorResult"):
        raise RuntimeError(f"Load job failed: {status['errorResult']}")
    return len(rows)
