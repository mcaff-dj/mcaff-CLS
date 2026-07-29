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

Before a still-unassigned PREPAID lead enters the pool, its refund status is checked live
against GoKwik (see is_already_refunded_via_gokwik) - a customer who's already been refunded
should never be called about their order again. GoKwik doesn't recognise the sheet's own Order
ID, so the check first resolves it to GoKwik's numeric platformOrderId via Item_level_data (see
lookup_platform_order_id). A confirmed refund gets S/T/U stamped "Already Refunded" on the
sheet - permanently marking the row worked to every other reader, not just skipped this once -
and never reaches the assignment pool. COD is never checked: nothing was paid upfront to
refund before delivery. Every failure mode here - no platform order ID match, missing
credentials, a network error, a non-200 - fails OPEN (assigns normally): one extra call to an
already-refunded customer is preferred over silently stalling a genuinely-pending lead because
of a flaky request.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
REPO_ROOT = Path(__file__).resolve().parent.parent
import lib
import mysql_lib
from lead_priority import (
    COL_AGENT, COL_ATTEMPT, COL_AWB_CODE, COL_CONNECTED, COL_DISPOSITION,
    COL_ORDER_ID, COL_PAYMENT_METHOD, COL_REMARKS, COL_REMARKS_LEGACY_U,
    COL_RTO_INITIATED_DATE, COL_RTO_REASON,
    DEFAULT_QUOTA, build_assignment_queue, cell, is_prepaid, parse_rto_initiated_date,
    prefix_rule_partner, priority_tier,
)

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"

STALE_MINUTES = 10  # must match the CRM's own heartbeat cadence assumptions

# Item-level DWH schema the GoKwik refund-status lookup resolves a sheet Order ID against -
# see lookup_platform_order_id.
ITEM_LEVEL_SCHEMA = "mcaff_prod"

GOKWIK_REFUND_STATUS_URL = "https://gkx.gokwik.co/v1/payments/refunds"
GOKWIK_TIMEOUT_SEC = 8

# Same order-number-prefix -> vendor rule as api/refund/gokwik-initiate.js (kept in that
# order - Fien and Hyphen are prefix-distinguishable, mcaffeine is the plain-numeric
# catch-all and must stay last).
GOKWIK_VENDORS = [
    {"key": "hyphen", "prefix": "HYP", "env_prefix": "GOKWIK_HYPHEN"},
    {"key": "fien", "prefix": "Fien", "env_prefix": "GOKWIK_FIEN"},
    {"key": "mcaffeine", "prefix": None, "env_prefix": "GOKWIK_MCAFFEINE"},  # catch-all, stays last
]


def resolve_gokwik_vendor(order_id):
    order_id = order_id or ""
    for vendor in GOKWIK_VENDORS:
        if vendor["prefix"] is None or order_id.lower().startswith(vendor["prefix"].lower()):
            return vendor
    return None  # unreachable - the catch-all always matches


def lookup_platform_order_id(order_id):
    """The sheet's own Order ID (Display_Order_Code) isn't what GoKwik knows an order by -
    GoKwik expects its own numeric platformOrderId. Item_level_data carries the mapping, but
    NOT reliably: a Display_Order_Code can have a row per sync channel, and only the
    '*SHOPIFY' channel's Sale_Order_Code is the real GoKwik-recognizable numeric ID - a
    'HYPHEN_D2C' row for the same order was observed carrying Sale_Order_Code equal to the
    Display_Order_Code itself (a placeholder, not a real platform ID). Oldest-by-Created among
    the Shopify-channel rows picks the original order over any later re-sync. A stray leading
    backtick (a spreadsheet-import artifact seen even in plain numeric IDs, e.g. mCaffeine
    order 21494) is stripped before the numeric check.

    Returns None (never raises) on no match OR a lookup error - lookup failures fail OPEN
    (assign as normal) rather than blocking a genuinely-pending lead over a flaky DB call."""
    try:
        rows = mysql_lib.query(
            """
            SELECT Sale_Order_Code
            FROM Item_level_data
            WHERE Display_Order_Code = %s
              AND Channel_Name LIKE '%%SHOPIFY%%'
            ORDER BY Created ASC
            LIMIT 1
            """,
            (order_id,),
            database=ITEM_LEVEL_SCHEMA,
        )
    except Exception as e:
        print(f"    (Item_level_data lookup for {order_id} failed: {e} - treating as not-refunded)")
        return None
    if not rows or not rows[0][0]:
        return None
    platform_order_id = rows[0][0].strip().lstrip("`")
    if not platform_order_id.isdigit():
        return None
    return platform_order_id


