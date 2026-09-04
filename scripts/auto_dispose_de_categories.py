#!/usr/bin/env python3
"""Auto-disposes Delivery_escalation rows whose outcome is already known, so agents never have to
click through thousands of tickets whose answer nobody needs to decide. Two independent rules:

  --rule categories  query_category alone determines the outcome (Fake Order RTO -> new order
                     placed, Pincode not serviceable -> cancelled and refunded, ...). Runs as a
                     step of sync_delivery_tickets_to_sheet.py, every 2 hours after the upsert,
                     so newly mirrored tickets are disposed on arrival.
  --rule delivered   mcaff_prod.lmd_courier_tracking says the parcel arrived
                     (uni_Shipping_Package_Status = 'DELIVERED'), joined on AWB -> 'Delivered',
                     disposed_at = uni_Delivery_Time. Runs daily at 5 AM IST from its own
                     workflow (.github/workflows/auto-dispose-de-delivered.yml), NOT from the
                     2-hourly sync: the courier feed is refreshed by a separate pipeline, so
                     re-checking it 12x a day would find nothing 11 of those times.

Both are idempotent, so either can also be run standalone with --apply over the history that
predates it. The filename predates the delivered rule; kept as-is because
sync_delivery_tickets_to_sheet.py imports it by name.

ORDER MATTERS where a ticket qualifies for both: categories runs first (its own 2-hourly slot is
more frequent), and the blank-outcome guard below means delivered then skips it. That is the
right precedence for 'Marked Delivered but customer did not receive order' - the category rule
stamps 'Resolved > POD requested', and courier-says-DELIVERED is precisely the claim that ticket
disputes, so it must not be allowed to overwrite it with 'Delivered'.

WHICH ROWS: blank outcome only, and never a Forced RTO row. Blank-outcome is what makes this
safe to re-run and safe to ship - a row an agent (or the sync job's own terminal carry-forward)
already decided is left exactly as it was, so this can never overwrite a human's call. The
Forced RTO guard is redundant against today's data (0 of the 1,492 eligible rows are Forced
RTO) but not against tomorrow's: Forced RTO is detected off the `tat` column, which a logistics
backfill refreshes independently of anything here, and a row matching BOTH DE_FORCED_RTO_WHERE
and DE_RESOLVED_WHERE double-counts in the Overview tiles (see api/_lib/db.js).

WHY NESTED UNDER AN EXISTING ROOT and not three new top-level outcomes: the Resolved tab is
DE_RESOLVED_WHERE in api/_lib/db.js, which matches on the TOP-LEVEL outcome label
('Delivered' / 'Delivered > %'). A brand-new top-level outcome therefore lands in no tab at all
- not Fresh (DE_FRESH_WHERE lists blank/RTO/Escalated only), not Resolved, not Forced RTO -
i.e. invisible everywhere except the unconditional total tile, the same silent-disappearance
class of bug that constant's own comments already document twice. Nesting POD requested/
Cancelled and refunded/others under 'Resolved' means one term added to DE_RESOLVED_WHERE covers
them at once, and the existing 18.5k 'Delivered' rows keep their own distinct meaning (actually
delivered) instead of being merged with cancelled/refunded and POD-requested ones.

'New order placed' is the one exception: it's nested under 'Escalated' (an EXISTING root, not
'Resolved'), matching where an admin moved that child in the app's own disposition tree - see
DE_NEW_ORDER_PLACED_WHERE and DE_FRESH_WHERE in api/_lib/db.js, which special-case
'Escalated > New order placed' out of Fresh (still needs its own carve-out, same reasoning as
'Resolved > New order placed' used to need out of Resolved) and into its own tab.

disposed_at is the moment this ran, NOT added_date: it is the date the outcome was actually
decided, which is what the Resolved views report. Consequence, by design: the historical
backfill stamps today onto rows added months ago, so most of them land in the
'Greater than 10 days' TAT bucket (DATEDIFF(disposed_at, added_date), see DE_TAT_BUCKET_SQL).
That is the honest figure - those tickets really did sit unresolved that long - and it makes the
first run visibly shift the Resolved TAT distribution right. Cron-time rows are same-day, ~0.

agent_email is AUTO_AGENT rather than NULL so these rows are filterable in the app's own agent
dropdown (getDeliveryEscalationAgents selects DISTINCT agent_email) and a mis-mapped rule is
reversible with one UPDATE keyed off it. agent_remarks carries the category that triggered the
rule, in the same '[Auto-...]' shape sync_delivery_tickets_to_sheet.py's carry-forward uses.

Dry-run by default (counts what it would touch, writes nothing); --apply performs the updates.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib

AUTO_AGENT = "auto@system"
PROCESS_KEY = "deliveryescalation"

# query_category (EXACTLY as Delivery_escalation stores it - not the report-dump spellings in
# data/*_full_raw.json, which differ per brand) -> the full outcome path to stamp.
#
# Deliberately absent: Delayed Order, Delayed Order-Product, Fake update, Marked Undelivered,
# Delivery Boy Complaint, Late/Delay Dispatch, Order Misrouted, and blank-category rows. Those
# have no single correct answer, so they stay in Fresh for an agent. 'Delivery Suggestion',
# 'Hub Address Request' and 'Expedite/Urgent Delivery' also have rules in principle but zero
# rows in this table (they exist only in the report dumps), so there is nothing to map.
CATEGORY_DISPOSITION = {
    "Fake Order RTO": "Escalated > New order placed",
    "Pickup Exception": "Escalated > New order placed",
    "Lost/Damaged/Destroyed": "Escalated > New order placed",
    "Marked Delivered but customer did not receive order": "Resolved > POD requested",
    "Pincode not serviceable": "Resolved > Cancelled and refunded",
    "others": "Resolved",
}

# Kept byte-identical to DE_FORCED_RTO_WHERE in api/_lib/db.js (which itself now builds this
# from DE_RTO_ROOT_SQL - RTO_MBP is the Partner-role variant of the same disposal, see
# rtoMbpOutcome's own comment there). The `IS NOT NULL` guards are load-bearing, not defensive
# noise: `NULL = 'RTO'` is NULL, and this sits under a NOT(), where NOT(NULL) is also NULL and
# silently matches nothing - the exact bug db.js's comment records dropping Fresh from ~3645 rows
# to 2. Doubled %% because mysql_lib passes params to pymysql, which %-formats the statement.
#
# Functions rather than constants only so the delivered rule's multi-table UPDATE can get a
# `d.`-qualified copy from this one source. Unqualified would happen to work today
# (lmd_courier_tracking has no `tat` or `outcome` column, so nothing is ambiguous), but that is
# luck, not a guarantee: the day that table gains an `outcome` the clause would silently bind to
# the wrong one, and a silently-wrong WHERE in exactly this spot is what the two db.js comments
# above record costing an entire tab's worth of rows. Twice.
def forced_rto_where(prefix=""):
    return (
        f"(({prefix}tat IS NOT NULL AND {prefix}tat = 'Forced to be marked as RTO') "
        f"OR ({prefix}outcome IS NOT NULL AND "
        f"({prefix}outcome = 'RTO' OR {prefix}outcome LIKE 'RTO > %%' "
        f"OR {prefix}outcome = 'RTO_MBP' OR {prefix}outcome LIKE 'RTO_MBP > %%')))"
    )


def eligible_where(prefix=""):
    return (f"({prefix}outcome IS NULL OR {prefix}outcome = '') "
            f"AND NOT {forced_rto_where(prefix)}")


def child_of(outcome):
    """The part after the root - the child label for the disposition tree seed. A bare root has
    no child.

    NOT written to Delivery_escalation.child_disposition: that column is VIRTUAL GENERATED off
    outcome (`SUBSTR(outcome, LOCATE(' > ', outcome) + 3)`), so MySQL derives exactly this value
    on its own and rejects any UPDATE naming the column - error 3105, "The value specified for
    generated column 'child_disposition' ... is not allowed". Setting outcome is sufficient."""
    root, _, rest = outcome.partition(" > ")
    return rest or None


