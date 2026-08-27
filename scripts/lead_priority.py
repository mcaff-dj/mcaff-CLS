"""Shared RTO lead sheet semantics: column layout, date parsing, and
priority-tier/assignment logic.

Extracted out of assign_leads.py so both the assignment-writer cron job and
rto_crm_app's ticket mapper / "Next to Assign" preview import the exact same
constants and functions.

The reason lists, per-agent quota and AWB prefix rules are no longer defined here at all -
they load from api/_lib/leadAssignmentRules.json, which app/rto-crm/RtoCrmClient.js and
api/_lib/db.js read too. Those values used to be hand-copied between this file and the JS,
and had already drifted (this file's quota was 20 while the CRM preview used 10, so the
preview predicted assignments for half the real quota). The tier ordering and the
round-robin below are still Python's own implementation - Python can't execute the JS one -
but they're driven entirely by that shared file, so changing a reason or the quota needs no
code change on either side.
"""
import json
from pathlib import Path

_RULES_PATH = Path(__file__).resolve().parent.parent / "api" / "_lib" / "leadAssignmentRules.json"
with open(_RULES_PATH, "r", encoding="utf-8") as _f:
    _RULES = json.load(_f)

# 0-based column indices in the 'Data' tab, matching rto-crm.html's
# mapTkt/writeToSheetRow exactly.
COL_RTO_INITIATED_DATE = 1  # B - "DD-MM-YYYY HH:MM", e.g. "19-07-2026 07:40" - the
                          # assignment-queue sort key (NOT Calling Date - see
                          # parse_rto_initiated_date)
COL_RTO_REASON = 3        # D - the ORIGINAL system/courier RTO reason (not the agent's own
                          # disposition in COL_DISPOSITION below)
COL_ORDER_ID = 4          # E
COL_AWB_CODE = 6          # G
COL_ADDRESS_CITY = 11     # L
COL_ADDRESS_STATE = 12    # M
COL_ADDRESS_PINCODE = 13  # N
COL_PAYMENT_METHOD = 14   # O
COL_AGENT = 16            # Q
COL_CONNECTED = 17        # R
COL_ATTEMPT = 18          # S
COL_DISPOSITION = 19      # T - agent's own "RTO Reason - Agent" disposition entry
COL_REMARKS = 25          # Z - " Remark", the sheet's actual agent-remarks column.
# U is "New product needed", NOT remarks - but writeToSheetRow wrote agent remarks there for a
# long time, so ~645 rows carry remark text ("Already placed", "[Already Refunded]", "NA") in
# U. Kept as a separate constant so the disposed-lead check in assign_leads.py can still see
# that history: treating those rows as un-worked would put already-called customers back in
# the assignment queue.
COL_REMARKS_LEGACY_U = 20  # U
COL_NEW_ORDER_ID = 21     # V
COL_NEW_ADDRESS = 23      # X
COL_CALLING_DATE = 24     # Y

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
)}

# Delivery partner from an AWB code's prefix. Shared with api/_lib/db.js's
# resolvePartnerFromAwb (used for leads recorded via the disposal path) - see
# leadAssignmentRules.json's own notes.
PREFIX_RULES = [tuple(rule) for rule in _RULES["awbPrefixRules"]]


def prefix_rule_partner(awb):
    awb = (awb or "").strip()
    if not awb:
        return ""
    for prefix, partner in PREFIX_RULES:
        if awb.startswith(prefix):
            return partner
    return ""


def cell(row, idx):
    return row[idx].strip() if idx < len(row) and row[idx] else ""


def parse_calling_date(s):
    """Best-effort parse of the sheet's "23 Jul" / "23 Jul 2026" style calling
    date into a sortable value. Returns None if unparseable - those tickets sort
    last (oldest) so a bad date never jumps the queue."""
    if not s:
        return None
    parts = s.strip().split()
    if len(parts) < 2:
        return None
    try:
        day = int(parts[0])
    except ValueError:
        return None
    month = MONTHS.get(parts[1].lower()[:3])
    if not month:
        return None
    from datetime import datetime
    year = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else datetime.now().year
    try:
        return datetime(year, month, day)
    except ValueError:
        return None


