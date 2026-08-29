"""Mirrors resolved Delivery-class tickets straight from Flowcall's own API into
PEP_CLS.Delivery_escalation. Run every 2 hours via GitHub Actions (see
.github/workflows/sync-delivery-tickets.yml).

Used to read from the hyphen_tickets/mcaff_tickets MySQL tables instead - an external,
out-of-repo process fed those from Flowcall. That process silently stopped on 2026-08-25 (the
same day Flowcall's own "Created At" format changed - see lib.CREATED_AT_PATTERN) and both
tables went dark for 4+ days before anyone noticed, with this job dutifully finding "0 tickets"
every run because its source had gone empty, not because it was broken. Reading Flowcall's API
directly removes that unmonitored middle-man entirely - one fewer thing that can silently die
without this job (or the report it feeds) ever showing an error.

Used to ALSO paste these into the HYPHEN/mCaffeine tabs of the "Internal Escalation" Google
Sheet - that write is gone. The sheet was the original ticket source before Delivery_escalation
existed; this job kept writing to both while the CRM (app/delivery-escalation/) migrated over,
and nothing left reads the sheet copy. MySQL is now the only destination, and the ONLY correct
one - keeping a second write path alive after nothing reads it just doubles the ways this job
can fail.

Only 12 columns have a source here (brand/order_id/awb_code/delivery_partner/query_class/
query_category/wh_name/Shipping_Address_City, plus added_date/order_date/order_month/query_date/
query_month) - the rest (delivered_date, status_as_per_awb, tat, etc.) come from a separate
logistics-tracking pipeline this job doesn't touch, so they're left NULL on job-inserted rows.

Shipping_Address_City is looked up from mcaff_prod's Item_level_data by AWB (Tracking_Number),
same source/batched-IN/latest-row-wins pattern fill_missing_awb already uses for awb_code itself
- see fetch_city_by_awb. Refreshed on every upsert via COALESCE, same as awb_code below: a run
whose lookup happens to miss (AWB not in Item_level_data yet) never blanks out a value an earlier
run already found.

ticket_number is this job's own dedup key, same as when it lived in a sheet column - but the
dedup itself no longer needs a "read what's already there" pass: DELIVERY_ESCALATION_INSERT is
an upsert (ON DUPLICATE KEY UPDATE against the table's own dedup_key, IF(ticket_number is set,
brand+ticket_number, brand+awb_code)), so re-running this on a ticket already mirrored just
re-writes the same row instead of duplicating it. That makes every run idempotent for free,
including re-running the same window or a --since backfill that overlaps an earlier run - the
same property that made it safe to point this job straight at Flowcall for the 2026-08-25 gap
without any special-casing.

NOT a merge with the dispose-flow row for the same ticket, even though dedup_key was clearly
built to make that possible - this job supplies ticket_number, so its rows key off the
ticket_number branch of dedup_key. api/_lib/db.js's disposeDeliveryEscalationTicket does NOT put
ticket_number in its own INSERT (despite having it on the ticket object via ticketSnapshot), so
ITS rows key off the awb_code branch instead. Different dedup_key branch -> a ticket this job
pre-inserts and later gets resolved by an agent ends up as TWO rows, not one filled-in row.
Fixing this means adding ticket_number to disposeDeliveryEscalationTicket's INSERT - deliberately
not done here, out of this change's scope.
"""
import argparse
import csv
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib
import delivery_escalation_contact_stats
import auto_dispose_de_categories
from lead_priority import prefix_rule_partner
from export_recurring import fetch_export_csv
from push_mcaffeine_to_dashboard import parse_created_at

# Brand -> (Flowcall tab name, env var holding that tab's Flowcall API bearer token). Same two
# tokens/tabs export_recurring.py already uses for the Sheets pipeline - this job pulls the same
# feed, independently, straight into MySQL.
BRANDS = {
    "HYPHEN": ("hyphen", "FLOWCALL_TOKEN_HYPHEN"),
    "mCaffeine": ("mcaffeine", "FLOWCALL_TOKEN_MCAFFEINE"),
}

