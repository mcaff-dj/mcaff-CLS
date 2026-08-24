"""Mirrors today's resolved Delivery-class tickets from hyphen_tickets/mcaff_tickets straight
into PEP_CLS.Delivery_escalation. Run every 2 hours via GitHub Actions (see
.github/workflows/sync-delivery-tickets.yml).

Used to ALSO paste these into the HYPHEN/mCaffeine tabs of the "Internal Escalation" Google
Sheet - that write is gone. The sheet was the original ticket source before Delivery_escalation
existed; this job kept writing to both while the CRM (app/delivery-escalation/) migrated over,
and nothing left reads the sheet copy. MySQL is now the only destination, and the ONLY correct
one - keeping a second write path alive after nothing reads it just doubles the ways this job
can fail.

Only 11 columns have a source here (brand/order_id/awb_code/delivery_partner/query_class/
query_category/wh_name, plus added_date/order_date/order_month/query_date/query_month) - the
rest (delivered_date, status_as_per_awb, tat, city, state, etc.) come from a separate
logistics-tracking pipeline this job doesn't touch, so they're left NULL on job-inserted rows.

ticket_number is this job's own dedup key, same as when it lived in a sheet column - but the
dedup itself no longer needs a "read what's already there" pass: DELIVERY_ESCALATION_INSERT is
an upsert (ON DUPLICATE KEY UPDATE against the table's own dedup_key, IF(ticket_number is set,
brand+ticket_number, brand+awb_code)), so re-running this on a ticket already mirrored just
re-writes the same row instead of duplicating it. That makes every run idempotent for free,
including re-running the same day or a --since backfill that overlaps an earlier run.

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
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib
import delivery_escalation_contact_stats
from lead_priority import prefix_rule_partner

TAB_TABLE = {
    "HYPHEN": "hyphen_tickets",
    "mCaffeine": "mcaff_tickets",
}


def format_month(dt):
    if dt is None:
        return ""
    return f"{dt.month}_{dt.strftime('%b')}'{dt.strftime('%y')}"


def fetch_today_delivery_tickets(table, since=None):
    """since: optional 'YYYY-MM-DD' to backfill everything resolved from that date through
    today (inclusive), for catching up after a run failed partway and missed a day - normal
    runs omit it and only pick up tickets resolved today."""
    date_filter = "DATE(resolved_at) BETWEEN %s AND CURDATE()" if since else "DATE(resolved_at) = CURDATE()"
    params = ("%Delivery%", since) if since else ("%Delivery%",)
    sql = f"""
        SELECT ticket_number, subcategory, order_name, disposition_order,
               disposition_awb_number, disposition_partner_name,
               disposition_order_date, created_at, resolved_at,
               disposition_warehouse_name
        FROM {table}
        WHERE category LIKE %s AND {date_filter}
              AND (subcategory IS NULL OR subcategory != 'Estimated time of delivery')
        ORDER BY resolved_at
    """
    rows = mysql_lib.query(sql, params=params, database="PEP_CLS")
    if rows is None:
        raise RuntimeError("MYSQL_* credentials not configured - cannot fetch tickets.")
    return rows


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


def parent_order_of(row):
    (_ticket_number, _subcategory, order_name, disposition_order, *_rest) = row
    return order_name or disposition_order or ""


def fill_missing_awb(rows):
    """rows are the raw DB tuples (as lists) from fetch_today_delivery_tickets - mutates awb
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
         outcome, agent_remarks, disposed_at, agent_email)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON DUPLICATE KEY UPDATE
        order_id = VALUES(order_id),
        awb_code = COALESCE(awb_code, VALUES(awb_code)),
        delivery_partner = VALUES(delivery_partner),
        query_class = VALUES(query_class), query_category = VALUES(query_category),
        wh_name = VALUES(wh_name), ticket_number = VALUES(ticket_number),
        added_date = VALUES(added_date), order_date = VALUES(order_date),
        order_month = VALUES(order_month), query_date = VALUES(query_date),
        query_month = VALUES(query_month)
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