def group_by_outcome(mapping=None):
    """outcome -> sorted categories that map to it, so one UPDATE covers each outcome instead of
    one per category."""
    groups = {}
    for category, outcome in (mapping or CATEGORY_DISPOSITION).items():
        groups.setdefault(outcome, []).append(category)
    return {outcome: sorted(cats) for outcome, cats in sorted(groups.items())}


def update_sql(categories):
    placeholders = ", ".join(["%s"] * len(categories))
    return f"""
        UPDATE Delivery_escalation
        SET outcome = %s,
            disposed_at = NOW(),
            agent_email = %s,
            agent_remarks = CONCAT('[Auto-disposed: ', query_category, ']')
        WHERE query_category IN ({placeholders})
          AND {eligible_where()}
    """


def count_sql(categories):
    placeholders = ", ".join(["%s"] * len(categories))
    return f"""
        SELECT COUNT(*) FROM Delivery_escalation
        WHERE query_category IN ({placeholders})
          AND {eligible_where()}
    """


def seed_dispositions(dry_run=True):
    """Idempotently adds each outcome's root and child to this process's admin-configured
    disposition tree, so the labels this job writes are also pickable (and filterable) in the
    app's own dispose modal. Only the tree - it does not touch any ticket row.

    Grouped by ROOT rather than a single hardcoded one: 'New order placed' lives under
    'Escalated', everything else under 'Resolved' - see the module docstring's own note on why.
    A root already existing (e.g. 'Escalated', which agents already use for plain escalations)
    is left alone; only a missing child gets added under it."""
    rows = mysql_lib.query(
        "SELECT id, parent_id, label FROM calling_process_dispositions WHERE process_key = %s",
        params=(PROCESS_KEY,), database="PEP_CLS")
    if rows is None:
        raise RuntimeError("MYSQL_* credentials not configured - cannot seed dispositions.")

    roots_needed = {}
    for outcome in CATEGORY_DISPOSITION.values():
        root, _, child = outcome.partition(" > ")
        roots_needed.setdefault(root, set())
        if child:
            roots_needed[root].add(child)

    for root in sorted(roots_needed):
        children = sorted(roots_needed[root])
        root_id = next((r[0] for r in rows if r[1] is None and r[2] == root), None)
        existing = {r[2] for r in rows if root_id is not None and r[1] == root_id}
        missing = [c for c in children if c not in existing]

        if root_id is None:
            print(f"  disposition tree: {'would add' if dry_run else 'adding'} root '{root}'")
        if missing:
            print(f"  disposition tree: {'would add' if dry_run else 'adding'} child(ren) {missing} under '{root}'")
        if root_id is not None and not missing:
            print(f"  disposition tree: '{root}' already up to date")
        if dry_run:
            continue
        if root_id is None:
            next_sort = mysql_lib.query(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM calling_process_dispositions "
                "WHERE process_key = %s AND parent_id IS NULL",
                params=(PROCESS_KEY,), database="PEP_CLS")[0][0]
            mysql_lib.execute(
                "INSERT INTO calling_process_dispositions "
                "(process_key, parent_id, label, sort_order, created_by) VALUES (%s, NULL, %s, %s, %s)",
                params=(PROCESS_KEY, root, next_sort, AUTO_AGENT), database="PEP_CLS")
            root_id = mysql_lib.query(
                "SELECT id FROM calling_process_dispositions "
                "WHERE process_key = %s AND parent_id IS NULL AND label = %s",
                params=(PROCESS_KEY, root), database="PEP_CLS")[0][0]
        for i, label in enumerate(missing):
            mysql_lib.execute(
                "INSERT INTO calling_process_dispositions "
                "(process_key, parent_id, label, sort_order, created_by) VALUES (%s, %s, %s, %s, %s)",
                params=(PROCESS_KEY, root_id, label, len(existing) + i, AUTO_AGENT), database="PEP_CLS")