# Same exclusion the old hyphen_tickets/mcaff_tickets query applied via
# "subcategory NOT IN (...)" - kept identical so switching source doesn't change which tickets
# land in Delivery_escalation.
EXCLUDED_SUBCATEGORIES = {"Estimated time of delivery", "Late/Delay Dispatch"}

# "Marked Undelivered" and "Fake update" are the same real-world case (courier reports a
# delivery attempt/failure that never actually happened) surfaced under two different
# subcategory labels - collapsed onto one (query_category = "Fake update") so the report and
# every filter/bucket built on query_category don't have to treat them separately.
QUERY_CATEGORY_ALIASES = {"Marked Undelivered": "Fake update"}

# Tracks the last successful window end per tab, same pattern (and same idea, separate file)
# as export_recurring.py's own resolved-ticket-export-state.json - a run that fires late still
# catches up the full gap instead of dropping it. Only advanced by normal (non---since) runs;
# a manual --since backfill is a one-off catch-up and must never move this job's own cursor.
STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "delivery-escalation-sync-state.json"


def get_state():
    if not STATE_PATH.exists():
        return {}
    with open(STATE_PATH, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=4)


def format_month(dt):
    if dt is None:
        return ""
    return f"{dt.month}_{dt.strftime('%b')}'{dt.strftime('%y')}"


def parse_order_date(s):
    """Disposition: Order date arrives ISO-8601 ('2026-08-20T02:18:43.000Z' or without the
    milliseconds) - unlike Created At/Resolved At, Flowcall hasn't changed this one's format."""
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def fetch_flowcall_delivery_rows(flowcall_tab, api_token, start_str, end_str):
    """Same 10-tuple shape fetch_today_delivery_tickets used to return (ticket_number,
    subcategory, order_name, disposition_order, awb, partner, order_date, created_at,
    resolved_at, warehouse), sourced straight from Flowcall's tickets-export API instead of the
    hyphen_tickets/mcaff_tickets mirror - so build_delivery_escalation_row/fill_missing_awb/etc
    below needed no changes at all, only their input source did."""
    csv_text = fetch_export_csv(api_token, flowcall_tab, start_str, end_str)
    rows = list(csv.reader(io.StringIO(csv_text)))
    if len(rows) <= 1:
        return []
    headers = rows[0]
    idx = {h: i for i, h in enumerate(headers)}

    def get(row, name):
        i = idx.get(name)
        return row[i].strip() if i is not None and i < len(row) else ""

    out = []
    for row in rows[1:]:
        if get(row, "Disposition: Query Class") != "Delivery":
            continue
        subcategory = get(row, "Subcategory") or None
        if subcategory in EXCLUDED_SUBCATEGORIES:
            continue
        subcategory = QUERY_CATEGORY_ALIASES.get(subcategory, subcategory)
        ticket_number = get(row, "Ticket Number")
        if not ticket_number:
            continue
        out.append((
            ticket_number,
            subcategory,
            get(row, "Order Name") or None,
            get(row, "Disposition: Order") or None,
            get(row, "Disposition: AWB number") or None,
            get(row, "Disposition: partner_name") or None,
            parse_order_date(get(row, "Disposition: Order date")),
            parse_created_at(get(row, "Created At")),
            parse_created_at(get(row, "Resolved At")),
            get(row, "Disposition: warehouse name") or None,
        ))
    return out


MCAFF_ORDER_PREFIX = "MCaff"


def _awb_lookup_key(parent_order):
    """Item_level_data.Display_Order_Code drops the 'MCaff' brand prefix for
    mCaffeine orders - MCaff9097914 is stored there as plain 9097914 - while
    HYPHEN/Fien orders keep their prefix as-is. Strip it here, at the query
    boundary, so callers/output still key off the ticket's own parent_order."""
    if parent_order.startswith(MCAFF_ORDER_PREFIX):
        return parent_order[len(MCAFF_ORDER_PREFIX):]
    return parent_order


