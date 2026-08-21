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
already-process-keyed availability tables (calling_agent_process, agent_presence - both MySQL
PEP_CLS, see fetch_online_ndr_agents) and the generic lib.py Sheets helpers both processes
already use.

A lead is "unassigned" iff Agent Name is blank - once a row leaves that state, this script
never touches it again, the same "never take back what's already handed out" contract RTO's
own assign_leads.py uses. current_load is read straight off the sheet (a count of rows
already carrying that agent's email in Agent Name) rather than a separate Postgres tally.
"""
from datetime import datetime, timedelta, timezone

import lib
import mysql_lib

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

# agent_presence lives in PEP_CLS, and this is passed EXPLICITLY to mysql_lib.query rather
# than inherited from MYSQL_DATABASE - the convention every other PEP_CLS reader in scripts/
# already follows (backfill_*, migrate_*, sync_delivery_tickets_to_sheet.py, kyc_source.py...).
# Inheriting it is a live trap: .env.local points MYSQL_DATABASE at mcaff_prod, so an
# unqualified read of this table raises 1142 "SELECT command denied" locally, which
# fetch_online_ndr_agents below fails open on - i.e. "nobody is online", silently, rather than
# an error anyone would notice. assign_leads.py's identical RTO read works today only because
# the assign-rto Lambda's own MYSQL_DATABASE happens to be PEP_CLS.
PRESENCE_SCHEMA = "PEP_CLS"

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
    marked Online for this process_key in calling_agent_process. A process with no
    per-process rows set yet falls back to global presence, matching the pre-per-process
    behaviour. attempt_filters is {email: [bucket, ...]} from attempt_count_filter,
    reason_filters is {email: [reason substring, ...]} (already lowercased) from
    ndr_reason_filter, payment_mode_filters/brand_filters are {email: value} from
    ndr_payment_mode_filter/ndr_brand_filter - an agent absent from any of these (or with an
    empty value) is unrestricted, same "absent means no restriction" contract as RTO's
    reassign_payment_mode.

    Both halves now live in the same MySQL PEP_CLS schema (calling_agent_process moved off
    Postgres alongside calling_business_hours - see
    migrate_calling_business_hours_and_agent_process_to_mysql.py) but still fail open
    INDEPENDENTLY, since agent_presence is the true fail-safe (no idea who's online without
    it) while a calling_agent_process-specific failure is a smaller blast radius (agents still
    get leads via global presence, just with no per-process quotas/filters applied)."""
    cred = mysql_lib.get_credential()
    if cred is None:
        print("MYSQL_* credentials not configured - cannot determine online agents.")
        return [], {}, {}, {}, {}, {}
    # Naive-but-UTC, matching every other DATETIME this app stores in MySQL (see
    # CLS_RTO_calling.assigned_at and db.js's own `new Date()` writes) - never SQL NOW(),
    # whose session time_zone this app does not control.
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=STALE_MINUTES)
    try:
        rows = mysql_lib.query(
            "SELECT email FROM agent_presence WHERE status = %s AND updated_at >= %s ORDER BY email",
            ("Online", cutoff),
            database=PRESENCE_SCHEMA,
        )
    except Exception as e:
        print(f"  (agent_presence lookup failed: {e} - treating as no agents online)")
        return [], {}, {}, {}, {}, {}
    present = {row[0].lower() for row in (rows or [])}

    try:
        per_process = mysql_lib.query(
            "SELECT email, status, max_quota, attempt_count_filter, ndr_reason_filter, "
            "ndr_payment_mode_filter, ndr_brand_filter "
            "FROM calling_agent_process WHERE process_key = %s",
            (PROCESS_KEY,),
            database=PRESENCE_SCHEMA,
        )
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
    """Mirrors each freshly-assigned (awb_number, email) into MySQL PEP_CLS.ndr_lead_assignments
    (moved off Postgres - see migrate_ndr_lead_assignments_to_mysql.py) - NDR's own equivalent
    of assign_leads.py's record_lead_assignments, a parallel write alongside the sheet, not a
    replacement (see api/_lib/db.js's claimNdrLead, which the Call modal's own claim-on-open
    path uses for the exact same table).

    Retires any existing live row for the same awb_number (stamping reassigned_away_at) BEFORE
    inserting the new one, in ONE transaction - same reasoning as assign_leads.py's own
    record_lead_assignments (see its docstring): splitting these across two connections risks
    landing the retire without the insert, leaving a lead with no live cycle at all - invisible
    to any reader, even though the sheet says it is assigned.

    Only one unique key is in play here (live_awb_number - see api/_lib/db.js's bootstrapSchema),
    unlike CLS_RTO_calling's two, so - unlike record_lead_assignments - there's no need to catch
    an IntegrityError and fall back to an UPDATE: retiring first always leaves the insert's
    target key open.

    Best-effort: a MySQL write failure here must never undo or block the sheet write that
    already succeeded - the sheet is what the CRM reads from, this is just history."""
    if not new_assignments:
        return
    cred = mysql_lib.get_credential()
    if cred is None:
        print("  (MYSQL_* credentials not configured - skipping ndr_lead_assignments write)")
        return
    import pymysql
    now = datetime.now(timezone.utc).replace(tzinfo=None)  # see fetch_current_assignment_times: stored naive-but-UTC
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=cred["database"], port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.executemany(
            "UPDATE ndr_lead_assignments SET reassigned_away_at = %s "
            "WHERE awb_number = %s AND reassigned_away_at IS NULL",
            [(now, awb) for awb, _email in new_assignments],
        )
        cur.executemany(
            "INSERT INTO ndr_lead_assignments (awb_number, email, assigned_at) VALUES (%s, %s, %s)",
            [(awb, email, now) for awb, email in new_assignments],
        )
        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"  (ndr_lead_assignments write failed: {e} - sheet assignment already stands)")
    finally:
        conn.close()


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
