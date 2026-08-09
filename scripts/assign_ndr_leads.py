"""Step 2 of NDR Calling: round-robins unassigned NDR leads across agents who are online for
NDR specifically, up to each agent's own NDR quota and respecting each agent's attempt-count
filter (see agent_attempt_filter below).

The lead source is NOT ours - it's an already-existing, actively-used spreadsheet ("NDR
Calling - June") that some other CS/ops process already reads and writes (Agent Name,
Connected, Cs Action Remark, Remarks, Final_status, etc. are all already in use there before
this script ever touched it). This script only ever writes ONE column - Agent Name - never
any of the others; see the module-level comments in app/rto-crm/RtoCrmClient.js's
saveNdrDisposition for the (separate) three columns the Call modal's disposition-save writes.

Deliberately independent of scripts/assign_leads.py and scripts/lead_priority.py - NDR's rules
are simpler and diverge from RTO's, so nothing here is shared with RTO beyond the generic,
already-process-keyed Postgres tables (calling_agent_process, agent_presence) and the generic
lib.py Sheets helpers both processes already use.

A lead is "unassigned" iff Agent Name is blank - once a row leaves that state, this script
never touches it again, the same "never take back what's already handed out" contract RTO's
own assign_leads.py uses. current_load is read straight off the sheet (a count of rows
already carrying that agent's email in Agent Name) rather than a separate Postgres tally.
"""
import os
from datetime import datetime

import psycopg

import lib

PROCESS_KEY = "ndr"
SPREADSHEET_ID = "12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI"
SHEET_TAB = "Latest NDR "  # trailing space is part of the real tab name - do not trim it

# 0-based column indices in this sheet - see the module docstring above: this is someone
# else's existing sheet, not ours, so these are fixed positions, not derived from a source
# schema. Only COL_AGENT is ever written by this script.
COL_ORDER_ID = 0             # A - source for brand_of (no dedicated Brand column exists)
COL_AWB = 4                  # E
COL_PAYMENT_MODE = 11        # L - "Prepaid"/"COD", matched by agent_payment_mode_filter
COL_ATTEMPTS = 14            # O - Attempt Count
COL_LATEST_NDR_DATE = 15     # P - "DD-MM-YYYY", the round-robin's oldest-first sort key
COL_LATEST_NDR_REASON = 16   # Q - free-text courier NDR reason, matched by agent_reason_filter
COL_AGENT = 18               # S - Agent Name - the only column this script writes
COL_CONNECTED = 19           # T - blank until NdrCallingClient.js's saveNdrDisposition writes
                              # it; read-only here, needed to tell an agent's still-OPEN leads
                              # apart from ones they've already disposed (see current_load below)
COL_AGENT_LETTER = lib.get_column_letter(COL_AGENT)  # "S"
LAST_COL = lib.get_column_letter(COL_CONNECTED)  # "T"

STALE_MINUTES = 10  # must match the CRM's own heartbeat cadence - same convention as RTO's
DEFAULT_QUOTA = 20  # NDR's own fallback, independent of RTO's leadAssignmentRules.json value

ATTEMPT_BUCKETS = ("1", "2", "3", "More than 3")


def attempt_bucket(raw):
    """Attempt Count (a sheet cell, string) -> one of ATTEMPT_BUCKETS, or None if it can't be
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


def reason_covers(filt, latest_ndr_reason):
    """True if this agent's reason filter (a list of substrings, already lowercased) allows a
    lead with this Latest NDR Reason. An empty/absent filter is unrestricted (fails open), same
    contract as attempt_bucket's ATTEMPT_BUCKETS check below - but once a filter IS set, a
    blank/unreadable reason does NOT fail open (it simply matches no substring), unlike an
    unparseable attempt count."""
    if not filt:
        return True
    reason = str(latest_ndr_reason or "").lower()
    return any(r in reason for r in filt)


def payment_mode_covers(filt, payment_mode):
    """True if this agent's payment-mode filter ('Prepaid'/'COD', or None/absent = unrestricted)
    allows a lead with this Payment Mode. Exact, case-insensitive match - a fixed, controlled
    value set, unlike reason_covers' free-text substrings above."""
    if not filt:
        return True
    return str(payment_mode or "").strip().lower() == filt.lower()


def brand_of(order_id):
    """Order ID -> 'Hyphen' if it starts with "HYP" (case-insensitive), else 'mCaffeine' - Brand
    has no sheet column of its own, so this is the only source of truth for it, mirrored exactly
    in app/ndr-calling/NdrCallingClient.js's own brandOf."""
    return "Hyphen" if str(order_id or "").upper().startswith("HYP") else "mCaffeine"


def brand_covers(filt, brand):
    """True if this agent's brand filter ('Hyphen'/'mCaffeine', or None/absent = unrestricted)
    allows a lead of this brand. brand_of always returns one of exactly those two strings, so a
    plain equality check is enough - no case-folding needed."""
    if not filt:
        return True
    return brand == filt


