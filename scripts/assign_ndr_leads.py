"""Step 2 of standing up NDR Calling: round-robins unassigned NDR leads (see
sync_ndr_leads_to_sheet.py's Sheet1) across agents who are online for NDR specifically, up to
each agent's own NDR quota and respecting each agent's attempt-count filter (see
agent_attempt_filter below).

Deliberately independent of scripts/assign_leads.py and scripts/lead_priority.py - NDR's rules
are simpler today and are expected to diverge further as NDR Calling grows its own disposition
workflow, so nothing here is shared with RTO beyond the generic, already-process-keyed
Postgres tables (calling_agent_process, agent_presence) and the generic lib.py Sheets helpers
both processes already use.

A lead is "unassigned" iff column Q (assigned_agent) is blank - once a row leaves that state,
this script never touches it again, the same "never take back what's already handed out"
contract RTO's own assign_leads.py uses. current_load is read straight off the sheet (a count
of rows already carrying that agent's email in Q) rather than a separate Postgres tally: the
sheet IS the persistence now that sync_ndr_leads_to_sheet.py no longer wipes Q/R on refresh.

Column P is ndr_source.COLUMNS' own last source field (pincode) - this script must never
write there. A prior version hardcoded the write range as "P{row}:Q{row}" from before
courier_final_status shifted the source columns from 15 to 16 wide, silently overwriting
pincode with the agent's email and putting a timestamp in Q instead - fixed by computing the
write range from COL_AGENT/COL_ASSIGNED_AT instead of a literal string.
"""
import os
from datetime import datetime, timezone

import psycopg

import lib
import ndr_source

PROCESS_KEY = "ndr"
SPREADSHEET_ID = "1oRPRvZaGpgQsZyXO_Q_j5HEZO1nkrFv0spTobfDoQ2g"
SHEET_TAB = "Sheet1"

COL_ORDER_DATE = 2                                       # C - uni_Order_Date, the sort key
COL_NDR_ATTEMPTS = ndr_source.COLUMNS.index("cp_ndr_attempts")  # H
COL_AGENT = len(ndr_source.COLUMNS)                      # assigned_agent - Q now that
COL_ASSIGNED_AT = COL_AGENT + 1                          # ndr_source.COLUMNS has grown to 16
COL_AGENT_LETTER = lib.get_column_letter(COL_AGENT)              # "Q"
COL_ASSIGNED_AT_LETTER = lib.get_column_letter(COL_ASSIGNED_AT)  # "R"
LAST_COL = COL_ASSIGNED_AT_LETTER

STALE_MINUTES = 10  # must match the CRM's own heartbeat cadence - same convention as RTO's
DEFAULT_QUOTA = 20  # NDR's own fallback, independent of RTO's leadAssignmentRules.json value

ATTEMPT_BUCKETS = ("1", "2", "3", "More than 3")


def attempt_bucket(raw):
    """cp_ndr_attempts (a sheet cell, string) -> one of ATTEMPT_BUCKETS, or None if it can't be
    parsed. None is treated as "don't restrict" wherever it's used below (fails open) - an
    unreadable attempt count shouldn't be the reason a lead never gets called, the same
    fail-open philosophy assign_leads.py's own GoKwik check uses."""
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return str(n) if n <= 3 else "More than 3"


def fetch_online_ndr_agents():
    """([email, ...] eligible now, {email: max_quota}, {email: [bucket, ...]}). Eligibility is
    the same intersection RTO's own fetch_online_agents uses: heartbeat-fresh in agent_presence
    AND marked Online for this process_key in calling_agent_process. A process with no
    per-process rows set yet falls back to global presence, matching the pre-per-process
    behaviour. attempt_filters is {email: [bucket, ...]} from attempt_count_filter - an agent
    absent from it (or with an empty list) is unrestricted, same "absent means no restriction"
    contract as RTO's reassign_payment_mode. Returns ([], {}, {}) if POSTGRES_URL isn't
    configured, so a missing secret fails safe - no assignment, not a crash."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        print("POSTGRES_URL not configured - cannot determine online agents.")
        return [], {}, {}
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT email FROM agent_presence
                WHERE status = 'Online' AND updated_at >= now() - interval '%s minutes'
                ORDER BY email
                """,
                (STALE_MINUTES,),
            )
            present = {row[0].lower() for row in cur.fetchall()}

            try:
                cur.execute(
                    "SELECT email, status, max_quota, attempt_count_filter "
                    "FROM calling_agent_process WHERE process_key = %s",
                    (PROCESS_KEY,),
                )
                per_process = cur.fetchall()
            except Exception as e:
                print(f"  (calling_agent_process unavailable: {e} - using global presence)")
                return sorted(present), {}, {}

    if not per_process:
        print(f"  no per-process availability set for '{PROCESS_KEY}' - using global presence")
        return sorted(present), {}, {}

    online_for_process = {e.lower() for e, status, _, _ in per_process if status == "Online"}
    quotas = {e.lower(): q for e, _, q, _ in per_process if q is not None}
    attempt_filters = {}
    for e, _, _, filt in per_process:
        buckets = [b.strip() for b in (filt or "").split(",") if b.strip()]
        if buckets:
            attempt_filters[e.lower()] = buckets
    eligible = sorted(online_for_process & present)
    if online_for_process and not eligible:
        print(f"  {len(online_for_process)} agent(s) marked Online for '{PROCESS_KEY}', but "
              f"none are heartbeat-fresh (within {STALE_MINUTES}m) - nobody is actually at "
              f"their desk.")
    return eligible, quotas, attempt_filters


