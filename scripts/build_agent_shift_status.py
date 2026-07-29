"""Builds data/agent_shift_status.json (the Agent wise analysis tab's data source
- see build_csat_artifact.py) from the raw per-agent status-log CSVs on Drive.

Drive layout: a parent folder containing one subfolder per brand ("Hyphen",
"mCaffeine"), each holding one or more CSVs per agent named
"agent-logs-<slug>-<export-date>.csv". Each export date's file is NOT a
standalone day - it's an as-of dump that adds whatever days aren't in an
earlier export yet (in practice: one big historical file plus small
day-at-a-time files after it), so every file for an agent is downloaded and
unioned (deduped on the exact raw row) before aggregating - never processed
in isolation.

Each row in a raw CSV is one status segment (Date, Status, Start Time, End
Time, Duration, Duration (minutes)); Date is the day the segment STARTED,
even when it runs past midnight (e.g. an overnight Offline segment is filed
entirely under the evening it began). Per (agent, Date) this computes:
  - login  = earliest Start Time among that date's non-Offline rows
  - logout = latest End Time among that date's non-Offline rows
  - busy_min / break_min / offline_min = summed Duration (minutes) for the
    Busy / On Break / Offline rows on that date (raw Busy only, not
    Available - see the dashboard's own footnote)
  - active_min = Available + Busy summed minutes (kept for schema parity;
    not currently rendered anywhere in deepdive.html)
These are exactly the rules stated in the rendered dashboard's table
footnote, reverse-engineered against the prior (already-committed)
data/agent_shift_status.json plus its raw source CSVs to confirm the match.
"""
import csv
import io
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "data/agent_shift_status.json"

PARENT_FOLDER_ID = "1O3w0F7J218JjCxjaWlbdjSUKGROLXAI1"
BRANDS = ["Hyphen", "mCaffeine"]

FILENAME_RE = re.compile(r"^agent-logs-(.+)-\d{4}-\d{2}-\d{2}\.csv$")
DT_FMT = "%m/%d/%Y, %I:%M:%S %p"


def slug_to_name(slug):
    return " ".join(w.capitalize() for w in slug.split("-"))


def h_to_label(minutes):
    if minutes is None:
        return "–"
    h = int(minutes // 60)
    m = round(minutes - h * 60)
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


def clock_label(dt):
    hour12 = dt.hour % 12 or 12
    return f"{hour12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"


def minutes_of_day(dt):
    return dt.hour * 60 + dt.minute + dt.second / 60


def main():
    result = {}
    parent_files = lib.list_drive_folder(PARENT_FOLDER_ID)
    scratch_dir = REPO_ROOT / "data" / "_shift_export_tmp"
    scratch_dir.mkdir(exist_ok=True)

    for brand in BRANDS:
        folder = next((f for f in parent_files if f["name"] == brand), None)
        if not folder:
            print(f"WARNING: no '{brand}' subfolder found under the Drive folder - skipping.")
            continue

        files = lib.list_drive_folder(folder["id"])
        by_slug = {}
        for f in files:
            m = FILENAME_RE.match(f["name"])
            if not m:
                print(f"  [{brand}] skipping unrecognized file name: {f['name']}")
                continue
            by_slug.setdefault(m.group(1), []).append(f)

        print(f"[{brand}] {len(by_slug)} agent(s), {len(files)} file(s) total")

        agents_out = []
        for slug, agent_files in sorted(by_slug.items()):
            raw_rows = set()
            for f in agent_files:
                dest = scratch_dir / f["id"]
                lib.download_drive_file(f["id"], dest)
                text = dest.read_text(encoding="utf-8-sig")
                dest.unlink()
                reader = csv.reader(io.StringIO(text))
                header = next(reader, None)
                for row in reader:
                    if len(row) < 6 or not row[0]:
                        continue
                    raw_rows.add(tuple(row[:6]))

            by_date = {}
            for date_str, status, start_str, end_str, _dur_str, dur_min_str in raw_rows:
                try:
                    dur_min = float(dur_min_str)
                    start_dt = datetime.strptime(start_str.strip(), DT_FMT)
                    end_dt = datetime.strptime(end_str.strip(), DT_FMT)
                except ValueError:
                    continue
                by_date.setdefault(date_str, []).append((status.strip(), start_dt, end_dt, dur_min))

            days = []
            for date_str, segs in by_date.items():
                try:
                    date_obj = datetime.strptime(date_str, "%m/%d/%Y").date()
                except ValueError:
                    continue
                non_offline = [s for s in segs if s[0] != "Offline"]
                busy_min = sum(s[3] for s in segs if s[0] == "Busy")
                break_min = sum(s[3] for s in segs if s[0] == "On Break")
                offline_min = sum(s[3] for s in segs if s[0] == "Offline")
                available_min = sum(s[3] for s in segs if s[0] == "Available")
                active_min = available_min + busy_min

                if non_offline:
                    login_dt = min(s[1] for s in non_offline)
                    logout_dt = max(s[2] for s in non_offline)
                    login, logout = clock_label(login_dt), clock_label(logout_dt)
                    login_sort = login_dt.strftime("%H:%M:%S")
                    login_min, logout_min = minutes_of_day(login_dt), minutes_of_day(logout_dt)
                else:
                    login = logout = login_sort = None
                    login_min = logout_min = None

                week_start = date_obj - timedelta(days=date_obj.weekday())
                days.append({
                    "date": date_str,
                    "date_sort": date_obj.isoformat(),
                    "week_start": week_start.isoformat(),
                    "login": login, "login_sort": login_sort, "login_min": login_min,
                    "logout": logout, "logout_min": logout_min,
                    "active_min": round(active_min, 1),
                    "busy_min": round(busy_min, 1),
                    "break_min": round(break_min, 1),
                    "offline_min": round(offline_min, 1),
                    "active_label": h_to_label(active_min),
                    "busy_label": h_to_label(busy_min),
                    "break_label": h_to_label(break_min),
                    "offline_label": h_to_label(offline_min),
                })

            days.sort(key=lambda d: d["date_sort"], reverse=True)
            agents_out.append({"name": slug_to_name(slug), "days": days})
            print(f"  [{brand}] {slug_to_name(slug)}: {len(agent_files)} file(s), {len(days)} day(s)")

        agents_out.sort(key=lambda a: a["name"])
        result[brand] = agents_out

    scratch_dir.rmdir()

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