def parse_latest_ndr_date(raw):
    """'DD-MM-YYYY' -> datetime, or None if unparseable - sorts to the end (oldest-first
    means an undated lead never jumps the queue, the same "undated sorts last" convention
    used elsewhere in this codebase, e.g. lead_priority.py's parse_rto_initiated_date)."""
    try:
        return datetime.strptime(str(raw).strip(), "%d-%m-%Y")
    except (TypeError, ValueError):
        return None


def fetch_online_ndr_agents():
    """([email, ...] eligible now, {email: max_quota}, {email: [bucket, ...]}, {email: [reason,
    ...]}, {email: 'Prepaid'|'COD'}, {email: 'Hyphen'|'mCaffeine'}). Eligibility is the same
    intersection RTO's own fetch_online_agents uses: heartbeat-fresh in agent_presence AND
    marked Online for this process_key in calling_agent_process. A process with no per-process
    rows set yet falls back to global presence, matching the pre-per-process behaviour.
    attempt_filters is {email: [bucket, ...]} from attempt_count_filter, reason_filters is
    {email: [reason substring, ...]} (already lowercased) from ndr_reason_filter,
    payment_mode_filters/brand_filters are {email: value} from ndr_payment_mode_filter/
    ndr_brand_filter - an agent absent from any of these (or with an empty value) is
    unrestricted, same "absent means no restriction" contract as RTO's reassign_payment_mode.
    Returns ([], {}, {}, {}, {}, {}) if POSTGRES_URL isn't configured, so a missing secret fails
    safe - no assignment, not a crash."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        print("POSTGRES_URL not configured - cannot determine online agents.")
        return [], {}, {}, {}, {}, {}
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
                    "SELECT email, status, max_quota, attempt_count_filter, ndr_reason_filter, "
                    "ndr_payment_mode_filter, ndr_brand_filter "
                    "FROM calling_agent_process WHERE process_key = %s",
                    (PROCESS_KEY,),
                )
                per_process = cur.fetchall()
            except Exception as e:
                print(f"  (calling_agent_process unavailable: {e} - using global presence)")
                return sorted(present), {}, {}, {}, {}, {}

    if not per_process:
        print(f"  no per-process availability set for '{PROCESS_KEY}' - using global presence")
        return sorted(present), {}, {}, {}, {}, {}

    online_for_process = {e.lower() for e, status, _, _, _, _, _ in per_process if status == "Online"}
    quotas = {e.lower(): q for e, _, q, _, _, _, _ in per_process if q is not None}
    attempt_filters = {}
    reason_filters = {}
    payment_mode_filters = {}
    brand_filters = {}
    for e, _, _, filt, reason_filt, payment_mode_filt, brand_filt in per_process:
        buckets = [b.strip() for b in (filt or "").split(",") if b.strip()]
        if buckets:
            attempt_filters[e.lower()] = buckets
        reasons = [r.strip().lower() for r in (reason_filt or "").split(",") if r.strip()]
        if reasons:
            reason_filters[e.lower()] = reasons
        if payment_mode_filt:
            payment_mode_filters[e.lower()] = payment_mode_filt.strip()
        if brand_filt:
            brand_filters[e.lower()] = brand_filt.strip()
    eligible = sorted(online_for_process & present)
    if online_for_process and not eligible:
        print(f"  {len(online_for_process)} agent(s) marked Online for '{PROCESS_KEY}', but "
              f"none are heartbeat-fresh (within {STALE_MINUTES}m) - nobody is actually at "
              f"their desk.")
    return eligible, quotas, attempt_filters, reason_filters, payment_mode_filters, brand_filters


def record_new_assignments(new_assignments):
    """Mirrors each freshly-assigned (awb_number, email) into Postgres ndr_lead_assignments -
    NDR's own equivalent of assign_leads.py's record_lead_assignments, a parallel write
    alongside the sheet, not a replacement (see api/_lib/db.js's claimNdrLead, which the Call
    modal's own claim-on-open path uses for the exact same table). ON CONFLICT targets the
    partial unique index on (awb_number) WHERE reassigned_away_at IS NULL, so this is a safe
    no-op for an awb somehow already claimed. Best-effort: a Postgres write failure here must
    never undo or block the sheet write that already succeeded - the sheet is what the CRM
    reads from, this is just history."""
    if not new_assignments:
        return
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        print("  (POSTGRES_URL not configured - skipping ndr_lead_assignments write)")
        return
    try:
        with psycopg.connect(conn_str) as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO ndr_lead_assignments (awb_number, email)
                    VALUES (%s, %s)
                    ON CONFLICT (awb_number) WHERE reassigned_away_at IS NULL DO NOTHING
                    """,
                    new_assignments,
                )
            conn.commit()
    except Exception as e:
        print(f"  (ndr_lead_assignments write failed: {e} - sheet assignment already stands)")