def is_already_refunded_via_gokwik(order_id):
    """True only on a confirmed GoKwik refund (success + a Completed entry). Every other
    outcome - no platform order ID found, missing credentials for this order's vendor, a
    network error, a non-200, an unparseable body - returns False, per the same fail-open
    philosophy as lookup_platform_order_id: never block a real pending lead over infrastructure
    flakiness, only ever skip one that's positively confirmed refunded."""
    platform_order_id = lookup_platform_order_id(order_id)
    if not platform_order_id:
        return False

    vendor = resolve_gokwik_vendor(order_id)
    if vendor is None:
        return False
    app_id = os.environ.get(f"{vendor['env_prefix']}_APPID")
    app_secret = os.environ.get(f"{vendor['env_prefix']}_APPSECRET")
    if not app_id or not app_secret:
        return False

    try:
        resp = requests.get(
            GOKWIK_REFUND_STATUS_URL,
            params={"platformOrderId": platform_order_id},
            headers={"gk-app-id": app_id, "gk-app-secret": app_secret},
            timeout=GOKWIK_TIMEOUT_SEC,
        )
    except Exception as e:
        print(f"    (GoKwik refund-status call for {order_id} failed: {e} - treating as not-refunded)")
        return False
    if resp.status_code != 200:
        return False
    try:
        body = resp.json()
    except Exception:
        return False
    if not body.get("success"):
        return False
    refunds = body.get("data") or []
    return any(r.get("status") == "Completed" for r in refunds)


def fetch_online_agents(process_key=None):
    """(emails, quotas) of the agents eligible for this process's leads right now.

    Two things have to be true, and they answer different questions:

      * agent_presence  - "are they actually at their desk?" One row per agent, refreshed by
        the CRM's heartbeat, so staleness is meaningful here.
      * calling_agent_process - "are they available for THIS process, and for how many leads?"
        One row per (agent, process). It has no heartbeat, so on its own it would keep somebody
        Online forever after an admin set it once.

    So eligibility is the INTERSECTION: marked Online for the process AND heartbeat-fresh.
    A process with no per-process rows at all falls back to the global agent_presence status,
    which is exactly the behaviour before processes existed - so RTO keeps working unchanged
    until someone actually sets per-process availability.

    quotas is {email: max_quota} for whatever has been set per process; agents absent from it
    fall back to DEFAULT_QUOTA in build_assignment_queue.

    Returns ([], {}) (not an error) if POSTGRES_URL isn't configured, so a missing secret fails
    safe - no assignment - rather than crashing the whole run.
    """
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        print("POSTGRES_URL not configured - cannot determine online agents.")
        return [], {}
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
            present = [row[0].lower() for row in cur.fetchall()]

            if not process_key:
                return present, {}

            try:
                cur.execute(
                    "SELECT email, status, max_quota FROM calling_agent_process WHERE process_key = %s",
                    (process_key,),
                )
                per_process = cur.fetchall()
            except Exception as e:
                # Table not created yet (no admin has opened the panel) - fall back rather than
                # refuse to assign, which would stop the queue over a missing config table.
                print(f"  (calling_agent_process unavailable: {e} - using global presence)")
                return present, {}

    if not per_process:
        print(f"  no per-process availability set for '{process_key}' - using global presence")
        return present, {}

    online_for_process = {e.lower() for e, status, _ in per_process if status == "Online"}
    quotas = {e.lower(): q for e, _, q in per_process if q is not None}
    eligible = sorted(online_for_process & set(present))
    if online_for_process and not eligible:
        print(f"  {len(online_for_process)} agent(s) marked Online for '{process_key}', but none are "
              f"heartbeat-fresh (within {STALE_MINUTES}m) - nobody is actually at their desk.")
    return eligible, quotas


def record_lead_assignments(assignments, unassigned_pending, awb_code_by_row, rto_reason_by_row):
    """Stamps assigned_at=now() for every lead just assigned, keyed by the sheet's
    own Order ID, so rto-crm.html's resetStalePendingLeads() can tell a
    fresh assignment apart from a genuinely stale one (the lead's own Calling
    Date can't do this - the backlog this script distributes is old by
    definition). Best-effort: if POSTGRES_URL isn't configured, silently
    skips (fetch_online_agents() would already have returned [] in that case,
    so in practice this only runs when the DB is reachable anyway).

    Also stamps awb_code (unique per lead_assignments row - see the UNIQUE
    index in api/_lib/db.js's ensureSchema), rto_reason (the sheet's own Column D -
    see lead_priority.COL_RTO_REASON), and delivery_partner (derived from awb_code via
    lead_priority.prefix_rule_partner - the same rule api/_lib/db.js's JS mirror uses
    for leads recorded via the disposal path instead) so downstream reporting
    (scripts/sync_lead_assignments_to_mysql.py) can key on any of them without a
    separate sheet lookup. All three use COALESCE on conflict rather than blindly
    overwriting, so a re-run never clobbers a value already recorded by the disposal
    write path (api/_lib/db.js's recordLeadDisposition) with a blank one."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str or not assignments:
        return
    order_id_by_row = {row_index: order_id for row_index, _rto_initiated_date, order_id, _tier in unassigned_pending}
    rows = [
        (
            order_id_by_row[row_index], email,
            awb_code_by_row.get(row_index) or None,
            rto_reason_by_row.get(row_index) or None,
            prefix_rule_partner(awb_code_by_row.get(row_index)) or None,
        )
        for row_index, email in assignments.items() if row_index in order_id_by_row
    ]
    if not rows:
        return
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO lead_assignments (order_id, email, assigned_at, awb_code, rto_reason, delivery_partner)
                VALUES (%s, %s, now(), %s, %s, %s)
                ON CONFLICT (order_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    assigned_at = now(),
                    awb_code = COALESCE(EXCLUDED.awb_code, lead_assignments.awb_code),
                    rto_reason = COALESCE(EXCLUDED.rto_reason, lead_assignments.rto_reason),
                    delivery_partner = COALESCE(EXCLUDED.delivery_partner, lead_assignments.delivery_partner)
                """,
                rows,
            )
        conn.commit()