def fetch_awb_by_order(parent_orders):
    """Display_Order_Code -> Tracking_Number, for orders whose ticket-level AWB is blank.
    Item_level_data has one row per order item/sync channel, so an order can map to more
    than one Tracking_Number (split shipments, re-syncs) - ORDER BY Created DESC plus
    "first row seen per order wins" below picks the latest one."""
    if not parent_orders:
        return {}
    key_by_order = {order: _awb_lookup_key(order) for order in parent_orders}
    lookup_keys = sorted(set(key_by_order.values()))
    placeholders = ",".join(["%s"] * len(lookup_keys))
    rows = mysql_lib.query(
        f"SELECT Display_Order_Code, Tracking_Number FROM Item_level_data "
        f"WHERE Display_Order_Code IN ({placeholders}) AND Tracking_Number IS NOT NULL AND Tracking_Number != '' "
        f"ORDER BY Created DESC",
        tuple(lookup_keys), database="mcaff_prod",
    )
    awb_by_key = {}
    for order_code, tracking in (rows or []):
        awb_by_key.setdefault(order_code, tracking)
    return {order: awb_by_key[key] for order, key in key_by_order.items() if key in awb_by_key}


def fetch_city_by_awb(awbs):
    """Tracking_Number -> Shipping_Address_City from mcaff_prod's Item_level_data - same source
    and latest-row-wins tie-break as backfill_delivery_escalation_shipping_city.py."""
    if not awbs:
        return {}
    unique_awbs = sorted(set(awbs))
    placeholders = ",".join(["%s"] * len(unique_awbs))
    rows = mysql_lib.query(
        f"SELECT Tracking_Number, Shipping_Address_City FROM Item_level_data "
        f"WHERE Tracking_Number IN ({placeholders}) "
        f"AND Shipping_Address_City IS NOT NULL AND Shipping_Address_City != '' "
        f"ORDER BY Created DESC",
        tuple(unique_awbs), database="mcaff_prod",
    )
    city_by_awb = {}
    for awb, city in (rows or []):
        city_by_awb.setdefault(awb, city)
    return city_by_awb


def parent_order_of(row):
    (_ticket_number, _subcategory, order_name, disposition_order, *_rest) = row
    return order_name or disposition_order or ""


def fill_missing_awb(rows):
    """rows are the raw tuples (as lists) from fetch_flowcall_delivery_rows - mutates awb
    (index 4) in place wherever it's blank and Item_level_data has a Tracking_Number for that
    order."""
    missing_orders = sorted({parent_order_of(r) for r in rows if not r[4] and parent_order_of(r)})
    if not missing_orders:
        return
    awb_by_order = fetch_awb_by_order(missing_orders)
    filled = 0
    for r in rows:
        order = parent_order_of(r)
        if not r[4] and order in awb_by_order:
            r[4] = awb_by_order[order]
            filled += 1
    if filled:
        print(f"  filled AWB from Item_level_data for {filled} row(s)")


DELIVERY_ESCALATION_INSERT = """
    INSERT INTO Delivery_escalation
        (brand, order_id, awb_code, delivery_partner, query_class, query_category,
         wh_name, ticket_number, added_date, order_date, order_month, query_date, query_month,
         outcome, agent_remarks, disposed_at, agent_email, Shipping_Address_City)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON DUPLICATE KEY UPDATE
        order_id = VALUES(order_id),
        awb_code = COALESCE(awb_code, VALUES(awb_code)),
        delivery_partner = VALUES(delivery_partner),
        query_class = VALUES(query_class), query_category = VALUES(query_category),
        wh_name = VALUES(wh_name), ticket_number = VALUES(ticket_number),
        added_date = VALUES(added_date), order_date = VALUES(order_date),
        order_month = VALUES(order_month), query_date = VALUES(query_date),
        query_month = VALUES(query_month),
        Shipping_Address_City = COALESCE(VALUES(Shipping_Address_City), Shipping_Address_City)
        -- outcome/agent_remarks/disposed_at/agent_email deliberately NOT re-written here: this
        -- job must never overwrite a ticket an agent (or the carry-forward below) already
        -- disposed - only a brand-new ticket_number (the INSERT branch) ever gets them set.
"""