def auto_dispose(dry_run=True):
    """Returns rows touched (or, on a dry run, rows that would be)."""
    total = 0
    for outcome, categories in group_by_outcome().items():
        if dry_run:
            got = mysql_lib.query(count_sql(categories), params=tuple(categories), database="PEP_CLS")
            if got is None:
                raise RuntimeError("MYSQL_* credentials not configured - cannot auto-dispose.")
            n = got[0][0]
            print(f"  would set '{outcome}' on {n} row(s) {categories}")
        else:
            n = mysql_lib.execute(
                update_sql(categories),
                params=(outcome, AUTO_AGENT, *categories), database="PEP_CLS")
            if n is None:
                raise RuntimeError("MYSQL_* credentials not configured - cannot auto-dispose.")
            print(f"  set '{outcome}' on {n} row(s) {categories}")
        total += n
    return total


# ---------------------------------------------------------------------------
# Rule 2: the courier says it arrived
# ---------------------------------------------------------------------------

# mcaff_prod.lmd_courier_tracking is the logistics pipeline's own AWB-keyed table (2.86M rows,
# PRIMARY KEY awb_number), a different schema on the same server - mysql_lib shares one
# connection and only switches the ACTIVE schema, so the cross-schema reference has to be
# spelled out in full here rather than relying on database="PEP_CLS".
#
# Driving the join from Delivery_escalation (39k rows) means ~9k primary-key lookups, not a scan
# of 2.86M: uni_Shipping_Package_Status has no index of its own, so filtering from that side
# would be the wrong direction entirely.
COURIER_TABLE = "mcaff_prod.lmd_courier_tracking"
DELIVERED_STATUS = "DELIVERED"
DELIVERED_OUTCOME = "Delivered"
DELIVERED_REMARKS = "[Auto-disposed: courier DELIVERED]"

