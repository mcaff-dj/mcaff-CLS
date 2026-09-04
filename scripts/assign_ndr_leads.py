"""Step 2 of NDR Calling: spreads unassigned NDR leads across agents who are online for NDR
specifically, up to each agent's own NDR quota and respecting each agent's attempt-count filter
(see agent_attempt_filter below). Selection is scarcest-supply-first, then least-loaded - NOT a
pointer round-robin, which starved narrowly-filtered agents; see assign_for_run.

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

PER-TEAM ISOLATION (see docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md):
NDR can run as one shared desk (0 or 1 active calling_teams row - the state today) or as
several isolated teams (2+ active rows), each with its own agent pool and its own Google
Sheet. This module handles both without a separate code path for each: fetch_active_ndr_teams
decides the shape of the run, main() builds one "run" per active team (or one synthetic
pre-split run when there are none), and assign_for_run does the actual work against whichever
sheet/agent-pool that run was given. Below 2 active teams, isolation is deliberately OFF - an
agent's team_id is ignored entirely and every online agent is eligible, matching the same
"behaves exactly like before this feature until a second team is deliberately created"
softening the JS side (api/_lib/callingTeams.js's teamScopeFor) already uses. This is what
lets the DB migration, this script's deploy, and an admin creating the first team all land in
any order without a moment where the desk stops assigning.

One roster snapshot (fetch_online_ndr_agents) is read ONCE per run of this script, not once
per team: mysql_lib's shared connection never commits after a SELECT (autocommit is off and
query() only reads), so a second query() call inside the same run would still see the exact
same MVCC snapshot as the first - paying a fresh round trip for stale data. Reading once and
filtering per team in Python (see main()) sidesteps that entirely instead of trying to force a
fresh snapshot per team.
"""
from datetime import datetime, timedelta, timezone