# A brand+awb_code pair whose outcome is one of these already has a TERMINAL disposition - the
# same "resolved" and "RTO" labels DE_RESOLVED_WHERE/DE_FORCED_RTO_WHERE (api/_lib/db.js) use to
# classify a ticket, duplicated here because this is a standalone script with no access to that
# JS. Matched on the top-level label so a nested "RTO > New AWB#..." / "Delivered > <reason>"
# still counts, same convention as those constants.
TERMINAL_OUTCOME_SQL = "(outcome = 'RTO' OR outcome LIKE 'RTO > %%' OR outcome = 'Delivered' OR outcome LIKE 'Delivered > %%')"


def fetch_terminal_outcomes(tab_awb_pairs):
    """{(tab, awb): (outcome, agent_remarks, agent_email)} for every (brand, awb_code) pair
    that already has a TERMINAL disposition (RTO or Delivered) sitting in Delivery_escalation.

    Why: an AWB already resolved as RTO (and usually reshipped under a NEW awb_code) can keep
    generating fresh CS tickets against the OLD awb_code - the courier's tracking feed doesn't
    know the parcel is done, so it keeps reporting "Delayed"/"Misrouted"/etc against it. Each
    such ticket used to land back in Fresh (or age into Forced RTO) and sit there until someone
    manually re-applied the SAME resolution by hand. That's stale signal, not a new incident -
    the parcel already has a known outcome - so a brand-new ticket for an already-terminal AWB
    is stamped with that same outcome here, at insert time, instead of reopening it.

    Most recent disposed_at wins if more than one terminal row exists for the pair (e.g.
    resolved, somehow reopened, resolved again)."""
    if not tab_awb_pairs:
        return {}
    pairs = sorted(set(tab_awb_pairs))
    placeholders = ",".join(["(%s, %s)"] * len(pairs))
    params = tuple(v for pair in pairs for v in pair)
    rows = mysql_lib.query(
        f"""
        SELECT brand, awb_code, outcome, agent_remarks, agent_email
        FROM Delivery_escalation
        WHERE (brand, awb_code) IN ({placeholders}) AND {TERMINAL_OUTCOME_SQL}
        ORDER BY disposed_at DESC
        """,
        params, database="PEP_CLS",
    )
    out = {}
    for brand, awb, outcome, agent_remarks, agent_email in (rows or []):
        out.setdefault((brand, awb), (outcome, agent_remarks, agent_email))
    return out


def build_delivery_escalation_row(row, tab, terminal_by_awb=None, city_by_awb=None):
    """row is a raw tuple from fetch_flowcall_delivery_rows - real DATE/datetime objects for
    added_date/order_date/query_date, not display strings, since this row needs to stay
    queryable. terminal_by_awb (see fetch_terminal_outcomes) carries an already-resolved AWB's
    outcome forward onto this brand-new ticket instead of leaving it Fresh. city_by_awb (see
    fetch_city_by_awb) maps this row's own AWB to its Shipping_Address_City."""
    (ticket_number, subcategory, order_name, disposition_order,
     awb, partner, order_date, created_at, resolved_at, warehouse) = row
    parent_order = order_name or disposition_order or ""
    # disposition_partner_name is often blank on a non-terminal ticket (the CS agent closing
    # their own ticket has no reason to know who's carrying it) - fall back to the same
    # AWB-prefix rule assign_leads.py already uses for CLS_RTO_calling rather than leaving this
    # column permanently blank whenever the AWB itself makes the carrier obvious. Only a
    # fallback: the source's own value always wins when it has one.
    partner = partner or prefix_rule_partner(awb) or None
    terminal = (terminal_by_awb or {}).get((tab, awb)) if awb else None
    if terminal:
        outcome, agent_remarks, agent_email = terminal
        agent_remarks = f"[Auto-carried: AWB already {outcome}] {agent_remarks or ''}".strip()
        disposed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    else:
        outcome = agent_remarks = agent_email = disposed_at = None
    shipping_city = (city_by_awb or {}).get(awb) if awb else None
    return (
        tab, parent_order, awb or None, partner, "Delivery",
        subcategory or None, warehouse or None, ticket_number,
        resolved_at, order_date, format_month(order_date), created_at, format_month(created_at),
        outcome, agent_remarks, disposed_at, agent_email, shipping_city,
    )