PROCESS_KEY = "rto"  # this script assigns the RTO process's leads; see callingProcesses.json


DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _default_week(process_key):
    """Fallback week from api/_lib/callingProcesses.json, used for any day an admin has never
    saved. That file supplies DEFAULTS only - calling_business_hours in Postgres is the source
    of truth once an admin edits the hours from the CRM's admin panel."""
    path = REPO_ROOT / "api" / "_lib" / "callingProcesses.json"
    with open(path, "r", encoding="utf-8") as f:
        proc = next((p for p in json.load(f)["processes"] if p["key"] == process_key), None)
    bh = (proc or {}).get("businessHours") or {}
    days = [d.lower() for d in bh.get("days", [])]
    return {d: ((bh.get("start"), bh.get("end")) if d in days else (None, None)) for d in DAY_KEYS}


def _saved_week(process_key):
    """This process's week as saved by an admin: {day: (open, close)}. Days with no row are
    absent, and a row with either time NULL/'' means explicitly CLOSED that day. Returns {} if
    the table isn't reachable/doesn't exist yet, so a fresh environment still runs on defaults
    rather than refusing to assign anything."""
    dsn = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not dsn:
        return {}
    try:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT day, open_time, close_time FROM calling_business_hours WHERE process_key = %s",
                (process_key,),
            )
            return {d: (o or None, c or None) for d, o, c in cur.fetchall()}
    except Exception as e:
        print(f"  (could not read calling_business_hours: {e} - falling back to defaults)")
        return {}


def within_business_hours(process_key=PROCESS_KEY, now_utc=None):
    """(allowed: bool, explanation: str) for a process's own business-hours window.

    Hours are per process AND per weekday, so Friday can close early and Sunday can be closed
    entirely. Admin-set values come from the calling_business_hours table (edited in the CRM's
    admin panel via /api/admin/business-hours); any day never saved falls back to
    callingProcesses.json's defaults.

    Times are IST wall-clock. Computed as a fixed UTC+5:30 offset (the convention used
    throughout this repo) rather than via zoneinfo: IST has no DST, and zoneinfo needs the
    tzdata package on Windows, which would make this script fail locally for no benefit.

    Gates AUTO-ASSIGNMENT ONLY, deliberately. An agent can still open, claim and dispose leads
    they already hold outside these hours - a call that already happened has to be recordable.
    """
    week = _default_week(process_key)
    week.update(_saved_week(process_key))

    now = (now_utc or datetime.now(timezone.utc)) + timedelta(hours=5, minutes=30)
    day = DAY_KEYS[now.weekday()]
    open_t, close_t = week.get(day, (None, None))
    if not open_t or not close_t:
        return False, f"{day} is closed (now {now:%a %H:%M} IST)"

    try:
        start_h, start_m = (int(x) for x in str(open_t).split(":"))
        end_h, end_m = (int(x) for x in str(close_t).split(":"))
    except (ValueError, AttributeError):
        # Refusing to assign on an unparseable window would silently halt the queue, so this
        # errs the other way and says so loudly instead.
        return True, f"could not parse {day} window {open_t!r}-{close_t!r} - not gating"

    window = f"{open_t}-{close_t} IST"
    minutes = now.hour * 60 + now.minute
    # `close` exclusive, so an 18:30 close stops assigning at 18:30 rather than 18:31.
    if not (start_h * 60 + start_m <= minutes < end_h * 60 + end_m):
        return False, f"{now:%H:%M} IST is outside {day} {window}"
    return True, f"{now:%a %H:%M} IST is within {window}"