# 'Delivered' is deliberately the BARE existing root, not a new 'Delivered > ...' child:
#   - DE_RESOLVED_WHERE in api/_lib/db.js already matches `outcome = 'Delivered'`, so these rows
#     appear in the Resolved tab with no api/ change and therefore no deploy ordering to get
#     wrong - unlike the categories rule, which needed DE_RESOLVED_WHERE widened first.
#   - it is already in this process's disposition tree (calling_process_dispositions id 2, root,
#     no children), shared with 18.5k agent-marked rows, so seed_dispositions has nothing to add.
# Provenance is carried by agent_email/agent_remarks instead, which is also what makes a bad run
# reversible: UPDATE ... SET outcome=NULL, disposed_at=NULL WHERE agent_remarks = the constant
# above.
#
# COALESCE(uni_Delivery_Time, NOW()): 1,086 of the 2,079 matching rows have the package marked
# DELIVERED but no delivery timestamp, and the ticket still needs to leave Fresh. Cost of the
# fallback, accepted: those rows get today's date, so DE_TAT_BUCKET_SQL
# (DATEDIFF(disposed_at, added_date)) reports them in 'Greater than 10 days' rather than their
# true transit time. Rows that DO carry a real uni_Delivery_Time get the honest figure - a few
# of them negative, where the courier delivered before the ticket was even logged, which lands
# in 'Within 48 hrs' since that bucket is the `<= 2` arm.
def delivered_update_sql():
    return f"""
        UPDATE Delivery_escalation d
        JOIN {COURIER_TABLE} t ON t.awb_number = d.awb_code
        SET d.outcome = %s,
            d.disposed_at = COALESCE(t.uni_Delivery_Time, NOW()),
            d.agent_email = %s,
            d.agent_remarks = %s
        WHERE t.uni_Shipping_Package_Status = %s
          AND {eligible_where("d.")}
    """


def delivered_count_sql():
    return f"""
        SELECT COUNT(*)
        FROM Delivery_escalation d
        JOIN {COURIER_TABLE} t ON t.awb_number = d.awb_code
        WHERE t.uni_Shipping_Package_Status = %s
          AND {eligible_where("d.")}
    """


def auto_dispose_delivered(dry_run=True):
    """Returns rows touched (or, on a dry run, rows that would be)."""
    if dry_run:
        got = mysql_lib.query(delivered_count_sql(), params=(DELIVERED_STATUS,),
                              database="PEP_CLS")
        if got is None:
            raise RuntimeError("MYSQL_* credentials not configured - cannot auto-dispose.")
        n = got[0][0]
        print(f"  would set '{DELIVERED_OUTCOME}' on {n} row(s) (courier "
              f"{DELIVERED_STATUS})")
        return n
    n = mysql_lib.execute(
        delivered_update_sql(),
        params=(DELIVERED_OUTCOME, AUTO_AGENT, DELIVERED_REMARKS, DELIVERED_STATUS),
        database="PEP_CLS")
    if n is None:
        raise RuntimeError("MYSQL_* credentials not configured - cannot auto-dispose.")
    print(f"  set '{DELIVERED_OUTCOME}' on {n} row(s) (courier {DELIVERED_STATUS})")
    return n


