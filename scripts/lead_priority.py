"""Shared RTO lead sheet semantics: column layout, date parsing, and
priority-tier/assignment logic.

Extracted out of assign_leads.py so both the assignment-writer cron job and
rto_crm_app's ticket mapper / "Next to Assign" preview import the exact same
constants and functions - previously several of these (the priority-reason
list, column indices) were duplicated by hand between assign_leads.py
(Python) and rto-crm.html (JS), kept in sync manually.
"""

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
COL_REMARKS = 20          # U
COL_NEW_ORDER_ID = 21     # V
COL_NEW_ADDRESS = 23      # X
COL_CALLING_DATE = 24     # Y

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
)}

# Delivery partner from an AWB code's prefix - mirrored in api/_lib/db.js's
# resolvePartnerFromAwb/AWB_PREFIX_RULES for leads recorded via the disposal path; keep
# both in sync by hand if the rule ever changes. Business rule confirmed manually
# against known AWB ranges, not derived from anything self-describing in the AWB
# format itself.
PREFIX_RULES = [
    ("SF", "Shadowfax"),
    ("MC", "ElasticRun"),
    ("PD", "Pidge"),
    ("PA", "Pikendle"),
    ("76", "Bluedart"),
    ("77", "Bluedart"),
    ("78", "Bluedart"),
    ("80", "Bluedart"),
    ("90", "Bluedart"),
    ("23", "Delhivery"),
    ("15", "Xpressbees"),
    ("18", "Delhivery"),
    ("53", "Delhivery"),
]


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
HIGH_PRIORITY_COD_RTO_REASONS = [
    "consignee opened the package and refused to accept",
    "consignee refused to accept",
    "customer refused to accept",
    "customer refused to accept:verified",
    "elasticrun_otp_verified",
    "entry refused",
    "kyc|customer refused to share kyc/ ndc/ scd",
    "prf|receiver refused delivery(cir)",
    "refused to accept",
    "refused to accept (no cancellation code)",
]

# Deliberately lowest priority (tier 3, behind even "every other COD order") -
# these OTP outcomes are handled last in the assignment queue.
LOW_PRIORITY_COD_RTO_REASONS = [
    "otp validation successful",
    "otp verified cancellation",
    "refused to accept (with cancellation code)",
    "rto pending - otp validated cancellation",
]

DEFAULT_QUOTA = 20


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


def build_assignment_queue(unassigned_pending, online_agents, current_load, quota=DEFAULT_QUOTA):
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

    Returns {row_index: agent_email}.
    """
    from datetime import datetime

    # Seconds since epoch via timedelta subtraction (not .timestamp() - that calls into
    # the platform's C time functions and raises on Windows for extreme/pre-epoch values,
    # which datetime.min triggers). RTO Initiated Date carries a time-of-day component
    # (unlike the old day-only Calling Date), so this needs to preserve it, not just the day.
    EPOCH = datetime(1970, 1, 1)

    def _date_seconds(dt):
        return (dt - EPOCH).total_seconds() if dt else 0.0

    sorted_pool = sorted(unassigned_pending, key=lambda t: (t[3], -_date_seconds(t[1])))

    needed = {email: max(0, quota - current_load.get(email, 0)) for email in online_agents}
    assignments = {}
    queue_pos = 0
    agent_cycle = [e for e in online_agents if needed[e] > 0]
    while queue_pos < len(sorted_pool) and agent_cycle:
        progressed = False
        for email in list(agent_cycle):
            if queue_pos >= len(sorted_pool):
                break
            if needed[email] <= 0:
                agent_cycle.remove(email)
                continue
            row_index, _, _order_id, _tier = sorted_pool[queue_pos]
            assignments[row_index] = email
            needed[email] -= 1
            queue_pos += 1
            progressed = True
            if needed[email] <= 0:
                agent_cycle.remove(email)
        if not progressed:
            break
    return assignments
