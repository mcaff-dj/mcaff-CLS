"""Returns NDR leads held by an agent who has left the process back to the unassigned pool, by
blanking Agent Name (column S) on the sheet and retiring the matching live row in
PEP_CLS.ndr_lead_assignments.

assign_ndr_leads.py deliberately never takes back a lead once Agent Name is set ("never take
back what's already handed out" - see its module docstring), which is right for an agent who is
merely offline for the evening and wrong for one who has moved off NDR entirely: their
undisposed leads then sit forever, assigned to nobody who will ever call them, and invisible to
the round-robin. 27 such leads were found on 2026-08-25, held by an agent whose last NDR
assignment was 2026-08-12.

An agent qualifies as GONE only if ALL of these are true:

  * they are not 'Online' for 'ndr' in calling_agent_process right now, AND
  * the newest Calling Date on any NDR sheet row of theirs is older than --stale-days
    (default 5), AND
  * their newest ndr_lead_assignments activity (latest assigned_at or disposed_at) is older
    than the same cutoff.

No single test works. calling_agent_process.status tracks the agent's LIVE state (an agent
mid-call reads 'Busy', and only exact 'Online' is eligible for leads - see
assign_ndr_leads.fetch_online_ndr_agents), so on its own it would reclaim from everyone at
lunch. ndr_lead_assignments alone is not enough either, because that mirror is a best-effort
write that has been silently behind before (see backfill_ndr_mirror_from_sheet.py) and a missing
row would make a busy agent look idle - so the sheet's own Calling Date, which cannot be behind
because it IS the source of truth, has to agree before anyone is judged gone. And agent_presence
is deliberately NOT consulted at all: it is global, not per-process, so an agent who moved off
NDR onto RTO keeps a fresh heartbeat forever while never touching an NDR lead again - which is
exactly the case this script exists for.

Only leads with a BLANK Connected column are touched - a lead that was already worked keeps its
agent, forever, since that agent is who actually called the customer.

    python scripts/reclaim_stranded_ndr_leads.py                 # dry run, changes nothing
    python scripts/reclaim_stranded_ndr_leads.py --apply
    python scripts/reclaim_stranded_ndr_leads.py --stale-days 10 --apply
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib
# Same Calling Date parser, same tolerance for the orderings this hand-edited column actually
# carries - one definition, not two that can drift.
from backfill_ndr_mirror_from_sheet import parse_calling_date

SPREADSHEET_ID = "12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI"
SHEET_TAB = "Latest NDR "  # trailing space is part of the real tab name - do not trim it
APP_SCHEMA = "PEP_CLS"
PROCESS_KEY = "ndr"

COL_AWB = 4            # E
COL_CALLING_DATE = 17  # R - stamped on disposition, the sheet's own record of agent activity
COL_AGENT = 18         # S - the only column this script writes
COL_CONNECTED = 19     # T

DEFAULT_STALE_DAYS = 5
SHEET_WRITE_CHUNK = 300  # same chunking assign_ndr_leads.py uses for its own Agent Name writes


def cell(row, index):
    return row[index].strip() if len(row) > index and row[index] else ""


def gone_agents(stale_days):
    """(is_gone(email), last_ndr_activity, online_for_ndr) - see the module docstring for the
    two-part test and why agent_presence is not one of the parts."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=stale_days)
    activity = mysql_lib.query(
        "SELECT LOWER(email), MAX(GREATEST(assigned_at, COALESCE(disposed_at, assigned_at))) "
        "FROM ndr_lead_assignments GROUP BY 1",
        database=APP_SCHEMA,
    ) or []
    per_process = mysql_lib.query(
        "SELECT LOWER(email), status FROM calling_agent_process WHERE process_key = %s",
        (PROCESS_KEY,),
        database=APP_SCHEMA,
    ) or []
    online_for_ndr = {email for email, status in per_process if status == "Online"}
    last_activity = {email: seen for email, seen in activity}

    def is_gone(email):
        if email in online_for_ndr:
            return False
        seen = last_activity.get(email)
        return seen is None or seen < cutoff

    return is_gone, last_activity, online_for_ndr