def upsert_delivery_escalation_rows(rows, tab, terminal_by_awb=None, city_by_awb=None):
    for r in rows:
        try:
            mysql_lib.execute(
                DELIVERY_ESCALATION_INSERT,
                build_delivery_escalation_row(r, tab, terminal_by_awb, city_by_awb), database="PEP_CLS")
        except Exception as e:
            print(f"  WARNING: Delivery_escalation upsert failed for ticket {r[0]}: {e}")


def sync_tab(tab, dry_run, since=None, hours_back=2, api_token=None):
    flowcall_tab, token_env = BRANDS[tab]
    # Normally a no-op in CI, where --api-token is always passed explicitly and MYSQL_*/
    # FLOWCALL_TOKEN_* are real env vars - only matters for a local run relying on
    # .env.local, which otherwise wouldn't be loaded until the first mysql_lib DB call.
    mysql_lib._load_env_local()
    token = api_token or os.environ.get(token_env)
    if not token:
        raise RuntimeError(f"No Flowcall API token for {tab} - pass --api-token or set {token_env}")
    print(f"--- {tab} ({flowcall_tab}) ---")

    now = datetime.now(timezone.utc)
    # --since is a manual, out-of-band backfill (a specific date through now) and must never
    # move the normal cursor - only a plain (no --since) run reads/advances state below.
    if since:
        start_date = datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        state = get_state()
        start_date = (datetime.fromisoformat(state[tab].replace("Z", "+00:00"))
                      if state.get(tab) else now - timedelta(hours=hours_back))
    end_date = now
    start_str = start_date.strftime("%Y-%m-%dT%H:%M:%S.") + f"{start_date.microsecond // 1000:03d}Z"
    end_str = end_date.strftime("%Y-%m-%dT%H:%M:%S.") + f"{end_date.microsecond // 1000:03d}Z"

    rows = fetch_flowcall_delivery_rows(flowcall_tab, token, start_str, end_str)
    print(f"  {len(rows)} Delivery-class ticket(s) from Flowcall {start_str} -> {end_str}")
    if not rows:
        if not since and not dry_run:
            state = get_state()
            state[tab] = end_str
            save_state(state)
        return

    rows = [list(r) for r in rows]
    fill_missing_awb(rows)

    city_by_awb = fetch_city_by_awb([r[4] for r in rows if r[4]])

    terminal_by_awb = fetch_terminal_outcomes([(tab, r[4]) for r in rows if r[4]])
    if terminal_by_awb:
        print(f"  {len(terminal_by_awb)} awb(s) already terminal - new tickets for them carry that outcome forward")

    if dry_run:
        for r in rows[:5]:
            print("   ", build_delivery_escalation_row(r, tab, terminal_by_awb, city_by_awb))
        if len(rows) > 5:
            print(f"    ... and {len(rows) - 5} more")
        print(f"  would upsert {len(rows)} row(s) into MySQL Delivery_escalation")
        return

    upsert_delivery_escalation_rows(rows, tab, terminal_by_awb, city_by_awb)
    print(f"  upserted {len(rows)} row(s) into MySQL Delivery_escalation")
    # Categories whose outcome follows from the category alone never reach an agent - see
    # auto_dispose_de_categories.py. Runs after the upsert so tickets mirrored a moment ago are
    # included, and only ever touches blank-outcome rows, so it can't overwrite the
    # terminal-carry-forward outcome build_delivery_escalation_row just stamped. Not scoped to
    # `tab`: the rule is brand-independent, and being idempotent means the second tab's run
    # simply finds nothing left. Best-effort for the same reason the recompute below is - a
    # failure here must not fail a run whose upsert already succeeded.
    try:
        n = auto_dispose_de_categories.auto_dispose(dry_run=False)
        print(f"  auto-disposed {n} row(s) by query_category")
    except Exception as e:
        print(f"  WARNING: category auto-dispose failed (rows left in Fresh): {e}")
    # Repeat-contact columns are aggregates over every ticket sharing an AWB, so newly-inserted
    # rows change them for their OLDER siblings too - they have to be recomputed after the
    # insert, not derived per-row during it. Best-effort: a failure here leaves the previous
    # (merely stale) values in place, which must never fail a run whose upsert already succeeded.
    try:
        n = mysql_lib.execute(delivery_escalation_contact_stats.RECOMPUTE_SQL, database="PEP_CLS")
        print(f"  recomputed contact_count/first_added_date for {n} row(s)")
    except Exception as e:
        print(f"  WARNING: contact-stat recompute failed (values left stale): {e}")

    # Advanced only now, after a fully successful run - a crash partway through leaves the
    # cursor where it was, so the next run safely re-fetches and re-upserts the same window
    # (idempotent, see DELIVERY_ESCALATION_INSERT's own comment) rather than silently skipping it.
    if not since:
        state = get_state()
        state[tab] = end_str
        save_state(state)


