"""Round-robin assigns unassigned pending RTO leads (Column Q) to eligible
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

Eligibility: an agent is in the round-robin pool only while their most recent
agent_presence row (in the same Postgres DB the site's admin/auth panel already
uses) says 'Online' with a timestamp newer than STALE_MINUTES. rto-crm.html
writes that row on every explicit status change and a periodic heartbeat (see
its presence-sync effect) via POST /api/auth/presence, which stamps the email
from the caller's own session - not client-supplied - so an agent can only
ever report their own status.

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
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from lead_priority import (
    COL_AGENT, COL_ATTEMPT, COL_AWB_CODE, COL_CONNECTED, COL_DISPOSITION,
    COL_ORDER_ID, COL_PAYMENT_METHOD, COL_REMARKS, COL_RTO_INITIATED_DATE, COL_RTO_REASON,
    DEFAULT_QUOTA, build_assignment_queue, cell, parse_rto_initiated_date, priority_tier,
)

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"

STALE_MINUTES = 10  # must match the CRM's own heartbeat cadence assumptions


def fetch_online_agents():
    """Emails (lowercased) currently 'Online' in Postgres's agent_presence table,
    heartbeat-fresh within STALE_MINUTES. Returns [] (not an error) if
    POSTGRES_URL isn't configured, so a missing secret fails safe (no
    assignment) rather than crashing the whole run."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        print("POSTGRES_URL not configured - cannot determine online agents.")
        return []
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
            return [row[0].lower() for row in cur.fetchall()]


def record_lead_assignments(assignments, unassigned_pending, awb_code_by_row):
    """Stamps assigned_at=now() for every lead just assigned, keyed by the sheet's
    own Order ID, so rto-crm.html's resetStalePendingLeads() can tell a
    fresh assignment apart from a genuinely stale one (the lead's own Calling
    Date can't do this - the backlog this script distributes is old by
    definition). Best-effort: if POSTGRES_URL isn't configured, silently
    skips (fetch_online_agents() would already have returned [] in that case,
    so in practice this only runs when the DB is reachable anyway).

    Also stamps awb_code (unique per lead_assignments row - see the UNIQUE
    index in api/_lib/db.js's ensureSchema) so downstream reporting
    (scripts/sync_lead_assignments_to_mysql.py) can key on it. Uses COALESCE
    on conflict rather than blindly overwriting, so a re-run never clobbers an
    awb_code already recorded by the disposal write path (api/_lib/db.js's
    recordLeadDisposition) with a blank value."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str or not assignments:
        return
    order_id_by_row = {row_index: order_id for row_index, _rto_initiated_date, order_id, _tier in unassigned_pending}
    rows = [
        (order_id_by_row[row_index], email, awb_code_by_row.get(row_index) or None)
        for row_index, email in assignments.items() if row_index in order_id_by_row
    ]
    if not rows:
        return
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO lead_assignments (order_id, email, assigned_at, awb_code)
                VALUES (%s, %s, now(), %s)
                ON CONFLICT (order_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    assigned_at = now(),
                    awb_code = COALESCE(EXCLUDED.awb_code, lead_assignments.awb_code)
                """,
                rows,
            )
        conn.commit()


def main():
    print("Fetching online agents from Postgres...")
    online_agents = fetch_online_agents()
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

    # current_load: how many pending (undisposed) leads each eligible agent already holds -
    # still needed so an agent already at or over quota doesn't get handed more, but a lead
    # counted here is NEVER unassigned or reassigned by this script, no matter how high the
    # count goes. Only genuinely blank/Unassigned Column Q values are ever written to.
    current_load = {email: 0 for email in online_agents}
    unassigned_pending = []  # (row_index, rto_initiated_date, order_id, tier)
    awb_code_by_row = {}
    tier_counts = {0: 0, 1: 0, 2: 0, 3: 0}

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
        rto_initiated_date = parse_rto_initiated_date(cell(row, COL_RTO_INITIATED_DATE))
        tier = priority_tier(cell(row, COL_PAYMENT_METHOD), cell(row, COL_RTO_REASON))

        if is_unassigned:
            unassigned_pending.append((i, rto_initiated_date, order_id, tier))
            awb_code_by_row[i] = cell(row, COL_AWB_CODE)
            tier_counts[tier] += 1
        elif agent_raw in current_load:
            current_load[agent_raw] += 1
        # else: pending lead already held by someone (eligible or not) - left alone either
        # way. Column Q having any value at all is enough to exempt a lead permanently.

    print(f"  unassigned pool by priority: Prepaid={tier_counts[0]}, COD+high-priority reason={tier_counts[1]}, other COD={tier_counts[2]}, COD+low-priority reason={tier_counts[3]}")

    if not unassigned_pending:
        print("No unassigned pending leads found - nothing to assign.")
        return

    assignments = build_assignment_queue(unassigned_pending, online_agents, current_load, quota=DEFAULT_QUOTA)

    if not assignments:
        print(f"{len(unassigned_pending)} unassigned lead(s) found, but every eligible agent is already at quota ({DEFAULT_QUOTA}). Nothing to assign.")
        return

    value_ranges = [
        {"range": f"'{SHEET_TAB}'!Q{row_index + 2}", "values": [[email]]}
        for row_index, email in assignments.items()
    ]
    print(f"Writing {len(value_ranges)} Column Q assignment(s)...")
    lib.set_sheet_values_batch(SPREADSHEET_ID, value_ranges)
    record_lead_assignments(assignments, unassigned_pending, awb_code_by_row)

    per_agent = {}
    for email in assignments.values():
        per_agent[email] = per_agent.get(email, 0) + 1
    print("Done. Assigned:")
    for email, count in sorted(per_agent.items()):
        print(f"  {email}: +{count}")
    skipped = len(unassigned_pending) - len(assignments)
    if skipped > 0:
        print(f"  ({skipped} unassigned lead(s) left over - all eligible agents at quota)")


if __name__ == "__main__":
    main()