def main(argv):
    apply_it = "--apply" in argv
    stale_days = DEFAULT_STALE_DAYS
    if "--stale-days" in argv:
        stale_days = int(argv[argv.index("--stale-days") + 1])

    is_gone, last_activity, online_for_ndr = gone_agents(stale_days)
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=stale_days)
    print(f"Online for '{PROCESS_KEY}': {sorted(online_for_ndr) or 'nobody'}")
    print(f"Staleness cutoff: {stale_days} day(s)\n")

    rows = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:{lib.get_column_letter(COL_CONNECTED)}1000000")

    # The sheet's own view of when each agent last worked a lead, which no broken mirror can
    # make stale - see the module docstring.
    last_sheet_call = {}
    for row in rows or []:
        agent, called = cell(row, COL_AGENT).lower(), parse_calling_date(cell(row, COL_CALLING_DATE))
        if agent and called and called > last_sheet_call.get(agent, datetime.min):
            last_sheet_call[agent] = called

    stranded = []  # (row_number, awb, agent)
    held_by_active = 0
    for i, row in enumerate(rows or []):
        agent, connected = cell(row, COL_AGENT).lower(), cell(row, COL_CONNECTED)
        if not agent or connected:
            continue  # unassigned, or already worked - either way not ours to touch
        sheet_recent = last_sheet_call.get(agent) is not None and last_sheet_call[agent] >= cutoff
        if is_gone(agent) and not sheet_recent:
            stranded.append((i + 2, cell(row, COL_AWB), agent))
        else:
            held_by_active += 1

    by_agent = {}
    for _row_num, _awb, agent in stranded:
        by_agent[agent] = by_agent.get(agent, 0) + 1
    print(f"open leads held by an active agent (left alone): {held_by_active}")
    print(f"open leads to reclaim: {len(stranded)}")
    for agent, count in sorted(by_agent.items()):
        print(f"  {agent}: {count}  (last mirror activity: {last_activity.get(agent) or 'never'}, "
              f"last sheet Calling Date: {last_sheet_call.get(agent) or 'never'})")

    if not stranded:
        print("\nNothing stranded - nothing to do.")
        return 0
    if not apply_it:
        print("\nDRY RUN - nothing written. Re-run with --apply to write.")
        return 0

    # Sheet first, then MySQL. The sheet is what assign_ndr_leads.py reads its pool from, so
    # that write is the one that actually frees the lead; the MySQL retire is bookkeeping that
    # can be re-run if it fails, whereas the reverse order could retire a cycle for a lead that
    # is still stamped with its old agent on the sheet.
    value_ranges = [
        {"range": f"'{SHEET_TAB}'!{lib.get_column_letter(COL_AGENT)}{row_num}", "values": [[""]]}
        for row_num, _awb, _agent in stranded
    ]
    for start in range(0, len(value_ranges), SHEET_WRITE_CHUNK):
        lib.set_sheet_values_batch(SPREADSHEET_ID, value_ranges[start:start + SHEET_WRITE_CHUNK])
    print(f"\nBlanked Agent Name on {len(value_ranges)} sheet row(s).")

    cred = mysql_lib.get_credential()
    if cred is None:
        print("MYSQL_* credentials not configured - sheet is freed, MySQL rows NOT retired.")
        return 1
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=APP_SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.executemany(
            "UPDATE ndr_lead_assignments SET reassigned_away_at = %s "
            "WHERE awb_number = %s AND reassigned_away_at IS NULL AND disposed_at IS NULL",
            [(now, awb) for _row_num, awb, _agent in stranded if awb],
        )
        conn.commit()
        print(f"Retired {cur.rowcount} live MySQL cycle(s).")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print("\nThose leads are unassigned again - the next assign_ndr_leads run will hand them "
          "to whoever is Online for NDR and under quota.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
