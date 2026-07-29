#!/usr/bin/env python3
"""Exports Flowcall tickets resolved in the trailing window (resolved_by_ai /
resolved_by_agent) and appends them, with every raw export column, to a tab
in the shared tracking sheet. Meant to run on a recurring schedule (every 2
hours) via Task Scheduler.

State file tracks the last successful window end per tab, so a run that fires
late (machine was off, task missed a slot) still picks up from where the last
run left off instead of silently dropping the gap. Falls back to "now minus
--hours-back" on first run for a tab.

Python port of export-resolved-tickets.ps1 - kept 1:1 with that file's logic
so behavior matches what's already running in production.
"""
import argparse
import csv
import io
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

SHEET_ID = "1fpGeg1ErGc_DVgTGWln86AoLmhKmbUIgOnHNm-54X8A"
STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "resolved-ticket-export-state.json"


def get_state():
    if not STATE_PATH.exists():
        return {}
    with open(STATE_PATH, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=4)


def fetch_export_csv(api_token, tab_name, start_str, end_str):
    body = {
        "startDate": start_str,
        "endDate": end_str,
        "timestampKey": "resolvedAt",
        "statuses": ["resolved_by_ai", "resolved_by_agent"],
        "sortOrder": "desc",
        "timezone": "Asia/Kolkata",
        "locale": "en-IN",
    }
    last_err = None
    for attempt in range(1, 5):
        try:
            resp = requests.post(
                "https://api.flowcall.co/apis/task-runs/tickets/export",
                headers={"Authorization": f"Bearer {api_token}"},
                json=body,
                timeout=180,
            )
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            last_err = e
            print(f"[{tab_name}] export request attempt {attempt} failed: {e}")
            if attempt == 4:
                raise
            time.sleep(5 * attempt)
    raise RuntimeError(f"export request failed") from last_err


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-token", required=True)
    parser.add_argument("--tab-name", required=True)
    parser.add_argument("--hours-back", type=int, default=2)
    args = parser.parse_args()

    tab_name = args.tab_name
    now = datetime.now(timezone.utc)
    state = get_state()
    if state.get(tab_name):
        # Always resume from the last saved end, even if that's well over
        # hours_back ago - a late/missed run still catches up the full gap
        # instead of silently dropping it.
        start_date = datetime.fromisoformat(state[tab_name].replace("Z", "+00:00"))
    else:
        start_date = now - timedelta(hours=args.hours_back)
    end_date = now

    start_str = start_date.strftime("%Y-%m-%dT%H:%M:%S.") + f"{start_date.microsecond // 1000:03d}Z"
    end_str = end_date.strftime("%Y-%m-%dT%H:%M:%S.") + f"{end_date.microsecond // 1000:03d}Z"

    print(f"[{tab_name}] fetching tickets resolved {start_str} -> {end_str}")

    csv_text = fetch_export_csv(args.api_token, tab_name, start_str, end_str)
    all_rows = list(csv.reader(io.StringIO(csv_text)))

    if len(all_rows) <= 1:
        print(f"[{tab_name}] no resolved tickets in this window - nothing to append")
        state[tab_name] = end_str
        save_state(state)
        return

    headers = all_rows[0]
    data_rows = all_rows[1:]

    existing_header = None
    try:
        existing_header = lib.get_sheet_values(SHEET_ID, f"'{tab_name}'!A1:A1")
    except Exception:
        existing_header = None
    if not existing_header:
        print(f"[{tab_name}] tab has no header yet - writing {len(headers)} column headers")
        lib.set_sheet_values_batch(SHEET_ID, [{"range": f"'{tab_name}'!A1", "values": [headers]}])

    next_row = lib.get_last_data_row(SHEET_ID, tab_name) + 1
    if next_row < 2:
        next_row = 2
    lib.set_sheet_rows_at_row(SHEET_ID, tab_name, data_rows, next_row)

    print(f"[{tab_name}] appended {len(data_rows)} rows at row {next_row} (window {start_str} -> {end_str})")

    state[tab_name] = end_str
    save_state(state)


if __name__ == "__main__":
    main()