import pymysql

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
    ...]}, {email: 'Prepaid'|'COD'}, {email: 'Hyphen'|'mCaffeine'}, {email: team_id or None}).
    Eligibility is the same intersection RTO's own fetch_online_agents uses: heartbeat-fresh in
    agent_presence AND marked Online for this process_key in calling_agent_process.
    attempt_filters is {email: [bucket, ...]} from attempt_count_filter, reason_filters is
    {email: [reason substring, ...]} (already lowercased) from ndr_reason_filter,
    payment_mode_filters/brand_filters are {email: value} from
    ndr_payment_mode_filter/ndr_brand_filter - an agent absent from any of these (or with an
    empty value) is unrestricted, same "absent means no restriction" contract as RTO's
    reassign_payment_mode. team_ids maps every agent who has a calling_agent_process row for
    this process to their team_id (None = not yet assigned to a team) - see main() for how
    that's used to split the eligible list per team.

    FAILS CLOSED on any problem reaching calling_agent_process - a dropped connection, a lock
    timeout, or genuinely zero rows for this process all return the same empty result, never a
    fallback to "every agent online for any reason, company-wide". That fallback used to exist
    here (matching what assign_leads.py's own comment calls "the pre-per-process behaviour",
    from before NDR tracked its own presence at all) but it was never sound on its own merits -
    it ignores this process's quotas and filters - and once a team's roster comes ONLY from
    this same table, falling back to "everyone online" would also erase every team boundary the
    moment this one query hiccups. An empty return here just means this run assigns nothing,
    which is safe and already how a real "nobody online" state is reported.

    Only agent_presence's own failure paths are exempt from that reasoning: it is the one true
    fail-safe (no idea who's at their desk without it), and it was already failing to empty,
    not to some broader fallback - unchanged here."""
    cred = mysql_lib.get_credential()
    if cred is None:
        print("MYSQL_* credentials not configured - cannot determine online agents.")
        return [], {}, {}, {}, {}, {}, {}
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
        return [], {}, {}, {}, {}, {}, {}
    present = {row[0].lower() for row in (rows or [])}

    try:
        per_process = mysql_lib.query(
            "SELECT email, status, max_quota, attempt_count_filter, ndr_reason_filter, "
            "ndr_payment_mode_filter, ndr_brand_filter, team_id "
            "FROM calling_agent_process WHERE process_key = %s",
            (PROCESS_KEY,),
            database=PRESENCE_SCHEMA,
        )
    except Exception as e:
        print(f"  (calling_agent_process unavailable: {e} - assigning nothing this run)")
        return [], {}, {}, {}, {}, {}, {}

    if not per_process:
        # Normal, not an error, for a brand-new team with no agents assigned yet - and equally
        # normal for the legacy desk before anyone has ever toggled Online for NDR specifically.
        print(f"  no per-process availability set for '{PROCESS_KEY}' - nothing to assign")
        return [], {}, {}, {}, {}, {}, {}

    online_for_process = {e.lower() for e, status, _, _, _, _, _, _ in per_process if status == "Online"}
    quotas = {e.lower(): q for e, _, q, _, _, _, _, _ in per_process if q is not None}
    attempt_filters = {}
    reason_filters = {}
    payment_mode_filters = {}
    brand_filters = {}
    team_ids = {}
    for e, _, _, filt, reason_filt, payment_mode_filt, brand_filt, team_id in per_process:
        key = e.lower()
        buckets = [b.strip() for b in (filt or "").split(",") if b.strip()]
        if buckets:
            attempt_filters[key] = buckets
        reasons = [r.strip().lower() for r in (reason_filt or "").split(",") if r.strip()]
        if reasons:
            reason_filters[key] = reasons
        if payment_mode_filt:
            payment_mode_filters[key] = payment_mode_filt.strip()
        if brand_filt:
            brand_filters[key] = brand_filt.strip()
        team_ids[key] = team_id
    eligible = sorted(online_for_process & present)
    if online_for_process and not eligible:
        print(f"  {len(online_for_process)} agent(s) marked Online for '{PROCESS_KEY}', but "
              f"none are heartbeat-fresh (within {STALE_MINUTES}m) - nobody is actually at "
              f"their desk.")
    return eligible, quotas, attempt_filters, reason_filters, payment_mode_filters, brand_filters, team_ids


def fetch_active_ndr_teams():
    """The process's ACTIVE calling_teams rows as [{"id","name","sheet_id","sheet_tab"}, ...],
    or None if the query itself could not run. None and [] are deliberately different signals:
    [] means "asked, and there are genuinely zero active teams right now" - the ordinary
    pre-split state - while None means "couldn't ask", which main() must never treat as [] or
    it would silently fall back to the single shared sheet even after teams exist, sending
    every team's leads to whichever sheet happens to be hardcoded here."""
    cred = mysql_lib.get_credential()
    if cred is None:
        print("MYSQL_* credentials not configured - cannot determine active NDR teams.")
        return None
    try:
        rows = mysql_lib.query(
            "SELECT id, name, sheet_id, sheet_tab FROM calling_teams "
            "WHERE process_key = %s AND active = TRUE ORDER BY id",
            (PROCESS_KEY,),
            database=PRESENCE_SCHEMA,
        )
    except Exception as e:
        print(f"  (calling_teams lookup failed: {e})")
        return None
    return [{"id": r[0], "name": r[1], "sheet_id": r[2], "sheet_tab": r[3]} for r in (rows or [])]


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

    Retiring first is meant to leave live_awb_number (the table's only unique key - see
    api/_lib/db.js's bootstrapSchema) free for the insert, but it is not a guarantee, so the
    insert still runs row-by-row with the same IntegrityError -> UPDATE fallback
    record_lead_assignments has. Two ways the retire can miss and the insert then collide:
    the stored awb_number differs from the sheet's string (stray apostrophe/whitespace, or a
    numeric AWB that came back from Sheets as "5.4E+13" - see api/_lib/rtoCsvImport.js for that
    exact failure on the RTO side), or the same AWB appears on two sheet rows in ONE batch. The
    duplicate-within-a-batch case is removed outright by deduping below - the NDR sheet really
    does carry repeated AWBs (358 of them as of 2026-08-25) - but a batch-wide rollback over one
    unmatched row is exactly how this write went 4 days recording nothing, so the remaining
    collision is absorbed per row rather than allowed to discard the whole batch.

    database is pinned to PRESENCE_SCHEMA, not inherited from MYSQL_DATABASE - same reason as
    every mysql_lib.query call in this file, see PRESENCE_SCHEMA's own comment.

    Returns True on success, False if the write failed. Still best-effort in the sense that it
    never raises here and never undoes the sheet write that already succeeded - but main() DOES
    fail the run on a False, after printing its summary. Swallowing it entirely is what let this
    stop writing on 2026-08-21 and go unnoticed until agents complained: the sheet kept being
    assigned correctly while every reader of this table (the CRM's Agent Performance Summary,
    /api/auth/leadDates?process=ndr) stayed frozen."""
    if not new_assignments:
        return True
    cred = mysql_lib.get_credential()
    if cred is None:
        print("  (MYSQL_* credentials not configured - skipping ndr_lead_assignments write)")
        return True
    now = datetime.now(timezone.utc).replace(tzinfo=None)  # see fetch_current_assignment_times: stored naive-but-UTC
    # Last agent wins for a repeated AWB, matching the sheet: the later row's Agent Name write
    # is the one an agent sees, and only one live row per AWB can exist anyway.
    batch = list({awb: email for awb, email in new_assignments}.items())
    conn = None
    try:
        # Inside the try, unlike before: a connect failure used to propagate out of here and
        # kill main() straight after the sheet write, losing even the "Assigned N lead(s)"
        # summary of what had just been handed out.
        conn = pymysql.connect(
            host=cred["host"], user=cred["user"], password=cred["password"],
            database=PRESENCE_SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        )
        cur = conn.cursor()
        cur.executemany(
            "UPDATE ndr_lead_assignments SET reassigned_away_at = %s "
            "WHERE awb_number = %s AND reassigned_away_at IS NULL",
            [(now, awb) for awb, _email in batch],
        )
        for awb, email in batch:
            try:
                cur.execute(
                    "INSERT INTO ndr_lead_assignments (awb_number, email, assigned_at) "
                    "VALUES (%s, %s, %s)",
                    (awb, email, now),
                )
            except pymysql.err.IntegrityError as e:
                if "ndr_lead_assignments_live_awb_key" not in str(e):
                    raise  # not this AWB's own live row - a real error, don't paper over it
                cur.execute(
                    "UPDATE ndr_lead_assignments SET email = %s, assigned_at = %s "
                    "WHERE awb_number = %s AND reassigned_away_at IS NULL",
                    (email, now, awb),
                )
        conn.commit()
        return True
    except Exception as e:
        if conn is not None:
            conn.rollback()
        print(f"  !! ndr_lead_assignments write FAILED for {len(batch)} lead(s): {e}")
        print("     (the sheet assignment above already stands - this is the history mirror only)")
        return False
    finally:
        if conn is not None:
            conn.close()


def assign_for_run(run, online_agents, quotas, attempt_filters, reason_filters,
                    payment_mode_filters, brand_filters):
    """Does the actual round-robin for ONE run - either the whole desk (isolation off, `run`
    is the synthetic pre-split/single-team entry main() builds) or one isolated team (isolation
    on). `online_agents` is already filtered to exactly the agents eligible for THIS run before
    this function ever sees them - it has no team concept of its own, so a caller mistake there
    would show up here as leads going to the wrong pool with no further check. Raises on a
    mirror-write failure (see the bottom of this function); main() decides per-run whether that
    stops the whole invocation or just this one team."""
    sheet_id = run["sheet_id"]
    sheet_tab = run["sheet_tab"]
    label = run["name"]

    sheet_rows = lib.get_sheet_values(sheet_id, f"'{sheet_tab}'!A2:{LAST_COL}1000000")

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
        print(f"[{label}] No unassigned NDR leads found - nothing to assign.")
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

    def _eligible(email, bucket, reason, payment_mode, brand):
        """Can this lead be given to this agent at all - all four filters at once. Mirrors
        ndrFiltersCoverLead in app/ndr-calling/NdrCallingClient.js, which the roster's own
        "how many leads does this filter even cover" number is computed with."""
        return (_covers(email, bucket)
                and reason_covers(reason_filters.get(email), reason)
                and payment_mode_covers(payment_mode_filters.get(email), payment_mode)
                and brand_covers(brand_filters.get(email), brand))

    # supply[email] = how many of THIS run's unassigned leads that agent's filters cover at all.
    # This is what makes the selection below starvation-free, and it is why the old pointer
    # round-robin had to go: it took the first agent from a rotating index whose filters covered
    # the lead, so an unrestricted agent absorbed leads that a narrowly-filtered agent was the
    # only one who actually needed them. With oldest-first ordering putting a filtered agent's
    # leads at the FRONT of the queue, that reliably handed them away before the pointer ever
    # reached her - an agent with a reason filter covering 4 of 20 leads landed 1 of them
    # alongside four unrestricted colleagues (see test_assign_for_run_does_not_starve_a_filtered
    # _agent). Nobody could see it happening either: the run only ever printed who DID get leads.
    supply = {email: 0 for email in online_agents}
    for _, _, bucket, reason, payment_mode, brand, _ in unassigned:
        for email in online_agents:
            if _eligible(email, bucket, reason, payment_mode, brand):
                supply[email] += 1

    value_ranges = []
    new_assignments = []  # (awb_number, email) - mirrored into Postgres after the sheet write
    assigned_count = {}
    no_agent_for_bucket = 0
    for row_num, _, bucket, reason, payment_mode, brand, awb in unassigned:
        if not remaining_agents:
            break
        candidates = [e for e in remaining_agents
                      if _eligible(e, bucket, reason, payment_mode, brand)]
        if not candidates:
            # Every currently-eligible agent's attempt/reason/payment-mode/brand filter excludes
            # this lead - hard filter, so it's left unassigned rather than forced onto someone
            # (same contract as RTO's reassign_payment_mode).
            no_agent_for_bucket += 1
            continue
        # Scarcest supply first, then least-loaded, then email for a stable tie-break. The
        # second key is what replaces the pointer: with nobody filtered, every candidate has the
        # same supply, so "most remaining quota wins" IS round-robin (and respects unequal
        # quotas, which the pointer did not) - see
        # test_assign_for_run_spreads_evenly_when_nobody_is_filtered.
        # ponytail: greedy scarcest-first, not an optimal bipartite matching. It cannot starve
        # anyone the way the pointer did, but a pathological overlap of several narrow filters
        # can still leave a lead unassigned that a full matching would have placed. Revisit only
        # if that ever shows up as a real leftover count.
        email = min(candidates, key=lambda e: (supply[e], -needed[e], e))
        value_ranges.append({
            "range": f"'{sheet_tab}'!{COL_AGENT_LETTER}{row_num}",
            "values": [[email]],
        })
        new_assignments.append((awb, email))
        assigned_count[email] = assigned_count.get(email, 0) + 1
        needed[email] -= 1
        if needed[email] <= 0:
            remaining_agents.remove(email)

    if not value_ranges:
        print(f"[{label}] {len(unassigned)} unassigned lead(s) found, but none could be assigned "
              f"(quota exhausted, or no online agent's filters cover them). "
              f"Nothing to assign.")
        return

    for start in range(0, len(value_ranges), 300):
        lib.set_sheet_values_batch(sheet_id, value_ranges[start:start + 300])

    # record_new_assignments opens and commits its OWN connection per call (see its own
    # docstring) - calling it once per run already gives every team's mirror write its own
    # transaction, with no extra plumbing needed here for that.
    mirrored = record_new_assignments(new_assignments)

    print(f"[{label}] Assigned {len(value_ranges)} lead(s):")
    for email, count in sorted(assigned_count.items()):
        print(f"  {email}: +{count}")
    # Every online agent who got NOTHING, with the reason - the run used to print only who did
    # get leads, so "why am I not being assigned anything?" had no answer anywhere in the logs
    # and each report cost a manual dig through calling_agent_process and the sheet.
    for email in sorted(online_agents):
        if assigned_count.get(email):
            continue
        if supply[email] == 0:
            why = "no unassigned lead in this run matches this agent's filters"
        elif needed[email] <= 0:
            why = (f"already at quota - {current_load.get(email, 0)} open (undisposed) lead(s) "
                   f"vs a quota of {quotas.get(email, DEFAULT_QUOTA)}")
        else:
            why = (f"the {supply[email]} coverable lead(s) all went to agents with a narrower "
                   f"filter or less work")
        print(f"  {email}: +0 - {why}")
    quota_skipped = len(unassigned) - len(value_ranges) - no_agent_for_bucket
    if quota_skipped > 0:
        print(f"  ({quota_skipped} unassigned lead(s) left over - all eligible agents at quota)")
    if no_agent_for_bucket > 0:
        print(f"  ({no_agent_for_bucket} unassigned lead(s) left over - no online agent's "
              f"filters cover them)")

    # Deliberately AFTER the summary above, and deliberately fatal: the sheet write already
    # stands and the run's real work is reported, but the invocation has to go red so the
    # failure surfaces (Lambda error metric / a red workflow run) instead of scrolling past in
    # logs nobody reads. That is exactly how the 2026-08-21 mirror break survived 4 days. main()
    # catches this per run so one team's mirror failure never stops another team's assignment.
    if not mirrored:
        raise RuntimeError(
            f"[{label}] {len(value_ranges)} lead(s) were assigned in the sheet but NOT mirrored "
            f"into ndr_lead_assignments - see the error above. Sheet is correct; NDR reporting "
            f"(Agent Performance Summary, /api/auth/leadDates?process=ndr) is now behind."
        )


def main():
    teams = fetch_active_ndr_teams()
    if teams is None:
        # Could not even determine whether the desk is split - see fetch_active_ndr_teams'
        # own docstring for why this must never be treated as "no teams" and fall back to the
        # single shared sheet. Raise straight away (nothing has run yet, nothing to summarize).
        raise RuntimeError(
            "Could not determine NDR's active teams (calling_teams query failed) - refusing to "
            "guess whether the desk is split. See the error printed above."
        )

    online_agents, quotas, attempt_filters, reason_filters, payment_mode_filters, brand_filters, team_ids = \
        fetch_online_ndr_agents()
    if not online_agents:
        print("No agents online for NDR right now - nothing to assign.")
        return

    isolation_on = len(teams) >= 2
    if not teams:
        # Pre-split: the desk hasn't been given a second team yet. Behaves exactly as this
        # script always has, against the one sheet that predates this feature entirely.
        runs = [{"id": None, "name": "NDR", "sheet_id": SPREADSHEET_ID, "sheet_tab": SHEET_TAB}]
    elif len(teams) == 1:
        # Isolation is still OFF below 2 active teams (same activeTeamCount < 2 rule the JS
        # side's teamScopeFor uses) - every online agent is still eligible regardless of
        # team_id. The SHEET, though, is already authoritative from calling_teams rather than
        # the hardcoded constant, so an admin can repoint the desk's sheet from the UI without
        # a deploy even before a second team exists.
        runs = [teams[0]]
    else:
        runs = teams

    if isolation_on:
        # Correct (see the fail-closed note below), but it used to happen in total silence:
        # the agent simply never appeared in any team's run and no line said why.
        orphans = [e for e in online_agents if team_ids.get(e) is None]
        if orphans:
            print(f"  {len(orphans)} online agent(s) have no team assigned and so get nothing "
                  f"while {len(teams)} teams are active: {', '.join(sorted(orphans))}")

    failures = []
    for run in runs:
        if isolation_on:
            # Only agents EXPLICITLY assigned to this team are eligible - an unassigned agent
            # (team_id None) gets nothing from any team once there is more than one to choose
            # between, matching the fail-closed policy the JS side already enforces for the
            # exact same ambiguity.
            run_agents = [e for e in online_agents if team_ids.get(e) == run["id"]]
        else:
            run_agents = online_agents
        if not run_agents:
            print(f"[{run['name']}] No eligible agents online right now.")
            continue
        try:
            assign_for_run(run, run_agents, quotas, attempt_filters, reason_filters,
                            payment_mode_filters, brand_filters)
        except Exception as e:
            print(f"!! [{run['name']}] run failed: {e}")
            failures.append((run["name"], e))

    if failures:
        raise RuntimeError(
            f"{len(failures)}/{len(runs)} NDR run(s) failed: "
            + "; ".join(f"{name}: {err}" for name, err in failures)
        )


if __name__ == "__main__":
    main()