def parse_rto_initiated_date(s):
    """Parse the sheet's "RTO Initiated Date" column (format "DD-MM-YYYY HH:MM",
    e.g. "19-07-2026 07:40"; a bare "DD-MM-YYYY" is also accepted) into a sortable
    value. Returns None if unparseable/blank - those tickets sort last (oldest) so
    a bad date never jumps the queue."""
    if not s:
        return None
    from datetime import datetime
    for fmt in ("%d-%m-%Y %H:%M", "%d-%m-%Y"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


# Assignment priority, highest first:
#   0. Prepaid orders - payment method wins outright, regardless of RTO reason.
#   1. COD orders whose original RTO reason matches one of these (case-insensitive
#      substring) - the consignee has already refused/OTP-verified the cancellation, so
#      the outcome is effectively known and worth acting on quickly.
#   2. Every other COD order.
#   3. COD orders matching LOW_PRIORITY_COD_RTO_REASONS - pushed to the back of the
#      queue on purpose (see that list's docstring).
# Within each tier, newest RTO Initiated Date first (see parse_rto_initiated_date -
# NOT Calling Date, which is when the agent called, not when the RTO itself started).
HIGH_PRIORITY_COD_RTO_REASONS = _RULES["highPriorityCodRtoReasons"]

# Deliberately lowest priority (tier 3, behind even "every other COD order") -
# these OTP outcomes are handled last in the assignment queue.
LOW_PRIORITY_COD_RTO_REASONS = _RULES["lowPriorityCodRtoReasons"]

DEFAULT_QUOTA = _RULES["assignmentQuota"]

# Connected=No reassignment - shared with the JS "Next to Assign" preview so none of these can
# drift between them the way DEFAULT_QUOTA once did. See leadAssignmentRules.json's
# _reassignNote for what these mean.
from datetime import datetime as _datetime
REASSIGN_BACKLOG_CUTOFF = _datetime.strptime(_RULES["reassignBacklogCutoff"], "%Y-%m-%d")
REASSIGN_RETRY_CAP = _RULES["reassignRetryCap"]
REASSIGN_MIN_HOLD_HOURS = _RULES["reassignMinHoldHours"]
REASSIGN_RESERVE_PER_AGENT = _RULES["reassignReservePerAgent"]


def is_prepaid(payment_raw):
    """Same rule as rto-crm.html's mapTkt: explicit prepaid-like keywords, OR - since payment
    method text varies a lot across sources - anything that isn't explicitly COD/Cash defaults
    to Prepaid."""
    p = (payment_raw or "").upper()
    if "COD" in p or "CASH" in p:
        return False
    return True


def priority_tier(payment_raw, rto_reason_raw):
    """0 = Prepaid (always highest, irrespective of reason), 1 = COD matching one of the
    high-priority reasons, 2 = every other COD lead, 3 = COD matching one of the
    low-priority reasons (lowest). Lower sorts first."""
    if is_prepaid(payment_raw):
        return 0
    reason = (rto_reason_raw or "").lower()
    if any(r in reason for r in LOW_PRIORITY_COD_RTO_REASONS):
        return 3
    if any(r in reason for r in HIGH_PRIORITY_COD_RTO_REASONS):
        return 1
    return 2


def build_assignment_queue(unassigned_pending, online_agents, current_load, quota=DEFAULT_QUOTA,
                            excluded_by_row=None, rto_reason_by_row=None,
                            agent_specializations=None, agent_prepaid_target=None,
                            agent_reassign_payment_mode=None,
                            reassign_reserve_per_agent=REASSIGN_RESERVE_PER_AGENT):
    """Round-robins a pool of unassigned pending leads across online agents up to
    `quota` each, based on each agent's current load. Pure/side-effect-free -
    callers decide whether to actually write the result (assign_leads.py) or
    just display it (rto_crm_app's Next to Assign preview); both call this same
    function so the preview can never drift from what the real writer would do.

    unassigned_pending: list of (row_index, rto_initiated_date, order_id, tier) tuples,
    NOT yet sorted - this function sorts them: fresh/never-touched leads first (ALL of them,
    regardless of tier), THEN reassignments (any row_index in excluded_by_row), and within
    each of those two groups, tier asc then rto_initiated_date desc (undated leads sort last
    within their tier). A lead nobody has ever called always outranks one that's already been
    tried and failed - reassignments only get a look once the fresh pool is fully exhausted.
    online_agents: list of agent emails eligible to receive leads this round.
    current_load: {email: int} - pending leads that agent already holds; only
    caps how many more they can receive, never reduced/reassigned here.
    quota: an int applied to everyone, OR {email: int} for per-agent capacity - the
    processes each keep their own quota per agent (calling_agent_process.max_quota), so a
    single number can't express "20 leads on RTO, 5 on NDR". An agent missing from the dict
    falls back to DEFAULT_QUOTA rather than to zero: a missing quota means "unset", and
    treating it as no capacity would silently make that agent ineligible for every lead.
    excluded_by_row: optional {row_index: set(emails)} - agents who must never receive THIS
    particular lead, e.g. assign_leads.py's Connected=No reassignment excludes everyone who
    already failed to reach this same customer. Absent/empty for a lead means every online
    agent is a candidate, same as before this parameter existed. Its presence also marks that
    row as a reassignment for the fresh-first ordering above - see that note.
    rto_reason_by_row: optional {row_index: str} - the lead's ORIGINAL system/courier RTO
    reason, needed only for agent_specializations matching below. Absent/blank for a row means
    it can never match any specialization (falls straight to the general round-robin, same as
    before this parameter existed).
    agent_specializations: optional {email: [reason_substr, ...]} (lowercase substrings, same
    case-insensitive-substring convention as leadAssignmentRules.json's own reason lists) - an
    agent with a non-empty list gets FIRST REFUSAL on any lead whose rto_reason_by_row entry
    contains one of their substrings, ahead of the general round-robin for that lead (still
    subject to quota/exclusion/prepaid-target below). If more than one online specialist
    matches the same lead, whichever is next in the round-robin rotation gets it - a lead is
    never handed to more than one agent. Absent/empty means no specialization at all, i.e.
    identical behaviour to before this parameter existed.
    agent_prepaid_target: optional {email: int 0-100} - a soft cap on what share of that
    agent's OPEN CAPACITY this run (quota minus current_load, snapshotted before anything is
    handed out) may be filled with prepaid leads. The denominator is deliberately capacity and
    not the running tally of what they have been given so far: prepaid is tier 0, so the sorted
    pool places every prepaid lead before the first COD lead exists, and a running-tally ratio
    therefore reads 100% prepaid at every prepaid decision - which silently locked every agent
    with a target below 100 out of prepaid entirely and handed the whole prepaid pool to
    whoever had no target set. It never leaves a lead unassigned to enforce the ratio: an agent
    already at/over their target is skipped in favour of another eligible agent for a prepaid
    lead, but if every eligible agent is at/over target the lead is still assigned (falls back
    to ignoring the ratio) rather than left in the queue. Steers the mix over time rather than
    guaranteeing an exact percentage - "soft" is the whole point, since a hard cap could strand
    prepaid leads unassigned purely because everyone online happened to be tuned low. Absent/
    unset for an agent means no target, i.e. unrestricted exactly as before this parameter
    existed.
    agent_reassign_payment_mode: optional {email: 'Prepaid' or 'COD'} - unlike
    agent_prepaid_target, a HARD filter that only ever applies to a reassignment (a row_index
    present in excluded_by_row); a fresh/never-touched lead ignores it entirely. An agent with
    an entry here is ineligible for a reassignment whose payment type doesn't match, in every
    pass, with no ratio-ignoring fallback - if every online agent's setting excludes a given
    reassignment's type, that lead is left unassigned rather than forced onto someone who opted
    out of it. Absent/unset for an agent means no restriction, exactly as before this parameter
    existed.
    reassign_reserve_per_agent: int, default leadAssignmentRules.json's reassignReservePerAgent -
    how many of each online agent's open quota slots this run holds back for reassignment
    candidates (a row_index present in excluded_by_row) before the fresh pool is allowed to
    claim them. Without this, the fresh-before-reassignment sort above means a fresh backlog
    that never empties within one run (routine on RTO - see docs/2026-08-18-rto-crm-performance-
    audit.md) leaves every reassignment permanently behind the cursor: it never gets a slot,
    however long reassignRetryCap/reassignMinHoldHours say it should be eligible, and the lead
    just sits attached to its Connected=No agent forever - the bug agents were reporting as
    "reassignment isn't happening". The reserve is only taken when a reassignment candidate
    actually exists this run - an empty reassignment pool leaves fresh with full capacity,
    byte-identical to before this parameter existed - and anything the reserve isn't used for
    flows back to fresh leads in the same run rather than sitting idle. Fresh still outranks
    reassignment for the REST of each agent's capacity, unchanged.

    Returns {row_index: agent_email}.
    """
    from datetime import datetime

    excluded_by_row = excluded_by_row or {}
    rto_reason_by_row = rto_reason_by_row or {}
    agent_specializations = agent_specializations or {}
    agent_prepaid_target = agent_prepaid_target or {}
    agent_reassign_payment_mode = agent_reassign_payment_mode or {}
    reassign_reserve_per_agent = reassign_reserve_per_agent or 0

    # Seconds since epoch via timedelta subtraction (not .timestamp() - that calls into
    # the platform's C time functions and raises on Windows for extreme/pre-epoch values,
    # which datetime.min triggers). RTO Initiated Date carries a time-of-day component
    # (unlike the old day-only Calling Date), so this needs to preserve it, not just the day.
    EPOCH = datetime(1970, 1, 1)

    def _date_seconds(dt):
        return (dt - EPOCH).total_seconds() if dt else 0.0

    # Reassignments (any row_index present in excluded_by_row) must fully exhaust the
    # fresh/never-touched pool before competing for agent capacity at all - a lead nobody has
    # ever called always outranks one that's already been tried and failed, regardless of
    # tier. The only current caller that populates excluded_by_row is the Connected=No
    # reassignment feature, so its presence doubles as this signal rather than adding a
    # second parameter for the same thing.
    sorted_pool = sorted(
        unassigned_pending,
        key=lambda t: (1 if t[0] in excluded_by_row else 0, t[3], -_date_seconds(t[1])),
    )

    def _quota_for(email):
        if isinstance(quota, dict):
            q = quota.get(email)
            return DEFAULT_QUOTA if q is None else q
        return quota

    needed = {email: max(0, _quota_for(email) - current_load.get(email, 0)) for email in online_agents}
    assignments = {}

    # Per-lead cursor-based round-robin, not a shrinking agent_cycle list - needed so a lead
    # can skip past an excluded-for-this-lead agent without disturbing anyone else's turn.
    # Equivalent to the old shrinking-list approach when excluded_by_row is empty (verified:
    # both visit online_agents in the same fixed relative order, skipping only agents already
    # at needed<=0) - this refactor changes HOW capacity/exclusion are checked per lead, not
    # the resulting assignment order for the case every existing caller already relies on.
    agent_order = [e for e in online_agents if needed[e] > 0]
    if not agent_order:
        return assignments
    cursor = 0
    # This run's own prepaid tally, NOT current_load (which has no payment-type breakdown) - a
    # soft target steers the incoming distribution for this batch, it doesn't need perfect
    # knowledge of an agent's full historical mix to do that.
    prepaid_assigned_this_run = {email: 0 for email in agent_order}
    # Denominator for the prepaid target: this run's TOTAL open capacity per agent, snapshotted
    # before anything is handed out. Not the running tally - prepaid is tier 0, so every prepaid
    # lead is placed before the first COD lead exists, which made a running-tally ratio read
    # 100% prepaid at every prepaid decision and locked out every agent with a target below 100.
    capacity_this_run = {email: needed[email] for email in agent_order}

    def _matches_specialist(email, row_index):
        reasons = agent_specializations.get(email)
        if not reasons:
            return False
        reason_text = (rto_reason_by_row.get(row_index) or '').lower()
        return any(r in reason_text for r in reasons)

    def _within_prepaid_target(email, is_prepaid_lead):
        if not is_prepaid_lead:
            return True
        target = agent_prepaid_target.get(email)
        if target is None:
            return True
        # Integer form of (prepaid + 1) <= capacity * target / 100 - floor semantics, so a
        # capacity too small to hold even one lead's worth of the target allows no prepaid in
        # passes 1-2 and falls through to pass 3 like any other at-target agent.
        return (prepaid_assigned_this_run[email] + 1) * 100 <= capacity_this_run[email] * target

    def _matches_reassign_payment_mode(email, row_index, is_prepaid_lead):
        if row_index not in excluded_by_row:
            return True
        mode = agent_reassign_payment_mode.get(email)
        if not mode:
            return True
        return mode == ('Prepaid' if is_prepaid_lead else 'COD')

    def _try_assign(candidate_ok):
        nonlocal cursor
        for _ in range(len(agent_order)):
            email = agent_order[cursor % len(agent_order)]
            cursor += 1
            if candidate_ok(email):
                return email
        return None

    def _assign_pool(pool):
        for row_index, _rto_initiated_date, _order_id, tier in pool:
            if row_index in assignments:
                continue  # already placed by an earlier pass over this same lead (reserve retry)
            excluded = excluded_by_row.get(row_index) or ()
            is_prepaid_lead = (tier == 0)

            # Pass 1: a specialist for this lead's RTO reason gets first refusal, still subject
            # to quota/exclusion/prepaid-target/reassign-payment-mode - "first refusal" means
            # ahead of the general pool, not an unconditional override of everything else.
            chosen = _try_assign(lambda e: e not in excluded and needed[e] > 0
                                  and _matches_reassign_payment_mode(e, row_index, is_prepaid_lead)
                                  and _matches_specialist(e, row_index) and _within_prepaid_target(e, is_prepaid_lead))
            # Pass 2: general round-robin, still respecting each agent's soft prepaid target and
            # hard reassign-payment-mode filter.
            if chosen is None:
                chosen = _try_assign(lambda e: e not in excluded and needed[e] > 0
                                      and _matches_reassign_payment_mode(e, row_index, is_prepaid_lead)
                                      and _within_prepaid_target(e, is_prepaid_lead))
            # Pass 3: every eligible agent is at/over their prepaid target - assign anyway rather
            # than leave the lead unassigned purely to protect a soft ratio. reassign-payment-mode
            # stays hard even here - see its own docstring entry.
            if chosen is None:
                chosen = _try_assign(lambda e: e not in excluded and needed[e] > 0
                                      and _matches_reassign_payment_mode(e, row_index, is_prepaid_lead))

            if chosen is not None:
                assignments[row_index] = chosen
                needed[chosen] -= 1
                if is_prepaid_lead:
                    prepaid_assigned_this_run[chosen] += 1
            # else (every agent excluded or at capacity): this lead is left unassigned this
            # round, same as running out of agent capacity did before this parameter existed.

    fresh_pool = [t for t in sorted_pool if t[0] not in excluded_by_row]
    reassign_pool = [t for t in sorted_pool if t[0] in excluded_by_row]

    if reassign_pool and reassign_reserve_per_agent > 0:
        # Hold back up to reassign_reserve_per_agent slots per agent so the reassignment pool
        # gets first crack at them, THEN let fresh claim the rest of that agent's capacity - see
        # this parameter's docstring entry for why the plain fresh-then-reassign order above
        # alone leaves reassignments stuck forever behind a backlog that never runs dry.
        reserved = {email: min(reassign_reserve_per_agent, needed[email]) for email in agent_order}
        for email in agent_order:
            needed[email] -= reserved[email]
        _assign_pool(fresh_pool)
        for email in agent_order:
            needed[email] += reserved[email]
        _assign_pool(reassign_pool)
        _assign_pool(fresh_pool)  # give back whatever of the reserve reassignment didn't use
    else:
        # No reassignment candidate this run, or the reserve is switched off - identical to the
        # single fresh-then-reassign pass this function always ran before the reserve existed.
        _assign_pool(fresh_pool)
        _assign_pool(reassign_pool)

    return assignments