def main():
    allowed, why = within_business_hours()
    print(f"Business hours ({PROCESS_KEY}): {why}")
    if not allowed:
        # Not an error: this job runs every 5 minutes around the clock, so most of its runs
        # legitimately fall outside the window. Exiting 0 keeps the workflow green.
        print("Outside business hours - not assigning any leads. Exiting.")
        return

    print(f"Fetching agents available for '{PROCESS_KEY}' from Postgres...")
    online_agents, agent_quotas = fetch_online_agents(PROCESS_KEY)
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
    rto_reason_by_row = {}
    tier_counts = {0: 0, 1: 0, 2: 0, 3: 0}
    already_refunded_rows = []  # row indices confirmed refunded via GoKwik this run

    for i, row in enumerate(rows):
        order_id = cell(row, COL_ORDER_ID)
        if not order_id:
            continue

        # COL_REMARKS_LEGACY_U as well as COL_REMARKS: remarks were written to U for a long
        # time before that was corrected to Z, so a lead whose only evidence of having been
        # worked is a remark in U must still count as disposed - otherwise this would queue
        # already-called customers for another round of calls.
        is_disposed = bool(
            cell(row, COL_CONNECTED) or cell(row, COL_ATTEMPT) or
            cell(row, COL_DISPOSITION) or cell(row, COL_REMARKS) or
            cell(row, COL_REMARKS_LEGACY_U)
        )
        if is_disposed:
            continue  # already worked - not part of either load or the unassigned queue

        agent_raw = cell(row, COL_AGENT).lower()
        is_unassigned = (not agent_raw) or agent_raw == "unassigned"
        rto_initiated_date = parse_rto_initiated_date(cell(row, COL_RTO_INITIATED_DATE))
        payment_method = cell(row, COL_PAYMENT_METHOD)
        tier = priority_tier(payment_method, cell(row, COL_RTO_REASON))

        # Prepaid only - COD has nothing paid upfront to refund before delivery, so there is
        # nothing for GoKwik to have already refunded. Checked only for a lead that would
        # otherwise enter the assignment pool this run; an already-assigned pending lead is
        # left alone regardless; a genuinely disposed one was already skipped above.
        if is_unassigned and is_prepaid(payment_method) and is_already_refunded_via_gokwik(order_id):
            already_refunded_rows.append(i)
            continue  # never enters the unassigned pool - no agent ever sees it

        if is_unassigned:
            unassigned_pending.append((i, rto_initiated_date, order_id, tier))
            awb_code_by_row[i] = cell(row, COL_AWB_CODE)
            rto_reason_by_row[i] = cell(row, COL_RTO_REASON)
            tier_counts[tier] += 1
        elif agent_raw in current_load:
            current_load[agent_raw] += 1
        # else: pending lead already held by someone (eligible or not) - left alone either
        # way. Column Q having any value at all is enough to exempt a lead permanently.

    print(f"  unassigned pool by priority: Prepaid={tier_counts[0]}, COD+high-priority reason={tier_counts[1]}, other COD={tier_counts[2]}, COD+low-priority reason={tier_counts[3]}")

    # Stamped even if nothing else is assignable this run, and BEFORE the early-return below -
    # a confirmed refund shouldn't wait on there being other assignable leads this run. Columns
    # S/T/U are exactly what is_disposed (above) checks, so this permanently marks the row
    # worked for every future run too, not just skipped once.
    if already_refunded_rows:
        print(f"  {len(already_refunded_rows)} prepaid lead(s) confirmed already refunded via GoKwik - stamping, not assigning.")
        refund_value_ranges = [
            {
                "range": f"'{SHEET_TAB}'!S{row_index + 2}:U{row_index + 2}",
                "values": [["Already Refunded", "Already Refunded",
                            "Auto-detected via GoKwik refund status check - not assigned."]],
            }
            for row_index in already_refunded_rows
        ]
        lib.set_sheet_values_batch(SPREADSHEET_ID, refund_value_ranges)

    if not unassigned_pending:
        print("No unassigned pending leads found - nothing to assign.")
        return

    # Per-agent quotas where set for this process (calling_agent_process.max_quota); anyone
    # without one falls back to DEFAULT_QUOTA inside build_assignment_queue.
    assignments = build_assignment_queue(unassigned_pending, online_agents, current_load,
                                         quota=agent_quotas or DEFAULT_QUOTA)

    if not assignments:
        print(f"{len(unassigned_pending)} unassigned lead(s) found, but every eligible agent is already at quota ({DEFAULT_QUOTA}). Nothing to assign.")
        return

    value_ranges = [
        {"range": f"'{SHEET_TAB}'!Q{row_index + 2}", "values": [[email]]}
        for row_index, email in assignments.items()
    ]
    print(f"Writing {len(value_ranges)} Column Q assignment(s)...")
    lib.set_sheet_values_batch(SPREADSHEET_ID, value_ranges)
    record_lead_assignments(assignments, unassigned_pending, awb_code_by_row, rto_reason_by_row)

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
