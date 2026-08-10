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
touched again, WITH ONE DELIBERATE EXCEPTION (see the next paragraph): it
still counts toward that agent's load (so they don't get handed more than
quota), but it is never unassigned or reassigned by this script otherwise,
regardless of quota, regardless of whether that agent is online. An earlier
version trimmed over-quota agents' oldest excess back to unassigned; that
silently cleared a manually-assigned lead and was removed for exactly that
reason - only touch what is genuinely blank (or, now, genuinely
Connected=No).

The one exception: a lead whose Connected column reads "No" - the agent actually called and
didn't reach the customer - is eligible to be handed to a DIFFERENT agent, up to
REASSIGN_RETRY_CAP distinct agents total ever trying the same lead. Every agent who already
failed to connect is excluded from receiving it again (lead_assignments in Postgres keeps one
row per agent who has held the lead - reassigning stamps the outgoing agent's row
reassigned_away_at instead of overwriting it, so that history is never lost) - "old owner
never gets the same lead back." Only leads whose own Calling Date is on
or after REASSIGN_BACKLOG_CUTOFF are eligible - a fixed, one-time boundary chosen when this
shipped, not a rolling window, so the large pre-existing backlog of already-Connected=No leads
is left exactly as it was, while every lead called from that date onward is eligible
indefinitely. A reassigned lead gets Q and R:U wiped back to blank so it looks like a fresh,
never-called lead to its new agent - the previous attempt's history survives only in Postgres,
not on the row itself. A prepaid Connected=No lead that clears both of those tests is then
checked against GoKwik the same as a fresh one (see the next paragraph) - it can have been
refunded through a channel other than this agent's own disposition, and reassigning it would
just have a second agent call a customer who's already been made whole. That check deliberately
comes AFTER the cutoff and the retry cap, not before: those two are free local tests and a lead
they reject is left alone for good, so paying a MySQL+HTTP round-trip for it (as this did
originally) bought nothing - and worse, stamping S/T/U on such a row would have overwritten the
agent's real Attempt/Disposition/remarks, rather than a row that's about to be wiped blank for
its new agent anyway.

Before a still-unassigned PREPAID lead enters the pool, its refund status is checked against
GoKwik (see resolve_refund_statuses) - a customer who's already been refunded should never be
called about their order again. GoKwik doesn't recognise the sheet's own Order ID, so the check
first resolves it to GoKwik's numeric platformOrderId via Item_level_data (see
lookup_platform_order_ids). A confirmed refund gets S/T/U stamped "Already Refunded" on the
sheet - permanently marking the row worked to every other reader, not just skipped this once -
and never reaches the assignment pool. COD is never checked: nothing was paid upfront to
refund before delivery. Every failure mode here - no platform order ID match, missing
credentials, a network error, a non-200 - fails OPEN (assigns normally): one extra call to an
already-refunded customer is preferred over silently stalling a genuinely-pending lead because
of a flaky request.

