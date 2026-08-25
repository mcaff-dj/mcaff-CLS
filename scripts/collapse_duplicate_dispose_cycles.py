"""Collapse the duplicate CLS_RTO_calling cycles left behind by the double-click disposal bug.

Between 2026-08-20 and the fix in api/_lib/db.js (shouldOpenNewCycle), the disposal modal's
Save button stayed enabled through a multi-second submit, so every extra click ran the whole
flow again. recordLeadDisposition's already-disposed branch answered each one by retiring the
live row and inserting a fresh cycle, producing chains like order 9184758's: 16 extra rows in
6 seconds, each one's assigned_at equal to the previous row's reassigned_away_at, every row
carrying the same disposition. Reads already count DISTINCT order_id so the numbers on screen
are right; this cleans the rows themselves.

WHAT COUNTS AS A DUPLICATE - deliberately the same rule the application now applies at write
time, so this script and the running code agree on what a "burst" is:

  * same order_id AND same agent_email (a different agent's cycle is never touched - its own
    agent_email and assigned_at are exactly what a cycle exists to record), and
  * each row disposed within BURST_SECONDS of the PREVIOUS row in the chain, so a genuine
    re-open hours later starts a new group and survives, and
  * the group's rows agree on disposition, connected and new_order_id. A burst where the agent
    actually changed the outcome between clicks is left alone for a human to look at.

WHAT IT DOES to a burst: keeps the EARLIEST row and deletes the rest. Earliest, not latest,
because that row holds the true assigned_at - 06:04:21 rather than the 06:58:12 the first
duplicate stamped - and FRT/handle-time metrics read assigned_at and disposed_at as one gap.
The kept row inherits the group's final disposed_at and its final reassigned_away_at, so a
lead that is live now stays live (a burst whose last row is live would otherwise leave the
order with NO live row, and assign_leads.py would read that as unassigned and hand it out
again).

SAFETY: dry run by default - prints what it would do and writes nothing. Every row it intends
to delete is written to a timestamped JSON backup BEFORE any DELETE runs, and --apply refuses
to start if that backup cannot be written. All writes for one burst go in a single transaction.

    python scripts/collapse_duplicate_dispose_cycles.py                 # dry run
    python scripts/collapse_duplicate_dispose_cycles.py --limit 50      # dry run, first 50 bursts
    python scripts/collapse_duplicate_dispose_cycles.py --apply         # writes

Reads MYSQL_* the same way every other script here does - see scripts/mysql_lib.py.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib  # noqa: E402

APP_SCHEMA = "PEP_CLS"
BURST_SECONDS = 60
BACKUP_DIR = Path(__file__).resolve().parent.parent / "data" / "cleanup-backups"

FIELDS = [
    "id", "order_id", "agent_email", "assigned_at", "disposed_at", "reassigned_away_at",
    "disposition", "connected", "attempt", "agent_remarks", "new_order_id", "refund_amount",
    "awb_code", "rto_reason", "payment_mode", "delivery_partner",
]


def fetch_candidate_rows():
    """Every disposed row belonging to an (order_id, agent_email) pair that has more than one.
    Ordered so the grouping below can walk each pair's rows in time order."""
    cols = ", ".join(f"c.{f}" for f in FIELDS)
    return mysql_lib.query(
        f"""
        SELECT {cols}
        FROM CLS_RTO_calling c
        JOIN (
            SELECT order_id, agent_email
            FROM CLS_RTO_calling
            WHERE disposed_at IS NOT NULL
            GROUP BY order_id, agent_email
            HAVING COUNT(*) > 1
        ) d ON d.order_id = c.order_id AND d.agent_email = c.agent_email
        WHERE c.disposed_at IS NOT NULL
        ORDER BY c.order_id, c.agent_email, c.disposed_at, c.id
        """,
        database=APP_SCHEMA,
    )


def to_dict(row):
    return {f: row[i] for i, f in enumerate(FIELDS)}


def group_bursts(rows):
    """[(keep_row, [rows_to_delete])] - chains of rows disposed within BURST_SECONDS of the
    previous one. A gap longer than that ends the chain, so an agent re-opening the same lead
    after lunch keeps both cycles."""
    bursts = []
    current = []
    prev_key = None
    prev_disposed = None
    for raw in rows:
        r = to_dict(raw)
        key = (r["order_id"], r["agent_email"])
        gap = None if prev_disposed is None else (r["disposed_at"] - prev_disposed).total_seconds()
        if key != prev_key or gap is None or gap > BURST_SECONDS:
            if len(current) > 1:
                bursts.append(current)
            current = [r]
        else:
            current.append(r)
        prev_key, prev_disposed = key, r["disposed_at"]
    if len(current) > 1:
        bursts.append(current)
    return bursts