def build_delivery_escalation_row(row, tab, terminal_by_awb=None):
    """row is a raw DB tuple from fetch_today_delivery_tickets - real DATE/datetime objects for
    added_date/order_date/query_date, not display strings, since this row needs to stay
    queryable. terminal_by_awb (see fetch_terminal_outcomes) carries an already-resolved AWB's
    outcome forward onto this brand-new ticket instead of leaving it Fresh."""
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
    return (
        tab, parent_order, awb or None, partner, "Delivery",
        subcategory or None, warehouse or None, ticket_number,
        resolved_at, order_date, format_month(order_date), created_at, format_month(created_at),
        outcome, agent_remarks, disposed_at, agent_email,
    )


def upsert_delivery_escalation_rows(rows, tab, terminal_by_awb=None):
    for r in rows:
        try:
            mysql_lib.execute(
                DELIVERY_ESCALATION_INSERT, build_delivery_escalation_row(r, tab, terminal_by_awb), database="PEP_CLS")
        except Exception as e:
            print(f"  WARNING: Delivery_escalation upsert failed for ticket {r[0]}: {e}")


def sync_tab(tab, dry_run, since=None):
    table = TAB_TABLE[tab]
    print(f"--- {tab} ({table}) ---")

    db_rows = fetch_today_delivery_tickets(table, since=since)
    print(f"  {len(db_rows)} Delivery-class tickets resolved {'since ' + since if since else 'today'} in DB")
    if not db_rows:
        return

    rows = [list(r) for r in db_rows]
    fill_missing_awb(rows)

    terminal_by_awb = fetch_terminal_outcomes([(tab, r[4]) for r in rows if r[4]])
    if terminal_by_awb:
        print(f"  {len(terminal_by_awb)} awb(s) already terminal - new tickets for them carry that outcome forward")

    if dry_run:
        for r in rows[:5]:
            print("   ", build_delivery_escalation_row(r, tab, terminal_by_awb))
        if len(rows) > 5:
            print(f"    ... and {len(rows) - 5} more")
        print(f"  would upsert {len(rows)} row(s) into MySQL Delivery_escalation")
        return

    upsert_delivery_escalation_rows(rows, tab, terminal_by_awb)
    print(f"  upserted {len(rows)} row(s) into MySQL Delivery_escalation")
    # Repeat-contact columns are aggregates over every ticket sharing an AWB, so newly-inserted
    # rows change them for their OLDER siblings too - they have to be recomputed after the
    # insert, not derived per-row during it. Best-effort: a failure here leaves the previous
    # (merely stale) values in place, which must never fail a run whose upsert already succeeded.
    try:
        n = mysql_lib.execute(delivery_escalation_contact_stats.RECOMPUTE_SQL, database="PEP_CLS")
        print(f"  recomputed contact_count/first_added_date for {n} row(s)")
    except Exception as e:
        print(f"  WARNING: contact-stat recompute failed (values left stale): {e}")


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
        None, None, None, None,
    )
    # Blank order_name falls back to disposition_order, same as parent_order_of.
    row2 = ("TCK2", None, "", "HYP999", "", "Delhivery", None, None, None, "")
    assert build_delivery_escalation_row(row2, "HYPHEN") == (
        "HYPHEN", "HYP999", None, "Delhivery", "Delivery", None, None, "TCK2",
        None, None, "", None, "",
        None, None, None, None,
    )
    # An AWB already terminal carries its outcome forward onto a brand-new ticket for it.
    terminal = {("mCaffeine", "AWB1"): ("RTO > New AWB# XYZ", "reshipped", "shahid.khan@mcaffeine.com")}
    built = build_delivery_escalation_row(row, "mCaffeine", terminal)
    assert built[13] == "RTO > New AWB# XYZ"
    assert built[14] == "[Auto-carried: AWB already RTO > New AWB# XYZ] reshipped"
    assert built[15] is not None  # disposed_at stamped now
    assert parent_order_of(row) == "MCaff123"
    assert parent_order_of(row2) == "HYP999"
    print("self-check ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", choices=sorted(TAB_TABLE))
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no MySQL writes")
    parser.add_argument("--since", help="YYYY-MM-DD: backfill tickets resolved from this date through today (default: today only)")
    parser.add_argument("--self-check", action="store_true", help="Run the offline row-building check and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if not args.tab:
        parser.error("--tab is required")
    sync_tab(args.tab, args.dry_run, args.since)


if __name__ == "__main__":
    main()