def main():
    online_agents, quotas, attempt_filters, reason_filters, payment_mode_filters, brand_filters = fetch_online_ndr_agents()
    if not online_agents:
        print("No agents online for NDR right now - nothing to assign.")
        return

    sheet_rows = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:{LAST_COL}1000000")

    current_load = {email: 0 for email in online_agents}
    unassigned = []  # (row_number, latest_ndr_date, attempt_bucket, latest_ndr_reason,
                      #  payment_mode, brand, awb_number)
    for i, row in enumerate(sheet_rows):
        agent = row[COL_AGENT].strip().lower() if len(row) > COL_AGENT and row[COL_AGENT] else ""
        if agent:
            # A disposed lead (Connected already has a value - the same signal
            # NdrCallingClient.js treats as "worked") must NOT count toward the agent's
            # quota, or finishing a batch would permanently cap them at zero new leads for
            # the rest of their tenure - this was exactly that bug: quota is a concurrent-
            # workload cap, not a lifetime total, same as assign_leads.py's own current_load.
            connected = row[COL_CONNECTED].strip() if len(row) > COL_CONNECTED and row[COL_CONNECTED] else ""
            if not connected and agent in current_load:
                current_load[agent] += 1
        else:
            latest_ndr_date = parse_latest_ndr_date(row[COL_LATEST_NDR_DATE] if len(row) > COL_LATEST_NDR_DATE else "")
            bucket = attempt_bucket(row[COL_ATTEMPTS] if len(row) > COL_ATTEMPTS else "")
            reason = row[COL_LATEST_NDR_REASON] if len(row) > COL_LATEST_NDR_REASON else ""
            payment_mode = row[COL_PAYMENT_MODE] if len(row) > COL_PAYMENT_MODE else ""
            brand = brand_of(row[COL_ORDER_ID] if len(row) > COL_ORDER_ID else "")
            awb = row[COL_AWB] if len(row) > COL_AWB else ""
            if awb:
                unassigned.append((i + 2, latest_ndr_date, bucket, reason, payment_mode, brand, awb))

    if not unassigned:
        print("No unassigned NDR leads found - nothing to assign.")
        return

    # Oldest Latest NDR Date first (undated leads sort last) - a lead that's been waiting
    # longest outranks a fresher one, the same spirit as RTO's queue ordering without RTO's
    # tier machinery.
    EPOCH_MAX = datetime.max
    unassigned.sort(key=lambda t: t[1] if t[1] is not None else EPOCH_MAX)

    needed = {email: max(0, quotas.get(email, DEFAULT_QUOTA) - current_load.get(email, 0))
              for email in online_agents}
    remaining_agents = [e for e in online_agents if needed[e] > 0]

    def _covers(email, bucket):
        filt = attempt_filters.get(email)
        return not filt or bucket is None or bucket in filt

    value_ranges = []
    new_assignments = []  # (awb_number, email) - mirrored into Postgres after the sheet write
    assigned_count = {}
    no_agent_for_bucket = 0
    idx = 0
    for row_num, _, bucket, reason, payment_mode, brand, awb in unassigned:
        if not remaining_agents:
            break
        n = len(remaining_agents)
        chosen = None
        for step in range(n):
            cand_idx = (idx + step) % n
            candidate = remaining_agents[cand_idx]
            if (_covers(candidate, bucket) and reason_covers(reason_filters.get(candidate), reason)
                    and payment_mode_covers(payment_mode_filters.get(candidate), payment_mode)
                    and brand_covers(brand_filters.get(candidate), brand)):
                chosen = cand_idx
                break
        if chosen is None:
            # Every currently-eligible agent's attempt/reason/payment-mode/brand filter excludes
            # this lead - hard filter, so it's left unassigned rather than forced onto someone
            # (same contract as RTO's reassign_payment_mode).
            no_agent_for_bucket += 1
            continue
        email = remaining_agents[chosen]
        value_ranges.append({
            "range": f"'{SHEET_TAB}'!{COL_AGENT_LETTER}{row_num}",
            "values": [[email]],
        })
        new_assignments.append((awb, email))
        assigned_count[email] = assigned_count.get(email, 0) + 1
        needed[email] -= 1
        if needed[email] <= 0:
            remaining_agents.pop(chosen)  # next lead lands on whoever shifted into this slot
            idx = chosen % max(len(remaining_agents), 1)
        else:
            idx = (chosen + 1) % len(remaining_agents)

    if not value_ranges:
        print(f"{len(unassigned)} unassigned lead(s) found, but none could be assigned "
              f"(quota exhausted, or no online agent's filters cover them). "
              f"Nothing to assign.")
        return

    for start in range(0, len(value_ranges), 300):
        lib.set_sheet_values_batch(SPREADSHEET_ID, value_ranges[start:start + 300])

    record_new_assignments(new_assignments)

    print(f"Assigned {len(value_ranges)} lead(s):")
    for email, count in sorted(assigned_count.items()):
        print(f"  {email}: +{count}")
    quota_skipped = len(unassigned) - len(value_ranges) - no_agent_for_bucket
    if quota_skipped > 0:
        print(f"  ({quota_skipped} unassigned lead(s) left over - all eligible agents at quota)")
    if no_agent_for_bucket > 0:
        print(f"  ({no_agent_for_bucket} unassigned lead(s) left over - no online agent's "
              f"filters cover them)")


if __name__ == "__main__":
    main()
