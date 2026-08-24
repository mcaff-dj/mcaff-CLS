#!/usr/bin/env python3
"""Auto-disposes Delivery_escalation rows whose query_category has one and only one correct
outcome, so agents never have to click through 12k tickets whose answer is already known.

Runs as a step of sync_delivery_tickets_to_sheet.py (every 2 hours, after the upsert) so newly
mirrored tickets in these categories are disposed on arrival, and standalone with --apply for
the one-off pass over the history that predates this rule.

WHICH ROWS: blank outcome only, and never a Forced RTO row. Blank-outcome is what makes this
safe to re-run and safe to ship - a row an agent (or the sync job's own terminal carry-forward)
already decided is left exactly as it was, so this can never overwrite a human's call. The
Forced RTO guard is redundant against today's data (0 of the 1,492 eligible rows are Forced
RTO) but not against tomorrow's: Forced RTO is detected off the `tat` column, which a logistics
backfill refreshes independently of anything here, and a row matching BOTH DE_FORCED_RTO_WHERE
and DE_RESOLVED_WHERE double-counts in the Overview tiles (see api/_lib/db.js).

WHY A 'Resolved' ROOT and not three new top-level outcomes: the Resolved tab is
DE_RESOLVED_WHERE in api/_lib/db.js, which matches on the TOP-LEVEL outcome label
('Delivered' / 'Delivered > %'). A brand-new top-level outcome therefore lands in no tab at all
- not Fresh (DE_FRESH_WHERE lists blank/RTO/Escalated only), not Resolved, not Forced RTO -
i.e. invisible everywhere except the unconditional total tile, the same silent-disappearance
class of bug that constant's own comments already document twice. Nesting under one new
'Resolved' root means one term added to DE_RESOLVED_WHERE covers all of them at once, and the
existing 18.5k 'Delivered' rows keep their own distinct meaning (actually delivered) instead of
being merged with cancelled/refunded and POD-requested ones.

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
RESOLVED_ROOT = "Resolved"

# query_category (EXACTLY as Delivery_escalation stores it - not the report-dump spellings in
# data/*_full_raw.json, which differ per brand) -> the full outcome path to stamp.
#
# Deliberately absent: Delayed Order, Delayed Order-Product, Fake update, Marked Undelivered,
# Delivery Boy Complaint, Late/Delay Dispatch, Order Misrouted, and blank-category rows. Those
# have no single correct answer, so they stay in Fresh for an agent. 'Delivery Suggestion',
# 'Hub Address Request' and 'Expedite/Urgent Delivery' also have rules in principle but zero
# rows in this table (they exist only in the report dumps), so there is nothing to map.
CATEGORY_DISPOSITION = {
    "Fake Order RTO": "Resolved > New order placed",
    "Pickup Exception": "Resolved > New order placed",
    "Lost/Damaged/Destroyed": "Resolved > New order placed",
    "Marked Delivered but customer did not receive order": "Resolved > POD requested",
    "Pincode not serviceable": "Resolved > Cancelled and refunded",
    "others": "Resolved",
}

# Kept byte-identical to DE_FORCED_RTO_WHERE in api/_lib/db.js. The `IS NOT NULL` guards are
# load-bearing, not defensive noise: `NULL = 'RTO'` is NULL, and this sits under a NOT(), where
# NOT(NULL) is also NULL and silently matches nothing - the exact bug db.js's comment records
# dropping Fresh from ~3645 rows to 2. Doubled %% because mysql_lib passes params to pymysql,
# which %-formats the statement.
FORCED_RTO_WHERE = (
    "((tat IS NOT NULL AND tat = 'Forced to be marked as RTO') "
    "OR (outcome IS NOT NULL AND (outcome = 'RTO' OR outcome LIKE 'RTO > %%')))"
)
ELIGIBLE_WHERE = f"(outcome IS NULL OR outcome = '') AND NOT {FORCED_RTO_WHERE}"


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
          AND {ELIGIBLE_WHERE}
    """


def count_sql(categories):
    placeholders = ", ".join(["%s"] * len(categories))
    return f"""
        SELECT COUNT(*) FROM Delivery_escalation
        WHERE query_category IN ({placeholders})
          AND {ELIGIBLE_WHERE}
    """