def self_check():
    """Offline check of the mapping and the generated SQL - no DB."""
    assert child_of("Escalated > New order placed") == "New order placed"
    assert child_of("Resolved") is None
    # A deeper path keeps everything below the root as the child, same as existing
    # 'RTO > New AWB# > 12345' rows store 'New AWB# > 12345'.
    assert child_of("Resolved > A > B") == "A > B"

    groups = group_by_outcome()
    assert groups["Escalated > New order placed"] == [
        "Fake Order RTO", "Lost/Damaged/Destroyed", "Pickup Exception"]
    assert groups["Resolved > POD requested"] == [
        "Marked Delivered but customer did not receive order"]
    assert groups["Resolved > Cancelled and refunded"] == ["Pincode not serviceable"]
    assert groups["Resolved"] == ["others"]
    # Every category appears exactly once across the groups - a category mapped twice would be
    # updated twice, the second UPDATE seeing a non-blank outcome and silently doing nothing.
    flat = [c for cats in groups.values() for c in cats]
    assert sorted(flat) == sorted(CATEGORY_DISPOSITION)

    # Every outcome this writes must be matched by the widened DE_RESOLVED_WHERE or
    # DE_NEW_ORDER_PLACED_WHERE, or the row vanishes from every tab. Mirrors those clauses'
    # shape rather than importing them from JS.
    for outcome in groups:
        assert (outcome == "Resolved" or outcome.startswith("Resolved > ")
                or outcome == "Escalated > New order placed"), outcome

    # The update must never touch a disposed row, and must exclude Forced RTO.
    sql = update_sql(["others"])
    assert "outcome IS NULL OR outcome = ''" in sql
    assert "Forced to be marked as RTO" in sql
    assert "disposed_at = NOW()" in sql
    # child_disposition is VIRTUAL GENERATED off outcome - naming it in the SET list is MySQL
    # error 3105, which is what the first --apply run died on. See child_of().
    assert "child_disposition" not in sql
    # One placeholder per category, plus outcome/agent up front.
    assert update_sql(["a", "b", "c"]).count("%s") == 5
    assert count_sql(["a", "b"]).count("%s") == 2
    # A stray single % anywhere would blow up pymysql's own %-formatting of the statement.
    assert "LIKE 'RTO > %%'" in sql and "%%%" not in sql

    # --- rule 2: the courier-DELIVERED join ---
    # Both eligibility clauses must come from the one source, qualified vs not. Testing that they
    # are the SAME string modulo the prefix is the point: a hand-copied `d.`-qualified duplicate
    # is exactly the drift this refactor exists to prevent.
    assert eligible_where("d.") == eligible_where().replace("outcome", "d.outcome").replace(
        "tat", "d.tat")
    assert "d.outcome IS NULL OR d.outcome = ''" in eligible_where("d.")

    dsql = delivered_update_sql()
    # Guards, same two as rule 1, but on the aliased table.
    assert "d.outcome IS NULL OR d.outcome = ''" in dsql
    assert "d.tat = 'Forced to be marked as RTO'" in dsql
    # Every unaliased column reference is a latent wrong-table bind in a multi-table UPDATE.
    for bare in ("SET outcome", "SET disposed_at", " outcome IS NULL", " tat IS NOT NULL"):
        assert bare not in dsql, bare
    # The join is AWB-to-AWB and driven from the 39k-row side, not the 2.86M-row side.
    assert "JOIN mcaff_prod.lmd_courier_tracking t ON t.awb_number = d.awb_code" in dsql
    assert dsql.index("UPDATE Delivery_escalation d") < dsql.index("JOIN mcaff_prod")
    # uni_Delivery_Time is the resolved timestamp, NOW() only the fallback for the ~52% of
    # matching rows that have the package DELIVERED but no delivery time.
    assert "d.disposed_at = COALESCE(t.uni_Delivery_Time, NOW())" in dsql
    # Same generated-column trap as rule 1 - error 3105.
    assert "child_disposition" not in dsql
    # outcome, agent_email, agent_remarks, package status - and nothing interpolated raw.
    assert dsql.count("%s") == 4
    assert delivered_count_sql().count("%s") == 1
    assert "%%%" not in dsql and "LIKE 'RTO > %%'" in dsql
    # Bare existing root, so DE_RESOLVED_WHERE already matches it with no api/ change.
    assert DELIVERED_OUTCOME == "Delivered" and " > " not in DELIVERED_OUTCOME
    # The count query must select exactly the rows the update would touch, or the dry run lies.
    assert eligible_where("d.") in delivered_count_sql()
    assert "t.uni_Shipping_Package_Status = %s" in delivered_count_sql()
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the updates (default is a dry run).")
    ap.add_argument("--skip-seed", action="store_true", help="Don't touch the disposition tree.")
    ap.add_argument("--self-check", action="store_true", help="Run the offline mapping check and exit.")
    ap.add_argument("--rule", choices=("categories", "delivered", "all"), default="all",
                    help="Which rule to run (default: all).")
    args = ap.parse_args()
    if args.self_check:
        return self_check()
    dry_run = not args.apply
    total = 0
    # Only the categories rule writes labels the tree doesn't already have; the delivered rule
    # reuses the existing bare 'Delivered' root, so --rule delivered never needs the seed and
    # doesn't have to be told to skip it.
    if args.rule in ("categories", "all"):
        if not args.skip_seed:
            seed_dispositions(dry_run=dry_run)
        total += auto_dispose(dry_run=dry_run)
    if args.rule in ("delivered", "all"):
        total += auto_dispose_delivered(dry_run=dry_run)
    verb = "would auto-dispose" if dry_run else "auto-disposed"
    print(f"  {verb} {total} row(s) in total")


if __name__ == "__main__":
    main()