def main():
    online_agents, quotas, attempt_filters = fetch_online_ndr_agents()
    if not online_agents:
        print("No agents online for NDR right now - nothing to assign.")
        return

    sheet_rows = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:{LAST_COL}1000000")

    current_load = {email: 0 for email in online_agents}
    unassigned = []  # (row_number, order_date, attempt_bucket)
    for i, row in enumerate(sheet_rows):
        agent = row[COL_AGENT].strip().lower() if len(row) > COL_AGENT and row[COL_AGENT] else ""
        if agent:
            if agent in current_load:
                current_load[agent] += 1
        else:
            order_date = row[COL_ORDER_DATE] if len(row) > COL_ORDER_DATE else ""
            bucket = attempt_bucket(row[COL_NDR_ATTEMPTS] if len(row) > COL_NDR_ATTEMPTS else "")
            unassigned.append((i + 2, order_date, bucket))

    if not unassigned:
        print("No unassigned NDR leads found - nothing to assign.")
        return

    # Oldest order first - a lead that's been waiting longest outranks a fresher one, the same
    # spirit as RTO's queue ordering without RTO's tier machinery.
    unassigned.sort(key=lambda t: t[1])

    needed = {email: max(0, quotas.get(email, DEFAULT_QUOTA) - current_load.get(email, 0))
              for email in online_agents}
    remaining_agents = [e for e in online_agents if needed[e] > 0]

    def _covers(email, bucket):
        filt = attempt_filters.get(email)
        return not filt or bucket is None or bucket in filt

    now = datetime.now(timezone.utc).isoformat()
    value_ranges = []
    assigned_count = {}
    no_agent_for_bucket = 0
    idx = 0
    for row_num, _, bucket in unassigned:
        if not remaining_agents:
            break
        n = len(remaining_agents)
        chosen = None
        for step in range(n):
            cand_idx = (idx + step) % n
            if _covers(remaining_agents[cand_idx], bucket):
                chosen = cand_idx
                break
        if chosen is None:
            # Every currently-eligible agent's attempt filter excludes this lead's bucket -
            # hard filter, so it's left unassigned rather than forced onto someone (same
            # contract as RTO's reassign_payment_mode).
            no_agent_for_bucket += 1
            continue
        email = remaining_agents[chosen]
        value_ranges.append({
            "range": f"'{SHEET_TAB}'!{COL_AGENT_LETTER}{row_num}:{COL_ASSIGNED_AT_LETTER}{row_num}",
            "values": [[email, now]],
        })
        assigned_count[email] = assigned_count.get(email, 0) + 1
        needed[email] -= 1
        if needed[email] <= 0:
            remaining_agents.pop(chosen)  # next lead lands on whoever shifted into this slot
            idx = chosen % max(len(remaining_agents), 1)
        else:
            idx = (chosen + 1) % len(remaining_agents)

    if not value_ranges:
        print(f"{len(unassigned)} unassigned lead(s) found, but none could be assigned "
              f"(quota exhausted or no online agent's attempt filter covers them). "
              f"Nothing to assign.")
        return

    for start in range(0, len(value_ranges), 300):
        lib.set_sheet_values_batch(SPREADSHEET_ID, value_ranges[start:start + 300])

    print(f"Assigned {len(value_ranges)} lead(s):")
    for email, count in sorted(assigned_count.items()):
        print(f"  {email}: +{count}")
    quota_skipped = len(unassigned) - len(value_ranges) - no_agent_for_bucket
    if quota_skipped > 0:
        print(f"  ({quota_skipped} unassigned lead(s) left over - all eligible agents at quota)")
    if no_agent_for_bucket > 0:
        print(f"  ({no_agent_for_bucket} unassigned lead(s) left over - no online agent's "
              f"attempt filter covers their bucket)")


if __name__ == "__main__":
    main()