def self_check():
    """Offline check of the row-building/lookup helpers - no DB."""
    # MCaff-prefixed orders look up by their bare numeric ID; other brands keep their prefix.
    assert _awb_lookup_key("MCaff9097914") == "9097914"
    assert _awb_lookup_key("HYP37526450") == "HYP37526450"
    # MySQL row: brand = the tab it came from, ticket_number carried straight through,
    # order_month/query_month recomputed from the real date objects.
    from datetime import date
    row = ("TCK1", "Wrong Pincode", "", "MCaff123", "AWB1", "BlueDart",
           date(2026, 1, 5), datetime(2026, 1, 6, 10, 0), datetime(2026, 1, 7, 9, 0), "WH1")
    assert build_delivery_escalation_row(row, "mCaffeine") == (
        "mCaffeine", "MCaff123", "AWB1", "BlueDart", "Delivery", "Wrong Pincode", "WH1", "TCK1",
        row[8], row[6], format_month(row[6]), row[7], format_month(row[7]),
        None, None, None, None, None,
    )
    # Blank order_name falls back to disposition_order, same as parent_order_of.
    row2 = ("TCK2", None, "", "HYP999", "", "Delhivery", None, None, None, "")
    assert build_delivery_escalation_row(row2, "HYPHEN") == (
        "HYPHEN", "HYP999", None, "Delhivery", "Delivery", None, None, "TCK2",
        None, None, "", None, "",
        None, None, None, None, None,
    )
    # An AWB already terminal carries its outcome forward onto a brand-new ticket for it.
    terminal = {("mCaffeine", "AWB1"): ("RTO > New AWB# XYZ", "reshipped", "shahid.khan@mcaffeine.com")}
    built = build_delivery_escalation_row(row, "mCaffeine", terminal)
    assert built[13] == "RTO > New AWB# XYZ"
    assert built[14] == "[Auto-carried: AWB already RTO > New AWB# XYZ] reshipped"
    assert built[15] is not None  # disposed_at stamped now
    # city_by_awb maps this row's own AWB to Shipping_Address_City; a row with no AWB, or one
    # missing from the map, stays None rather than raising.
    built_city = build_delivery_escalation_row(row, "mCaffeine", city_by_awb={"AWB1": "Mumbai"})
    assert built_city[17] == "Mumbai"
    assert build_delivery_escalation_row(row2, "HYPHEN", city_by_awb={"AWB1": "Mumbai"})[17] is None
    assert fetch_city_by_awb([]) == {}
    assert parent_order_of(row) == "MCaff123"
    assert parent_order_of(row2) == "HYP999"
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", choices=sorted(BRANDS))
    parser.add_argument("--api-token", help="Flowcall API bearer token (else read from the tab's own FLOWCALL_TOKEN_* env var)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no MySQL writes")
    parser.add_argument("--since", help="YYYY-MM-DD: one-off backfill from this date (UTC midnight) through now - does not touch the normal sync cursor")
    parser.add_argument("--hours-back", type=int, default=2, help="Lookback window for the very first run, before any cursor is saved")
    parser.add_argument("--self-check", action="store_true", help="Run the offline row-building check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if not args.tab:
        parser.error("--tab is required")
    sync_tab(args.tab, args.dry_run, since=args.since, hours_back=args.hours_back, api_token=args.api_token)


if __name__ == "__main__":
    main()