That check is the only network-bound work in this whole script, so it is deliberately NOT done
inline per lead. The main loop just records which rows still need one (every already-cached
answer is a dict lookup), and all deferred checks are then resolved TOGETHER - one bulk
Item_level_data query covering all of them, then GOKWIK_MAX_CONCURRENCY GoKwik calls in
parallel - before the pool is finalised. Doing it one lead at a time, sequentially, is what
made this script take 8-13 minutes on a 5-minute schedule.
"""
import json
import os
import sys
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
REPO_ROOT = Path(__file__).resolve().parent.parent
import lib
import mysql_lib
from lead_priority import (
    COL_AGENT, COL_ATTEMPT, COL_AWB_CODE, COL_CALLING_DATE, COL_CONNECTED, COL_DISPOSITION,
    COL_ORDER_ID, COL_PAYMENT_METHOD, COL_REMARKS, COL_REMARKS_LEGACY_U,
    COL_RTO_INITIATED_DATE, COL_RTO_REASON,
    DEFAULT_QUOTA, REASSIGN_BACKLOG_CUTOFF, REASSIGN_MIN_HOLD_HOURS, REASSIGN_RETRY_CAP,
    build_assignment_queue, cell, is_prepaid, parse_calling_date,
    parse_rto_initiated_date, prefix_rule_partner, priority_tier,
)

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"

STALE_MINUTES = 10  # must match the CRM's own heartbeat cadence assumptions

# REASSIGN_BACKLOG_CUTOFF, REASSIGN_RETRY_CAP: see leadAssignmentRules.json's _reassignNote -
# imported from lead_priority so the JS "Next to Assign" preview can't drift from these values.

# Item-level DWH schema the GoKwik refund-status lookup resolves a sheet Order ID against -
# see lookup_platform_order_ids.
ITEM_LEVEL_SCHEMA = "mcaff_prod"

GOKWIK_REFUND_STATUS_URL = "https://gkx.gokwik.co/v1/payments/refunds"
GOKWIK_TIMEOUT_SEC = 8

# Written to S and T on a confirmed refund, and read back out of S to tell an already-marked row
# from one that still needs the write - so this string is load-bearing in both directions.
ALREADY_REFUNDED = "Already Refunded"

# A live GoKwik/MySQL check is a real network round-trip, and with hundreds of eligible
# prepaid leads (fresh + Connected=No reassignment candidates combined) checking every one on
# every 5-minute run took 8-13 minutes per run in practice - runs started queuing behind each
# other, delaying assignment for everyone, not just prepaid leads. gokwik_refund_checks caches
# the result per order_id for this long before it's checked again; "not yet refunded" going
# stale after ~2 hours (rather than being checked instantly) is a far better tradeoff than
# every run taking minutes.
#
# A CONFIRMED refund never expires at all, regardless of this TTL - a refund does not
# un-refund, so re-asking GoKwik about it forever is pure cost (see _cached_refund_status).
GOKWIK_CACHE_TTL = timedelta(hours=2)

# Every entry a run writes is stamped with that run's own timestamp, so a flat TTL means they
# all fall due again in the SAME later run - recreating in one 2-hourly spike the exact
# minutes-long stall the cache exists to prevent. Each order's TTL therefore carries up to this
# much extra, derived from a hash of the order_id: deterministic (the same lead always gets the
# same offset, so nothing flaps between runs) but spread across the window.
GOKWIK_CACHE_JITTER = timedelta(hours=1)

# Deferred checks are resolved this many at a time (see resolve_refund_statuses). The MySQL side
# is already one bulk query by then, so this only bounds concurrent HTTPS calls to GoKwik -
# enough to make a cold cache cost seconds instead of minutes, small enough to stay a polite
# neighbour to a payments API we don't own.
GOKWIK_MAX_CONCURRENCY = 8

# Order IDs per Item_level_data IN (...) batch - a few hundred keeps the statement well inside
# any max_allowed_packet while still collapsing what used to be one query per lead.
PLATFORM_ID_BATCH_SIZE = 400

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


def lookup_platform_order_ids(order_ids):
    """{order_id: platform_order_id} for as many of order_ids as Item_level_data can resolve.

    The sheet's own Order ID (Display_Order_Code) isn't what GoKwik knows an order by - GoKwik
    expects its own numeric platformOrderId. Item_level_data carries the mapping, but NOT
    reliably: a Display_Order_Code can have a row per sync channel, and only the '*SHOPIFY'
    channel's Sale_Order_Code is the real GoKwik-recognizable numeric ID - a 'HYPHEN_D2C' row
    for the same order was observed carrying Sale_Order_Code equal to the Display_Order_Code
    itself (a placeholder, not a real platform ID). Oldest-by-Created among the Shopify-channel
    rows picks the original order over any later re-sync. A stray leading backtick (a
    spreadsheet-import artifact seen even in plain numeric IDs, e.g. mCaffeine order 21494) is
    stripped before the numeric check.

    Batched over IN (...) rather than one query per order: each mysql_lib.query is a round-trip
    to RDS, and doing several hundred of them sequentially was half of why a run took minutes.
    ORDER BY Created ASC plus "first row seen for an order wins" reproduces the old per-order
    `LIMIT 1` exactly, without needing a window function this MySQL may not have.

    Returns (resolved, failed), where failed is the set of order_ids whose lookup didn't actually
    run - a batch that errored, or MYSQL_* not configured at all. Never raises: those orders fail
    OPEN downstream (assign as normal) rather than blocking genuinely-pending leads over a flaky
    DB call. They're reported separately from a clean "no such mapping" because only the latter is
    a durable fact about the data and therefore safe to cache - batching makes one dropped
    connection speak for hundreds of orders at once, and caching that as "not refunded" would
    silence real refunds for hours."""
    resolved = {}
    failed = set()
    order_ids = list(order_ids)
    for start in range(0, len(order_ids), PLATFORM_ID_BATCH_SIZE):
        batch = order_ids[start:start + PLATFORM_ID_BATCH_SIZE]
        placeholders = ",".join(["%s"] * len(batch))
        try:
            rows = mysql_lib.query(
                f"""
                SELECT Display_Order_Code, Sale_Order_Code
                FROM Item_level_data
                WHERE Display_Order_Code IN ({placeholders})
                  AND Channel_Name LIKE '%%SHOPIFY%%'
                ORDER BY Created ASC
                """,
                tuple(batch),
                database=ITEM_LEVEL_SCHEMA,
            )
        except Exception as e:
            print(f"    (Item_level_data lookup for {len(batch)} order(s) failed: {e} - "
                  f"treating them as not-refunded)")
            failed.update(batch)
            continue
        if rows is None:  # MYSQL_* not configured - not a statement about these orders
            failed.update(batch)
            continue
        for display_code, sale_order_code in rows:
            if display_code in resolved or not sale_order_code:
                continue  # oldest Shopify row per order wins - later ones are re-syncs
            platform_order_id = str(sale_order_code).strip().lstrip("`")
            if platform_order_id.isdigit():
                resolved[display_code] = platform_order_id
    return resolved, failed


_thread_local = threading.local()


def _gokwik_session():
    """One requests.Session per worker thread. Two reasons: Session isn't documented
    thread-safe, so sharing one across the pool would be a gamble; and keeping a session per
    thread means the pool's calls reuse their TLS connection to gkx.gokwik.co instead of
    re-handshaking per order, which is most of the remaining cost once the per-lead MySQL
    queries are gone."""
    session = getattr(_thread_local, "gokwik_session", None)
    if session is None:
        session = requests.Session()
        _thread_local.gokwik_session = session
    return session


def _check_gokwik_refund_status_live(order_id, platform_order_id, credentials):
    """The actual network check for ONE order, given an already-resolved platform_order_id and
    (app_id, app_secret) - True only on a confirmed GoKwik refund (success + a Completed
    entry). Every other outcome - a network error, a non-200, an unparseable body - returns
    False, per the same fail-open philosophy as lookup_platform_order_ids: never block a real
    pending lead over infrastructure flakiness, only ever skip one that's positively confirmed
    refunded. Runs on a pool thread; go through resolve_refund_statuses rather than calling
    this directly."""
    app_id, app_secret = credentials
    try:
        resp = _gokwik_session().get(
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


def _gokwik_credentials(order_id):
    """(app_id, app_secret) for whichever vendor owns this order, or None if either is
    unconfigured - which fails open, same as every other miss here."""
    vendor = resolve_gokwik_vendor(order_id)
    if vendor is None:
        return None
    app_id = os.environ.get(f"{vendor['env_prefix']}_APPID")
    app_secret = os.environ.get(f"{vendor['env_prefix']}_APPSECRET")
    if not app_id or not app_secret:
        return None
    return app_id, app_secret


def _cached_refund_status(order_id, cache):
    """True/False from the gokwik_refund_checks cache, or None if this order still needs a live
    check. cache is {order_id: (refunded, checked_at)} from fetch_gokwik_refund_cache - one bulk
    read at the start of the run, so this is a dict lookup, not a network call.

    A True entry is TERMINAL and never expires (see GOKWIK_CACHE_TTL's comment); only "not yet
    refunded" ages out, after GOKWIK_CACHE_TTL plus its own deterministic share of
    GOKWIK_CACHE_JITTER so a whole run's worth of entries doesn't fall due together."""
    cached = cache.get(order_id)
    if cached is None:
        return None
    refunded, checked_at = cached
    if refunded:
        return True
    if checked_at is None:
        return None
    jitter = GOKWIK_CACHE_JITTER * (zlib.crc32(order_id.encode("utf-8")) % 1000 / 1000)
    if (datetime.now(timezone.utc) - checked_at) < GOKWIK_CACHE_TTL + jitter:
        return False
    return None


def resolve_refund_statuses(order_ids, dirty):
    """{order_id: refunded} for every order whose check the main loop deferred - resolved all
    together, which is the entire point: one batched Item_level_data lookup for the whole set
    (instead of a query per lead) and then GOKWIK_MAX_CONCURRENCY calls to GoKwik in flight at
    once (instead of strictly one at a time). Same per-order verdict as before, just not
    serialised.

    Results reached on evidence - a live verdict, or a successful lookup that found this order has
    no Shopify platform ID at all - go into dirty, the {order_id: refunded} dict
    flush_gokwik_refund_cache writes back in ONE batched upsert at the end of the run. Caching the
    no-mapping ones matters as much as the verdicts: that's a durable fact about the row, so
    re-deriving it every run would keep the bulk lookup as big as it was on day one. Results that
    are merely the absence of infrastructure - the lookup itself failed, or this vendor's
    GOKWIK_* secrets aren't set - still fail open for THIS run but are deliberately NOT cached, so
    a blip doesn't get frozen in as "not refunded" for hours."""
    order_ids = sorted(order_ids)
    if not order_ids:
        return {}
    print(f"  resolving {len(order_ids)} deferred GoKwik refund check(s)...")
    platform_ids, lookup_failed = lookup_platform_order_ids(order_ids)

    results = {}
    cacheable = {}
    checkable = []  # (order_id, platform_order_id, credentials)
    no_mapping = no_credentials = 0
    for order_id in order_ids:
        platform_order_id = platform_ids.get(order_id)
        if not platform_order_id:
            results[order_id] = False  # fails open
            if order_id not in lookup_failed:
                no_mapping += 1
                cacheable[order_id] = False  # durable: this order has no Shopify platform ID
            continue
        credentials = _gokwik_credentials(order_id)
        if not credentials:
            results[order_id] = False  # fails open, uncached - a missing secret isn't evidence
            no_credentials += 1
            continue
        checkable.append((order_id, platform_order_id, credentials))

    if no_mapping or no_credentials or lookup_failed:
        print(f"    ({no_mapping} with no Shopify platform order ID, {len(lookup_failed)} whose "
              f"lookup failed, {no_credentials} with no vendor credentials - all not-refunded, "
              f"per fail-open)")
    if checkable:
        workers = min(GOKWIK_MAX_CONCURRENCY, len(checkable))
        print(f"    asking GoKwik about {len(checkable)} order(s), {workers} at a time...")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            verdicts = pool.map(lambda args: _check_gokwik_refund_status_live(*args), checkable)
            for (order_id, _platform_order_id, _credentials), refunded in zip(checkable, verdicts):
                results[order_id] = refunded
                cacheable[order_id] = refunded

    dirty.update(cacheable)
    return results


@contextmanager
def _pg_cursor(conn_str, conn):
    """Cursor over `conn` if the caller already has one open (main()'s single connection
    shared across the whole run - see its own comment for why), else a one-off connection
    opened and closed just for this block, unchanged from how every function here used to
    behave on its own. Kept as a context manager, not a plain helper returning a cursor, so
    the "open my own, then close it" case still can't leak a connection on an exception.

    Every caller must still `except` around its own `with _pg_cursor(...) as cur:` block and
    roll back a SHARED conn there (see the shared-connection comment in main()) - a failed
    statement leaves Postgres refusing every later command on that same connection
    ("current transaction is aborted") until something rolls it back, and only the caller
    knows whether the exception was one it's fail-opening past."""
    if conn is not None:
        with conn.cursor() as cur:
            yield cur
        return
    with lib.get_pg_connection(conn_str) as owned_conn:
        with owned_conn.cursor() as cur:
            yield cur


def fetch_gokwik_refund_cache(conn=None):
    """{order_id: (refunded, checked_at)} for every lead ever checked - one bulk read per run,
    same pattern as fetch_reassignment_attempts, so consulting it per-lead in the main loop is
    a dict lookup, not a network call. Creates the table itself (idempotent) rather than
    depending on api/_lib/db.js's ensurePgSchema, since this is Python-only and the whole
    point is not to wait on anything else to take effect. Returns {} (never raises) if
    POSTGRES_URL isn't configured or the query fails - every lead just gets live-checked this
    run, same as before this cache existed.

    conn: reuse main()'s already-open connection instead of opening a new one - see
    _pg_cursor. Optional so this stays directly callable on its own (REPL, one-off script)."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str and conn is None:
        return {}
    try:
        with _pg_cursor(conn_str, conn) as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS gokwik_refund_checks (
                    order_id TEXT PRIMARY KEY,
                    refunded BOOLEAN NOT NULL,
                    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            cur.execute("SELECT order_id, refunded, checked_at FROM gokwik_refund_checks")
            rows = cur.fetchall()
        if conn is not None:
            conn.commit()  # DDL/read on the shared connection - commit so it isn't left open
    except Exception as e:
        print(f"  (gokwik_refund_checks fetch failed: {e} - every lead will be live-checked this run)")
        if conn is not None:
            conn.rollback()
        return {}
    return {order_id: (refunded, checked_at) for order_id, refunded, checked_at in rows}


def flush_gokwik_refund_cache(dirty, conn=None):
    """One batched upsert for every result computed this run - not one write per lead, which
    would defeat the point of caching by adding back a per-lead network round-trip. Best
    effort: a failure here just means those results get live-checked again next run.

    conn: see fetch_gokwik_refund_cache - reuse main()'s connection when given."""
    if not dirty:
        return
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str and conn is None:
        return
    try:
        with _pg_cursor(conn_str, conn) as cur:
            cur.executemany(
                """
                INSERT INTO gokwik_refund_checks (order_id, refunded, checked_at)
                VALUES (%s, %s, now())
                ON CONFLICT (order_id) DO UPDATE SET
                    refunded = EXCLUDED.refunded, checked_at = now()
                """,
                list(dirty.items()),
            )
        if conn is not None:
            conn.commit()
    except Exception as e:
        print(f"  (failed to save {len(dirty)} gokwik_refund_checks entries: {e})")
        if conn is not None:
            conn.rollback()


def fetch_reassignment_attempts(conn=None):
    """{order_id: {emails}} of every agent a lead has ever been reassigned AWAY from - the
    rows lead_assignments keeps with reassigned_away_at set (see api/_lib/db.js's
    ensurePgSchema: reassigning stamps the old agent's row rather than overwriting it, so
    that table holds one row per agent who ever tried a lead, not just its current one).
    Returns {} (never raises) if POSTGRES_URL isn't configured or the query fails - a lookup
    failure here should fail open (treat every lead as having no reassignment history yet,
    exactly the pre-this-feature behavior) rather than block the whole run.

    conn: reuse main()'s already-open connection instead of opening a new one - see
    _pg_cursor. Optional so this stays directly callable on its own (REPL, one-off script)."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str and conn is None:
        return {}
    try:
        with _pg_cursor(conn_str, conn) as cur:
            cur.execute("SELECT order_id, email FROM lead_assignments WHERE reassigned_away_at IS NOT NULL")
            rows = cur.fetchall()
    except Exception as e:
        print(f"  (lead_assignments reassignment-history fetch failed: {e} - treating as no prior attempts)")
        if conn is not None:
            conn.rollback()
        return {}
    attempts_by_order = {}
    for order_id, email in rows:
        attempts_by_order.setdefault(order_id, set()).add((email or "").lower())
    return attempts_by_order


def fetch_current_assignment_times(conn=None):
    """{order_id: assigned_at} (naive UTC datetime) for every lead's CURRENT live assignment
    cycle - the lead_assignments row with reassigned_away_at IS NULL (see api/_lib/db.js's
    ensurePgSchema: exactly one such row can exist per order_id at a time). Used only to hold a
    Connected=No lead back from reassignment until its current agent has had a full
    REASSIGN_MIN_HOLD_HOURS to actually reach the customer - without this, a lead could be
    reassigned minutes after its original assignment, before the agent ever had a fair shot.
    Same fail-open contract as fetch_reassignment_attempts: {} (never raises) if POSTGRES_URL
    isn't configured or the query fails, so a lookup problem here never blocks the whole run -
    it just means the hold can't be enforced this run, same as before this existed.

    conn: see fetch_reassignment_attempts - reuse main()'s connection when given."""
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str and conn is None:
        return {}
    try:
        with _pg_cursor(conn_str, conn) as cur:
            cur.execute("SELECT order_id, assigned_at FROM lead_assignments WHERE reassigned_away_at IS NULL")
            rows = cur.fetchall()
    except Exception as e:
        print(f"  (lead_assignments current-assignment-time fetch failed: {e} - treating as no hold)")
        if conn is not None:
            conn.rollback()
        return {}
    # assigned_at comes back tz-aware (TIMESTAMPTZ) - kept that way, same as checked_at in
    # _cached_refund_status above, so it compares directly against datetime.now(timezone.utc).
    return dict(rows)


def fetch_online_agents(process_key=None, conn=None):
    """(emails, quotas, prepaid_targets, specializations, reassign_payment_modes) of the agents
    eligible for this process's leads right now.

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
    fall back to DEFAULT_QUOTA in build_assignment_queue. prepaid_targets/specializations are
    the same idea for build_assignment_queue's agent_prepaid_target/agent_specializations -
    agents absent from either dict get no steering/specialization at all, same as before those
    columns existed. specializations values are already lowercased, comma-split, and blank-
    filtered here so build_assignment_queue's matching stays a plain substring test.
    reassign_payment_modes is {email: 'Prepaid' or 'COD'} for build_assignment_queue's
    agent_reassign_payment_mode - a HARD filter, unlike the three above, but the same "absent
    means unrestricted" contract: an agent with no row, or an empty/NULL value, is eligible for
    a reassignment of either payment type, same as before this column existed.

    Returns ([], {}, {}, {}, {}) (not an error) if POSTGRES_URL isn't configured, so a missing
    secret fails safe - no assignment - rather than crashing the whole run.

    conn: reuse main()'s already-open connection instead of opening a new one - see
    _pg_cursor. Optional so this stays directly callable on its own (REPL, one-off script).
    """
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str and conn is None:
        print("POSTGRES_URL not configured - cannot determine online agents.")
        return [], {}, {}, {}, {}
    with _pg_cursor(conn_str, conn) as cur:
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
            return present, {}, {}, {}, {}

        try:
            cur.execute(
                "SELECT email, status, max_quota, prepaid_pct, priority_rto_reasons, "
                "reassign_payment_mode FROM calling_agent_process WHERE process_key = %s",
                (process_key,),
            )
            per_process = cur.fetchall()
        except Exception as e:
            # Table not created yet (no admin has opened the panel) - fall back rather than
            # refuse to assign, which would stop the queue over a missing config table.
            print(f"  (calling_agent_process unavailable: {e} - using global presence)")
            if conn is not None:
                conn.rollback()
            return present, {}, {}, {}, {}

    if not per_process:
        print(f"  no per-process availability set for '{process_key}' - using global presence")
        return present, {}, {}, {}, {}

    online_for_process = {e.lower() for e, status, _, _, _, _ in per_process if status == "Online"}
    quotas = {e.lower(): q for e, _, q, _, _, _ in per_process if q is not None}
    prepaid_targets = {e.lower(): pct for e, _, _, pct, _, _ in per_process if pct is not None}
    specializations = {}
    for e, _, _, _, reasons, _ in per_process:
        parsed = [r.strip().lower() for r in (reasons or "").split(",") if r.strip()]
        if parsed:
            specializations[e.lower()] = parsed
    reassign_payment_modes = {e.lower(): mode for e, _, _, _, _, mode in per_process if mode}
    eligible = sorted(online_for_process & set(present))
    if online_for_process and not eligible:
        print(f"  {len(online_for_process)} agent(s) marked Online for '{process_key}', but none are "
              f"heartbeat-fresh (within {STALE_MINUTES}m) - nobody is actually at their desk.")
    return eligible, quotas, prepaid_targets, specializations, reassign_payment_modes


def record_lead_assignments(assignments, unassigned_pending, awb_code_by_row, rto_reason_by_row,
                            reassign_info_by_row, conn=None):
    """Stamps assigned_at=now() for every lead just assigned, keyed by the sheet's own Order
    ID, so rto-crm.html's resetStalePendingLeads() can tell a fresh assignment apart from a
    genuinely stale one (the lead's own Calling Date can't do this - the backlog this script
    distributes is old by definition). Best-effort: if POSTGRES_URL isn't configured,
    silently skips (fetch_online_agents() would already have returned [] in that case, so in
    practice this only runs when the DB is reachable anyway).

    Handles BOTH halves of a reassignment, in ONE transaction, because they are only correct
    together: first stamp reassigned_away_at on the outgoing agent's row (retiring their
    cycle and preserving how it went), then write the incoming agent's row. Splitting these
    across two connections - as an earlier version did - risks landing the retire without
    the insert, leaving a lead with no live cycle at all: invisible to
    recentAssignments/KPIs, even though the sheet says it is assigned. Postgres either takes
    both or neither.

    That order also matters within the transaction: lead_assignments_order_id_current_key and
    lead_assignments_awb_code_key (see api/_lib/db.js's ensurePgSchema) each permit only one
    live row per lead / per AWB, and a reassigned lead's successive cycles share both values,
    so the outgoing cycle has to leave those indexes before the incoming one can enter.

    The retire matches on order_id alone - never on the outgoing agent's email. At most one
    live row exists per order_id, so it is already unambiguous, and matching email too would
    make any case/whitespace drift between the sheet's Column Q and the stored value silently
    fail to retire the row - which would then collide on the unique index and abort every
    assignment in this batch.

    The insert stays an upsert on the live-cycle index, exactly as before this table was
    re-grained: a genuinely new assignment inserts, while a lead that somehow already has a
    live row (the same Order ID appearing on two sheet rows, most plausibly) updates it
    rather than raising a unique violation and losing the whole batch. COALESCE on
    awb_code/rto_reason/delivery_partner so a re-run never clobbers a value already recorded
    by the disposal write path (api/_lib/db.js's recordLeadDisposition) with a blank one.

    Also stamps awb_code, rto_reason (the sheet's own Column D - see
    lead_priority.COL_RTO_REASON), and delivery_partner (derived from awb_code via
    lead_priority.prefix_rule_partner - the same rule api/_lib/db.js's JS mirror uses for
    leads recorded via the disposal path instead) so downstream reporting
    (scripts/sync_lead_assignments_to_mysql.py) can key on any of them without a separate
    sheet lookup.

    conn: reuse main()'s already-open connection instead of opening a new one - see
    _pg_cursor's comment on why every caller sharing it must roll back on failure. This one
    still commits/rolls back explicitly itself either way (rather than leaning on a bare
    `with` exit like the read-only fetch_* functions above) because on a shared conn the
    caller keeps using that connection afterwards, so leaving it mid-transaction on the way
    out isn't an option."""
    conn_str = os.environ.get("POSTGRES_URL")
    if (not conn_str and conn is None) or not assignments:
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
    # Only for rows actually being assigned this run - reassign_info_by_row can still hold a
    # row whose assignment got dropped (over quota, no eligible agent), and retiring that
    # lead's live cycle when nobody is taking it over would strand it with no current row.
    retiring = [
        (order_id,)
        for row_index, (_old_agent, order_id) in reassign_info_by_row.items()
        if row_index in assignments
    ]
    owns_conn = conn is None
    if owns_conn:
        conn = lib.get_pg_connection(conn_str)
    try:
        with conn.cursor() as cur:
            if retiring:
                cur.executemany(
                    """
                    UPDATE lead_assignments SET reassigned_away_at = now()
                    WHERE order_id = %s AND reassigned_away_at IS NULL
                    """,
                    retiring,
                )
            cur.executemany(
                """
                INSERT INTO lead_assignments (order_id, email, assigned_at, awb_code, rto_reason, delivery_partner)
                VALUES (%s, %s, now(), %s, %s, %s)
                ON CONFLICT (order_id) WHERE reassigned_away_at IS NULL DO UPDATE SET
                    email = EXCLUDED.email,
                    assigned_at = now(),
                    awb_code = COALESCE(EXCLUDED.awb_code, lead_assignments.awb_code),
                    rto_reason = COALESCE(EXCLUDED.rto_reason, lead_assignments.rto_reason),
                    delivery_partner = COALESCE(EXCLUDED.delivery_partner, lead_assignments.delivery_partner)
                """,
                rows,
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        if owns_conn:
            conn.close()


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


def _saved_week(process_key, conn=None):
    """This process's week as saved by an admin: {day: (open, close)}. Days with no row are
    absent, and a row with either time NULL/'' means explicitly CLOSED that day. Returns {} if
    the table isn't reachable/doesn't exist yet, so a fresh environment still runs on defaults
    rather than refusing to assign anything.

    conn: reuse main()'s already-open connection instead of opening a new one - see
    _pg_cursor. Optional so this stays directly callable on its own (REPL, one-off script)."""
    dsn = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not dsn and conn is None:
        return {}
    try:
        with _pg_cursor(dsn, conn) as cur:
            cur.execute(
                "SELECT day, open_time, close_time FROM calling_business_hours WHERE process_key = %s",
                (process_key,),
            )
            return {d: (o or None, c or None) for d, o, c in cur.fetchall()}
    except Exception as e:
        print(f"  (could not read calling_business_hours: {e} - falling back to defaults)")
        if conn is not None:
            conn.rollback()
        return {}


def within_business_hours(process_key=PROCESS_KEY, now_utc=None, conn=None):
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
    week.update(_saved_week(process_key, conn=conn))

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
    # One Postgres connection for the whole run, threaded through every call below instead of
    # each fetch/record opening (and Supabase-pooler-contending for) its own - this used to be
    # up to 7 separate connections per 5-minute cron run. Opened here rather than inside
    # within_business_hours (the first thing that needs it) so there is exactly one place that
    # owns closing it, on every exit path including the early `return`s below - see _main.
    conn_str = os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL")
    conn = lib.get_pg_connection(conn_str) if conn_str else None
    try:
        _main(conn)
    finally:
        if conn is not None:
            conn.close()


def _main(conn):
    allowed, why = within_business_hours(conn=conn)
    print(f"Business hours ({PROCESS_KEY}): {why}")
    if not allowed:
        # Not an error: this job runs every 5 minutes around the clock, so most of its runs
        # legitimately fall outside the window. Exiting 0 keeps the workflow green.
        print("Outside business hours - not assigning any leads. Exiting.")
        return

    print(f"Fetching agents available for '{PROCESS_KEY}' from Postgres...")
    online_agents, agent_quotas, agent_prepaid_targets, agent_specializations, agent_reassign_payment_modes = fetch_online_agents(PROCESS_KEY, conn=conn)
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

    print("Fetching prior Connected=No reassignment history from Postgres...")
    attempts_by_order = fetch_reassignment_attempts(conn=conn)
    current_assigned_at_by_order = fetch_current_assignment_times(conn=conn)

    print("Fetching cached GoKwik refund-check results from Postgres...")
    gokwik_cache = fetch_gokwik_refund_cache(conn=conn)
    gokwik_dirty = {}  # order_id -> refunded, for every result computed live this run

    # current_load: how many pending (undisposed) leads each eligible agent already holds -
    # still needed so an agent already at or over quota doesn't get handed more, but a lead
    # counted here is NEVER unassigned or reassigned by this script, no matter how high the
    # count goes. Only genuinely blank/Unassigned Column Q values are ever written to.
    current_load = {email: 0 for email in online_agents}
    unassigned_pending = []  # (row_index, rto_initiated_date, order_id, tier)
    awb_code_by_row = {}
    rto_reason_by_row = {}
    already_refunded_rows = []  # row indices confirmed refunded via GoKwik this run
    excluded_by_row = {}  # row_index -> {emails} who must not receive this lead (see below)
    reassign_info_by_row = {}  # row_index -> (old_agent, order_id), for rows being reassigned
    refund_check_by_row = {}  # row_index -> order_id whose GoKwik check is deferred (see below)

    def refund_known_already(row_index, order_id):
        """True only if the cache ALREADY says this prepaid lead was refunded, in which case the
        caller skips it right here. A cache miss instead defers the check to
        resolve_refund_statuses after this loop (returning False, i.e. "queue it for now") - the
        row is provisionally admitted to the pool and dropped again below if the check comes back
        refunded. Nothing in this loop may block on the network: doing so, one lead at a time, is
        what made this script overrun its own 5-minute schedule."""
        cached = _cached_refund_status(order_id, gokwik_cache)
        if cached:
            already_refunded_rows.append(row_index)
            return True
        if cached is None:
            refund_check_by_row[row_index] = order_id
        return False

    for i, row in enumerate(rows):
        order_id = cell(row, COL_ORDER_ID)
        if not order_id:
            continue

        connected = cell(row, COL_CONNECTED)
        agent_raw = cell(row, COL_AGENT).lower()

        # Connected=No reassignment - deliberately checked BEFORE the general is_disposed
        # test below, since a non-empty Connected value would otherwise make this row look
        # permanently worked forever, same as any other disposition. Only for a lead that
        # already has a real agent (someone was actually called and didn't pick up) - a
        # fresh/unassigned lead can't have a Connected value at all.
        if agent_raw and agent_raw != "unassigned" and connected.strip().lower() == "no":
            # Backlog cutoff and retry cap FIRST - they're free local tests, and a lead either
            # rejects is left alone for good, so there's nothing to learn from GoKwik about it.
            # (The reverse order shipped first and cost a MySQL+HTTP round-trip for every
            # Connected=No prepaid lead in the sheet, most of them pre-cutoff backlog that was
            # then discarded anyway - and it could stamp S/T/U "Already Refunded" over a real
            # agent's Attempt/Disposition/remarks on a row that was NOT about to be wiped for a
            # new agent. Both gone with this ordering.)
            calling_date = parse_calling_date(cell(row, COL_CALLING_DATE))
            prior_agents = attempts_by_order.get(order_id, set()) | {agent_raw}
            # Held back from reassignment until the current agent has had a full
            # REASSIGN_MIN_HOLD_HOURS since the real assigned_at (not Calling Date) - a
            # temporary, rolling hold, unlike the cutoff/cap below: the lead isn't stamped
            # anything here, so it simply re-enters this same check on the next run once the
            # window has passed. current_assigned_at_by_order is missing/None for a lead
            # assigned before this table was tracking assigned_at, which is treated as "no
            # hold" (assign_at unknown) rather than blocking it forever.
            assigned_at = current_assigned_at_by_order.get(order_id)
            recently_assigned = bool(assigned_at) and (
                datetime.now(timezone.utc) - assigned_at < timedelta(hours=REASSIGN_MIN_HOLD_HOURS)
            )
            if (calling_date and calling_date >= REASSIGN_BACKLOG_CUTOFF
                    and len(prior_agents) < REASSIGN_RETRY_CAP
                    and not recently_assigned):
                payment_method = cell(row, COL_PAYMENT_METHOD)

                # Same GoKwik refund check as the fresh-lead path further below (prepaid only -
                # COD has nothing paid upfront to refund) - a Connected=No lead can ALSO already
                # be refunded through a channel other than this agent's own disposition (e.g.
                # support processed it directly outside the CRM). This branch has its own
                # `continue`s below and would otherwise never reach that other check at all -
                # confirmed for real on HYP39615010, which got reassigned despite GoKwik already
                # showing it refunded, before this was added.
                if is_prepaid(payment_method) and refund_known_already(i, order_id):
                    continue

                rto_initiated_date = parse_rto_initiated_date(cell(row, COL_RTO_INITIATED_DATE))
                tier = priority_tier(payment_method, cell(row, COL_RTO_REASON))
                unassigned_pending.append((i, rto_initiated_date, order_id, tier))
                awb_code_by_row[i] = cell(row, COL_AWB_CODE)
                rto_reason_by_row[i] = cell(row, COL_RTO_REASON)
                excluded_by_row[i] = prior_agents
                reassign_info_by_row[i] = (agent_raw, order_id)
                continue
            # else: retry cap reached (this many distinct agents have all failed to connect), or
            # Calling Date before the backlog cutoff (or unparseable), or still within its
            # REASSIGN_MIN_HOLD_HOURS hold - fall through to is_disposed below. The first two are
            # permanent (left alone for good); the hold is temporary and unstamped, so the lead
            # simply re-enters this same check next run once the window passes. The cutoff is the
            # one-time migration boundary: the large pre-existing backlog of already-Connected=No
            # leads is never touched by this.

        # COL_REMARKS_LEGACY_U as well as COL_REMARKS: remarks were written to U for a long
        # time before that was corrected to Z, so a lead whose only evidence of having been
        # worked is a remark in U must still count as disposed - otherwise this would queue
        # already-called customers for another round of calls.
        is_disposed = bool(
            connected or cell(row, COL_ATTEMPT) or
            cell(row, COL_DISPOSITION) or cell(row, COL_REMARKS) or
            cell(row, COL_REMARKS_LEGACY_U)
        )
        if is_disposed:
            continue  # already worked - not part of either load or the unassigned queue

        is_unassigned = (not agent_raw) or agent_raw == "unassigned"
        rto_initiated_date = parse_rto_initiated_date(cell(row, COL_RTO_INITIATED_DATE))
        payment_method = cell(row, COL_PAYMENT_METHOD)
        tier = priority_tier(payment_method, cell(row, COL_RTO_REASON))

        # Prepaid only - COD has nothing paid upfront to refund before delivery, so there is
        # nothing for GoKwik to have already refunded. Checked only for a lead that would
        # otherwise enter the assignment pool this run; an already-assigned pending lead is
        # left alone regardless; a genuinely disposed one was already skipped above.
        if is_unassigned and is_prepaid(payment_method) and refund_known_already(i, order_id):
            continue  # never enters the unassigned pool - no agent ever sees it

        if is_unassigned:
            unassigned_pending.append((i, rto_initiated_date, order_id, tier))
            awb_code_by_row[i] = cell(row, COL_AWB_CODE)
            rto_reason_by_row[i] = cell(row, COL_RTO_REASON)
        elif agent_raw in current_load:
            current_load[agent_raw] += 1
        # else: pending lead already held by someone (eligible or not) - left alone either
        # way. Column Q having any value at all is enough to exempt a lead permanently.

    # Every refund check the loop deferred, settled in one go now that the full candidate set is
    # known - see resolve_refund_statuses. A lead that comes back refunded is retracted from the
    # pool it was provisionally added to, exactly as if the loop had skipped it inline.
    if refund_check_by_row:
        statuses = resolve_refund_statuses(set(refund_check_by_row.values()), gokwik_dirty)
        refunded_rows = {i for i, order_id in refund_check_by_row.items() if statuses.get(order_id)}
        if refunded_rows:
            already_refunded_rows.extend(sorted(refunded_rows))
            unassigned_pending = [e for e in unassigned_pending if e[0] not in refunded_rows]
            for i in refunded_rows:
                awb_code_by_row.pop(i, None)
                rto_reason_by_row.pop(i, None)
                excluded_by_row.pop(i, None)
                reassign_info_by_row.pop(i, None)

    # Counted from the final pool rather than tallied during the loop, so retracted refunds can't
    # leave the printed breakdown disagreeing with what actually gets assigned.
    tier_counts = {0: 0, 1: 0, 2: 0, 3: 0}
    for _row_index, _rto_initiated_date, _order_id, tier in unassigned_pending:
        tier_counts[tier] += 1

    if reassign_info_by_row:
        print(f"  {len(reassign_info_by_row)} Connected=No lead(s) eligible for reassignment (under the {REASSIGN_RETRY_CAP}-attempt cap).")
    print(f"  unassigned pool by priority: Prepaid={tier_counts[0]}, COD+high-priority reason={tier_counts[1]}, other COD={tier_counts[2]}, COD+low-priority reason={tier_counts[3]}")

    # Stamped even if nothing else is assignable this run, and BEFORE the early-return below -
    # a confirmed refund shouldn't wait on there being other assignable leads this run. Columns
    # S/T/U are exactly what is_disposed (above) checks, so this permanently marks the row
    # worked for every future run too, not just skipped once.
    if already_refunded_rows:
        # Only rows not already carrying the mark are written. A Connected=No row keeps its "No"
        # forever, so it re-enters the reassignment branch on every single run - and since a
        # confirmed refund is now cached permanently, it would otherwise re-stamp the same three
        # cells with the same three values every 5 minutes indefinitely, growing this batch write
        # without ever changing anything.
        to_stamp = [i for i in already_refunded_rows
                    if cell(rows[i], COL_ATTEMPT).strip() != ALREADY_REFUNDED]
        print(f"  {len(already_refunded_rows)} prepaid lead(s) confirmed already refunded via "
              f"GoKwik - not assigning ({len(to_stamp)} newly stamped).")
        if to_stamp:
            refund_value_ranges = [
                {
                    "range": f"'{SHEET_TAB}'!S{row_index + 2}:U{row_index + 2}",
                    "values": [[ALREADY_REFUNDED, ALREADY_REFUNDED,
                                "Auto-detected via GoKwik refund status check - not assigned."]],
                }
                for row_index in to_stamp
            ]
            lib.set_sheet_values_batch(SPREADSHEET_ID, refund_value_ranges)

    # Flushed before the early-return below too, for the same reason as the refund stamps
    # above - a run that found nothing assignable still did real GoKwik/MySQL work this run,
    # and throwing that away would mean re-checking the exact same leads live again next run,
    # defeating the entire point of the cache.
    if gokwik_dirty:
        confirmed = sum(1 for refunded in gokwik_dirty.values() if refunded)
        print(f"  Caching {len(gokwik_dirty)} GoKwik refund-check result(s) - {confirmed} refunded "
              f"(kept permanently), {len(gokwik_dirty) - confirmed} not (re-checked after "
              f"{GOKWIK_CACHE_TTL} + jitter)...")
        flush_gokwik_refund_cache(gokwik_dirty, conn=conn)

    if not unassigned_pending:
        print("No unassigned pending leads found - nothing to assign.")
        return

    # Per-agent quotas where set for this process (calling_agent_process.max_quota); anyone
    # without one falls back to DEFAULT_QUOTA inside build_assignment_queue. excluded_by_row
    # keeps a Connected=No reassignment away from every agent who already failed to reach
    # that customer - empty/absent for every genuinely fresh lead, so their assignment is
    # unaffected.
    assignments = build_assignment_queue(unassigned_pending, online_agents, current_load,
                                         quota=agent_quotas or DEFAULT_QUOTA,
                                         excluded_by_row=excluded_by_row,
                                         rto_reason_by_row=rto_reason_by_row,
                                         agent_specializations=agent_specializations,
                                         agent_prepaid_target=agent_prepaid_targets,
                                         agent_reassign_payment_mode=agent_reassign_payment_modes)

    if not assignments:
        print(f"{len(unassigned_pending)} unassigned lead(s) found, but every eligible agent is already at quota (or excluded) for each. Nothing to assign.")
        return

    # A reassigned row gets Q (new agent) AND R:U wiped back to blank in one write - it must
    # look exactly like a fresh, never-called lead to the new agent, not carry the previous
    # agent's Connected/Attempt/Disposition/legacy-remarks forward. Z (remarks) is a separate
    # range since it isn't contiguous with Q:U. A fresh (non-reassigned) lead is untouched
    # beyond its own Column Q write, exactly as before this feature existed.
    value_ranges = []
    for row_index, email in assignments.items():
        if row_index in reassign_info_by_row:
            value_ranges.append({
                "range": f"'{SHEET_TAB}'!Q{row_index + 2}:U{row_index + 2}",
                "values": [[email, "", "", "", ""]],
            })
            value_ranges.append({"range": f"'{SHEET_TAB}'!Z{row_index + 2}", "values": [[""]]})
        else:
            value_ranges.append({"range": f"'{SHEET_TAB}'!Q{row_index + 2}", "values": [[email]]})
    reassigned_count = sum(1 for row_index in assignments if row_index in reassign_info_by_row)
    print(f"Writing {len(assignments)} assignment(s) ({reassigned_count} of them Connected=No reassignments)...")
    lib.set_sheet_values_batch(SPREADSHEET_ID, value_ranges)

    # Recorded AFTER the sheet write succeeds, not before - a reassignment that never actually
    # reached the sheet has no old agent to permanently exclude yet. Both halves of each
    # reassignment (retire the old agent's cycle, record the new one) happen inside this one
    # call, in one transaction - see its docstring for why they can't be separated.
    record_lead_assignments(assignments, unassigned_pending, awb_code_by_row, rto_reason_by_row,
                            reassign_info_by_row, conn=conn)

    per_agent = {}
    for email in assignments.values():
        per_agent[email] = per_agent.get(email, 0) + 1
    print("Done. Assigned:")
    for email, count in sorted(per_agent.items()):
        print(f"  {email}: +{count}")
    skipped = len(unassigned_pending) - len(assignments)
    if skipped > 0:
        print(f"  ({skipped} unassigned lead(s) left over - all eligible agents at quota or excluded for that specific lead)")


if __name__ == "__main__":
    main()
