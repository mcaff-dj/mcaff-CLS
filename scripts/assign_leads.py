"""Round-robin assigns unassigned pending RTO leads (Column Q) to currently-online
agents, server-side. Run on a schedule via GitHub Actions (see
.github/workflows/assign-leads.yml) so there's exactly one process ever deciding
"who gets which lead" - the CRM (rto-crm.html) just displays whatever Column Q
already says once this has run; it no longer computes or writes assignments
itself.

This replaces client-side round-robin logic that used to run independently in
every agent's browser: each browser's own possibly-stale ticket/roster snapshot
could disagree about who "should" get an unassigned lead, and whichever browser's
write reached Column Q last silently won - overwriting another agent's legitimate
claim. A single server-side pass has no such race.

Eligibility: an agent is in the round-robin pool only while they're marked
'Online' in Supabase's agent_status table with a heartbeat newer than
STALE_MINUTES (the CRM pushes a heartbeat on login and every 2 minutes while
active - see rto-crm.html's presence heartbeat effect). There's no durable
roster/quota source yet (that only ever lived in each browser's localStorage),
so every online agent gets the same DEFAULT_QUOTA; already-assigned pending
leads held by an agent who isn't currently online are left alone.

A lead with ANY value already in Column Q - whether written by this script, a
manual claim, an admin reassign, or typed directly into the sheet - is never
touched again. It still counts toward that agent's load (so they don't get
handed more than quota), but it is never unassigned or reassigned by this
script, regardless of quota, regardless of whether that agent is online. An
earlier version trimmed over-quota agents' oldest excess back to unassigned;
that silently cleared a manually-assigned lead and was removed for exactly
that reason - only touch what is genuinely blank.
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"

DEFAULT_SUPABASE_URL = "https://yzvqkboikvbkriccrhjk.supabase.co"
DEFAULT_SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6dnFr"
    "Ym9pa3Zia3JpY2NyaGprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NDgxNjEsImV4cCI6MjEw"
    "MDEyNDE2MX0.qF0rNhAt6NRBmE3PQp8BpI5hUb5RbMda98oEXtAjy_Q"
)

DEFAULT_QUOTA = 10
STALE_MINUTES = 10  # must match the CRM's own inactivity-to-offline threshold

# 0-based column indices, matching rto-crm.html's mapTkt/writeToSheetRow exactly.
COL_RTO_REASON = 3        # D - the ORIGINAL system/courier RTO reason (not the agent's own
                          # disposition in COL_DISPOSITION below)
COL_ORDER_ID = 4          # E
COL_PAYMENT_METHOD = 14   # O
COL_AGENT = 16            # Q
COL_CONNECTED = 17        # R
COL_ATTEMPT = 18          # S
COL_DISPOSITION = 19      # T - agent's own "RTO Reason - Agent" disposition entry
COL_REMARKS = 20          # U
COL_CALLING_DATE = 24     # Y

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
)}

# Assignment priority, highest first:
#   0. Prepaid orders - payment method wins outright, regardless of RTO reason.
#   1. COD orders whose original RTO reason matches one of these (case-insensitive
#      substring) - the consignee has already refused/OTP-verified the cancellation, so
#      the outcome is effectively known and worth acting on quickly.
#   2. Every other COD order.
# Within each tier, newest calling date first. Same reason list as rto-crm.html's
# HIGH_PRIORITY_RTO_REASONS constant.
HIGH_PRIORITY_COD_RTO_REASONS = [
    "consignee opened the package and refused to accept",
    "consignee refused to accept",
    "customer refused to accept",
    "customer refused to accept:verified",
    "elasticrun_otp_verified",
    "entry refused",
    "kyc|customer refused to share kyc/ ndc/ scd",
    "otp validation successful",
    "otp verified cancellation",
    "prf|receiver refused delivery(cir)",
    "refused to accept",
    "refused to accept (no cancellation code)",
    "refused to accept (with cancellation code)",
    "rto pending - otp validated cancellation",
]


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
    high-priority reasons, 2 = every other COD lead. Lower sorts first."""
    if is_prepaid(payment_raw):
        return 0
    reason = (rto_reason_raw or "").lower()
    if any(r in reason for r in HIGH_PRIORITY_COD_RTO_REASONS):
        return 1
    return 2


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
    year = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else datetime.now().year
    try:
        return datetime(year, month, day)
    except ValueError:
        return None


def cell(row, idx):
    return row[idx].strip() if idx < len(row) and row[idx] else ""


def fetch_online_agents(supabase_url, supabase_key):
    """Emails (lowercased) of agents whose last Supabase heartbeat is fresher
    than STALE_MINUTES and whose last reported status is 'Online'."""
    url = f"{supabase_url}/rest/v1/agent_status?select=email,status,updated_at&order=updated_at.asc"
    resp = requests.get(url, headers={"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"}, timeout=30)
    resp.raise_for_status()
    rows = resp.json()

    latest = {}
    for r in rows:
        email = (r.get("email") or "").strip().lower()
        if email:
            latest[email] = r  # oldest-first order => last write per email wins

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=STALE_MINUTES)
    online = []
    for email, r in latest.items():
        if (r.get("status") or "").strip().lower() != "online":
            continue
        try:
            updated_at = datetime.fromisoformat((r["updated_at"] or "").replace("Z", "+00:00"))
        except (ValueError, KeyError):
            continue
        if updated_at >= cutoff:
            online.append(email)
    return sorted(online)