def seed_dispositions(dry_run=True):
    """Idempotently adds the 'Resolved' root and its children to this process's admin-configured
    disposition tree, so the labels this job writes are also pickable (and filterable) in the
    app's own dispose modal. Only the tree - it does not touch any ticket row."""
    rows = mysql_lib.query(
        "SELECT id, parent_id, label FROM calling_process_dispositions WHERE process_key = %s",
        params=(PROCESS_KEY,), database="PEP_CLS")
    if rows is None:
        raise RuntimeError("MYSQL_* credentials not configured - cannot seed dispositions.")
    root_id = next((r[0] for r in rows if r[1] is None and r[2] == RESOLVED_ROOT), None)
    children = sorted({child_of(o) for o in CATEGORY_DISPOSITION.values() if child_of(o)})
    existing = {r[2] for r in rows if root_id is not None and r[1] == root_id}
    missing = [c for c in children if c not in existing]

    if root_id is None:
        print(f"  disposition tree: would add root '{RESOLVED_ROOT}'"
              if dry_run else f"  disposition tree: adding root '{RESOLVED_ROOT}'")
    if missing:
        print(f"  disposition tree: {'would add' if dry_run else 'adding'} child(ren) {missing}")
    if root_id is not None and not missing:
        print("  disposition tree: already up to date")
    if dry_run:
        return
    if root_id is None:
        next_sort = mysql_lib.query(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM calling_process_dispositions "
            "WHERE process_key = %s AND parent_id IS NULL",
            params=(PROCESS_KEY,), database="PEP_CLS")[0][0]
        mysql_lib.execute(
            "INSERT INTO calling_process_dispositions "
            "(process_key, parent_id, label, sort_order, created_by) VALUES (%s, NULL, %s, %s, %s)",
            params=(PROCESS_KEY, RESOLVED_ROOT, next_sort, AUTO_AGENT), database="PEP_CLS")
        root_id = mysql_lib.query(
            "SELECT id FROM calling_process_dispositions "
            "WHERE process_key = %s AND parent_id IS NULL AND label = %s",
            params=(PROCESS_KEY, RESOLVED_ROOT), database="PEP_CLS")[0][0]
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


def self_check():
    """Offline check of the mapping and the generated SQL - no DB."""
    assert child_of("Resolved > New order placed") == "New order placed"
    assert child_of("Resolved") is None
    # A deeper path keeps everything below the root as the child, same as existing
    # 'RTO > New AWB# > 12345' rows store 'New AWB# > 12345'.
    assert child_of("Resolved > A > B") == "A > B"

    groups = group_by_outcome()
    assert groups["Resolved > New order placed"] == [
        "Fake Order RTO", "Lost/Damaged/Destroyed", "Pickup Exception"]
    assert groups["Resolved > POD requested"] == [
        "Marked Delivered but customer did not receive order"]
    assert groups["Resolved > Cancelled and refunded"] == ["Pincode not serviceable"]
    assert groups["Resolved"] == ["others"]
    # Every category appears exactly once across the groups - a category mapped twice would be
    # updated twice, the second UPDATE seeing a non-blank outcome and silently doing nothing.
    flat = [c for cats in groups.values() for c in cats]
    assert sorted(flat) == sorted(CATEGORY_DISPOSITION)

    # Every outcome this writes must be matched by the widened DE_RESOLVED_WHERE, or the row
    # vanishes from every tab. Mirrors that clause's shape rather than importing it from JS.
    for outcome in groups:
        assert outcome == "Resolved" or outcome.startswith("Resolved > "), outcome

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
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the updates (default is a dry run).")
    ap.add_argument("--skip-seed", action="store_true", help="Don't touch the disposition tree.")
    ap.add_argument("--self-check", action="store_true", help="Run the offline mapping check and exit.")
    args = ap.parse_args()
    if args.self_check:
        return self_check()
    if not args.skip_seed:
        seed_dispositions(dry_run=not args.apply)
    total = auto_dispose(dry_run=not args.apply)
    verb = "would auto-dispose" if not args.apply else "auto-disposed"
    print(f"  {verb} {total} row(s) in total")


if __name__ == "__main__":
    main()