def outcome_is_uniform(burst):
    """A burst where the outcome actually changed between clicks is a human decision, not a
    double-submit - leave it for someone to look at rather than picking a winner here."""
    def outcome(r):
        return (r["disposition"], r["connected"], r["new_order_id"])
    return len({outcome(r) for r in burst}) == 1


def plan(bursts):
    keep_plan, skipped = [], []
    for b in bursts:
        if not outcome_is_uniform(b):
            skipped.append(b)
            continue
        keep, dupes = b[0], b[1:]
        last = b[-1]
        keep_plan.append({
            "keep_id": keep["id"],
            "order_id": keep["order_id"],
            "agent_email": keep["agent_email"],
            "assigned_at": keep["assigned_at"],
            "final_disposed_at": last["disposed_at"],
            "final_reassigned_away_at": last["reassigned_away_at"],
            "delete_ids": [d["id"] for d in dupes],
            "delete_rows": dupes,
        })
    return keep_plan, skipped


def json_default(o):
    return o.isoformat() if isinstance(o, datetime) else str(o)


def write_backup(keep_plan):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = BACKUP_DIR / f"duplicate-dispose-cycles-{stamp}.json"
    payload = [
        {k: v for k, v in item.items() if k != "delete_rows"} | {"deleted_rows": item["delete_rows"]}
        for item in keep_plan
    ]
    path.write_text(json.dumps(payload, indent=2, default=json_default), encoding="utf-8")
    return path


def apply(keep_plan):
    """One transaction per burst: the kept row is updated to the group's final state and the
    duplicates deleted together, so no burst can end up half-collapsed."""
    import pymysql
    cred = mysql_lib.get_credential()
    if cred is None:
        sys.exit("MYSQL_* credentials not configured - see scripts/mysql_lib.py")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=APP_SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    deleted = 0
    try:
        cur = conn.cursor()
        for item in keep_plan:
            ids = item["delete_ids"]
            placeholders = ", ".join(["%s"] * len(ids))
            # DELETE first: the kept row cannot be made live again while a duplicate still
            # holds live_order_id_key/live_awb_code_key for the same order.
            cur.execute(f"DELETE FROM CLS_RTO_calling WHERE id IN ({placeholders})", ids)
            cur.execute(
                "UPDATE CLS_RTO_calling SET disposed_at = %s, reassigned_away_at = %s WHERE id = %s",
                (item["final_disposed_at"], item["final_reassigned_away_at"], item["keep_id"]),
            )
            conn.commit()
            deleted += len(ids)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return deleted


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="actually write - without this it is a dry run")
    ap.add_argument("--limit", type=int, default=None, help="only process the first N bursts")
    args = ap.parse_args()

    rows = fetch_candidate_rows()
    if rows is None:
        sys.exit("MYSQL_* credentials not configured - see scripts/mysql_lib.py")
    bursts = group_bursts(rows)
    keep_plan, skipped = plan(bursts)
    if args.limit:
        keep_plan = keep_plan[: args.limit]

    to_delete = sum(len(i["delete_ids"]) for i in keep_plan)
    print(f"candidate rows scanned : {len(rows)}")
    print(f"bursts found           : {len(bursts)}")
    print(f"bursts to collapse     : {len(keep_plan)}")
    print(f"bursts skipped (outcome changed mid-burst): {len(skipped)}")
    print(f"rows to delete         : {to_delete}")
    print()
    for item in keep_plan[:10]:
        print(f"  order {item['order_id']} / {item['agent_email']}: keep id {item['keep_id']} "
              f"(assigned {item['assigned_at']}), delete {len(item['delete_ids'])} -> {item['delete_ids'][:6]}"
              f"{' ...' if len(item['delete_ids']) > 6 else ''}")
    if len(keep_plan) > 10:
        print(f"  ... and {len(keep_plan) - 10} more bursts")
    for b in skipped[:5]:
        print(f"  SKIPPED order {b[0]['order_id']} / {b[0]['agent_email']}: "
              f"{len(b)} rows with differing outcomes {[ (r['disposition'], r['connected']) for r in b ]}")

    if not args.apply:
        print("\nDRY RUN - nothing written. Re-run with --apply to make these changes.")
        return
    if not keep_plan:
        print("\nNothing to do.")
        return
    backup = write_backup(keep_plan)
    print(f"\nbackup written: {backup}")
    deleted = apply(keep_plan)
    print(f"deleted {deleted} duplicate rows across {len(keep_plan)} bursts")


if __name__ == "__main__":
    main()