def main():
    supabase_url = os.environ.get("SUPABASE_URL") or DEFAULT_SUPABASE_URL
    supabase_key = os.environ.get("SUPABASE_KEY") or DEFAULT_SUPABASE_KEY

    print("Fetching online agents from Supabase...")
    online_agents = fetch_online_agents(supabase_url, supabase_key)
    if not online_agents:
        print("No agents currently online - nothing to assign. Exiting.")
        return
    print(f"  {len(online_agents)} online: {', '.join(online_agents)}")

    print(f"Fetching '{SHEET_TAB}' tab from spreadsheet {SPREADSHEET_ID}...")
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A:AD")
    if not values or len(values) < 2:
        print("Sheet is empty - nothing to do.")
        return
    rows = values[1:]  # skip header
    print(f"  {len(rows)} data rows")

    # current_load: how many pending (undisposed) leads each online agent already holds -
    # still needed so an agent already at or over quota doesn't get handed more, but a lead
    # counted here is NEVER unassigned or reassigned by this script, no matter how high the
    # count goes. Only genuinely blank/Unassigned Column Q values are ever written to.
    current_load = {email: 0 for email in online_agents}
    unassigned_pending = []  # (row_index, calling_date, order_id, tier)
    tier_counts = {0: 0, 1: 0, 2: 0}

    for i, row in enumerate(rows):
        order_id = cell(row, COL_ORDER_ID)
        if not order_id:
            continue

        is_disposed = bool(
            cell(row, COL_CONNECTED) or cell(row, COL_ATTEMPT) or
            cell(row, COL_DISPOSITION) or cell(row, COL_REMARKS)
        )
        if is_disposed:
            continue  # already worked - not part of either load or the unassigned queue

        agent_raw = cell(row, COL_AGENT).lower()
        is_unassigned = (not agent_raw) or agent_raw == "unassigned"
        calling_date = parse_calling_date(cell(row, COL_CALLING_DATE))
        tier = priority_tier(cell(row, COL_PAYMENT_METHOD), cell(row, COL_RTO_REASON))

        if is_unassigned:
            unassigned_pending.append((i, calling_date, order_id, tier))
            tier_counts[tier] += 1
        elif agent_raw in current_load:
            current_load[agent_raw] += 1
        # else: pending lead already held by someone (online or not) - left alone either
        # way. Column Q having any value at all is enough to exempt a lead permanently.

    print(f"  unassigned pool by priority: Prepaid={tier_counts[0]}, COD+high-priority reason={tier_counts[1]}, other COD={tier_counts[2]}")

    if not unassigned_pending:
        print("No unassigned pending leads found - nothing to assign.")
        return

    # Tier 0 (Prepaid) before tier 1 (COD + high-priority reason) before tier 2 (other COD),
    # regardless of date. Within each tier, newest calling date first; undated leads sort
    # last in their tier. toordinal() (not timestamp()) avoids a pre-1970 overflow for any
    # genuinely ancient/unparseable-year date.
    unassigned_pending.sort(key=lambda t: (t[3], -(t[1] or datetime.min).toordinal()))

    needed = {email: max(0, DEFAULT_QUOTA - current_load.get(email, 0)) for email in online_agents}
    print(f"  current load / quota: {[(e, current_load[e], DEFAULT_QUOTA) for e in online_agents]}")

    assignments = {}  # row_index -> agent email
    queue_pos = 0
    agent_cycle = [e for e in online_agents if needed[e] > 0]
    while queue_pos < len(unassigned_pending) and agent_cycle:
        progressed = False
        for email in list(agent_cycle):
            if queue_pos >= len(unassigned_pending):
                break
            if needed[email] <= 0:
                agent_cycle.remove(email)
                continue
            row_index, _, order_id, _ = unassigned_pending[queue_pos]
            assignments[row_index] = email
            needed[email] -= 1
            queue_pos += 1
            progressed = True
            if needed[email] <= 0:
                agent_cycle.remove(email)
        if not progressed:
            break

    if not assignments:
        print(f"{len(unassigned_pending)} unassigned lead(s) found, but every online agent is already at quota ({DEFAULT_QUOTA}). Nothing to assign.")
        return

    value_ranges = [
        {"range": f"'{SHEET_TAB}'!Q{row_index + 2}", "values": [[email]]}
        for row_index, email in assignments.items()
    ]
    print(f"Writing {len(value_ranges)} Column Q assignment(s)...")
    lib.set_sheet_values_batch(SPREADSHEET_ID, value_ranges)

    per_agent = {}
    for email in assignments.values():
        per_agent[email] = per_agent.get(email, 0) + 1
    print("Done. Assigned:")
    for email, count in sorted(per_agent.items()):
        print(f"  {email}: +{count}")
    skipped = len(unassigned_pending) - len(assignments)
    if skipped > 0:
        print(f"  ({skipped} unassigned lead(s) left over - all online agents at quota)")


if __name__ == "__main__":
    main()
