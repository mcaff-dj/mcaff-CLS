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

# Connected=No reassignment - shared with the JS "Next to Assign" preview so the cutoff/cap
# can't drift between them the way DEFAULT_QUOTA once did. See leadAssignmentRules.json's
# _reassignNote for what these mean.
from datetime import datetime as _datetime
REASSIGN_BACKLOG_CUTOFF = _datetime.strptime(_RULES["reassignBacklogCutoff"], "%Y-%m-%d")
REASSIGN_RETRY_CAP = _RULES["reassignRetryCap"]


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
                            excluded_by_row=None):
    """Round-robins a pool of unassigned pending leads across online agents up to
    `quota` each, based on each agent's current load. Pure/side-effect-free -
    callers decide whether to actually write the result (assign_leads.py) or
    just display it (rto_crm_app's Next to Assign preview); both call this same
    function so the preview can never drift from what the real writer would do.

    unassigned_pending: list of (row_index, rto_initiated_date, order_id, tier) tuples,
    NOT yet sorted - this function sorts them (tier asc, rto_initiated_date desc;
    undated leads sort last within their tier).
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
    agent is a candidate, same as before this parameter existed.

    Returns {row_index: agent_email}.
    """
    from datetime import datetime

    excluded_by_row = excluded_by_row or {}

    # Seconds since epoch via timedelta subtraction (not .timestamp() - that calls into
    # the platform's C time functions and raises on Windows for extreme/pre-epoch values,
    # which datetime.min triggers). RTO Initiated Date carries a time-of-day component
    # (unlike the old day-only Calling Date), so this needs to preserve it, not just the day.
    EPOCH = datetime(1970, 1, 1)

    def _date_seconds(dt):
        return (dt - EPOCH).total_seconds() if dt else 0.0

    sorted_pool = sorted(unassigned_pending, key=lambda t: (t[3], -_date_seconds(t[1])))

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
    for row_index, _rto_initiated_date, _order_id, _tier in sorted_pool:
        excluded = excluded_by_row.get(row_index) or ()
        for _ in range(len(agent_order)):
            email = agent_order[cursor % len(agent_order)]
            cursor += 1
            if needed[email] <= 0 or email in excluded:
                continue
            assignments[row_index] = email
            needed[email] -= 1
            break
        # else (loop exhausted with no eligible agent - all excluded or all at capacity):
        # this lead is left unassigned this round, same as running out of agent capacity did
        # before this parameter existed.
    return assignments
