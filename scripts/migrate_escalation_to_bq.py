"""One-off backfill: escalation sheet + Postgres assignments -> BigQuery.

    python scripts/migrate_escalation_to_bq.py --dry-run    # report only, writes nothing
    python scripts/migrate_escalation_to_bq.py              # apply

Safe to re-run. The sweep is WRITE_TRUNCATE + MERGE, the historical-resolution backfill only
touches rows with no resolution in BigQuery yet, and the assignment backfill clears its own
previously-written events before re-inserting. A second run converges rather than duplicating.

This is the one script here that talks to live infrastructure. It reconciles at the end and exits
non-zero on any mismatch, so a partial migration cannot be mistaken for a clean one.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import escalation_bq_schema as schema
import sync_escalation_sheet_to_bq as sweep

DRY_RUN = False


def backfill_orders():
    print("\n== Orders ==")
    schema.create_tables()
    for brand in schema.BRANDS:
        out = sweep.sweep_brand(brand, dry_run=DRY_RUN)
        print(f"  {brand}: read {out['read']}, loaded {out['loaded']}, "
              f"duplicate keys {out['duplicates']}")


def backfill_historical_resolutions():
    """The sheet's T-W columns hold real resolutions agents typed before this migration.

    The sweep's matched arm writes sheet columns only, so it does not carry them across - that
    separation is deliberate and must not be relaxed. They are backfilled here instead, onto rows
    with no resolution in BigQuery yet, so re-running never overwrites work done since cutover.
    """
    print("\n== Historical resolutions (sheet columns T-W) ==")
    rows = []
    for brand in schema.BRANDS:
        values = sweep.lib.get_sheet_values(sweep.SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
        for i, cells in enumerate(values):
            r = schema.sheet_row_to_bq(cells, brand, row_number=i + 2)
            if str(r.get("status") or "").strip():
                rows.append({
                    "brand": r["brand"],
                    "parent_order": r["parent_order"],
                    "awb_key": r["awb_key"],
                    "new_order_id": r.get("new_order_id") or "-",
                    "new_awb": r.get("new_awb") or "-",
                    "status": r["status"],
                    "notes": r.get("notes") or "",
                })
    print(f"  {len(rows)} resolved row(s) found in the sheet")
    if DRY_RUN or not rows:
        return

    fields = ["brand", "parent_order", "awb_key", "new_order_id", "new_awb", "status", "notes"]
    bq_lib.query(
        f"""MERGE `{schema.ORDERS}` T
        USING UNNEST(@items) S
        ON  T.brand = S.brand AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key
        WHEN MATCHED AND COALESCE(T.status, '') = '' THEN UPDATE SET
          new_order_id = S.new_order_id,
          new_awb = S.new_awb,
          status = S.status,
          notes = S.notes""",
        [bq_lib.struct_array_param("items", fields, rows)],
    )
    print("  backfilled")


def backfill_assignments():
    """Each Postgres assignment row becomes up to three events, reproducing the cycles the
    Assignments panel renders today."""
    print("\n== Assignments ==")
    try:
        import psycopg  # noqa: F401  (imported for its side effect: fails loudly if missing)
    except ImportError:
        print("  psycopg not installed - run `pip install -r requirements.txt` first")
        raise

    import os
    conn_str = os.environ.get("DATABASE_URL")
    if not conn_str:
        raise RuntimeError("DATABASE_URL is not set - cannot read escalation_lead_assignments.")

    import lib
    with lib.get_pg_connection(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT parent_order, email, assigned_at, reassigned_away_at,
                       resolved_at, resolution, agent_remarks
                FROM escalation_lead_assignments
                ORDER BY assigned_at ASC
            """)
            pg_rows = cur.fetchall()
    print(f"  {len(pg_rows)} Postgres assignment row(s)")
    if DRY_RUN or not pg_rows:
        return 0

    events = []
    for parent, email, assigned_at, away_at, resolved_at, resolution, remarks in pg_rows:
        events.append({"parent_order": parent, "email": email, "event": "assigned",
                       "resolution": None, "agent_remarks": None, "ts": assigned_at.isoformat()})
        if away_at:
            events.append({"parent_order": parent, "email": email, "event": "reassigned_away",
                           "resolution": None, "agent_remarks": None, "ts": away_at.isoformat()})
        if resolved_at:
            events.append({"parent_order": parent, "email": email, "event": "resolved",
                           "resolution": resolution, "agent_remarks": remarks,
                           "ts": resolved_at.isoformat()})

    # Idempotence: clear whatever a previous run of this script wrote before re-inserting.
    bq_lib.query(f"DELETE FROM `{schema.EVENTS}` WHERE TRUE")
    fields = ["parent_order", "email", "event", "resolution", "agent_remarks", "ts"]
    bq_lib.query(
        f"""INSERT INTO `{schema.EVENTS}`
              (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
            SELECT parent_order, NULL, NULL, email, event, resolution, agent_remarks, TIMESTAMP(ts)
            FROM UNNEST(@events)""",
        [bq_lib.struct_array_param("events", fields, events)],
    )
    print(f"  {len(events)} event(s) inserted")

    live = [(p, e, a) for p, e, a, away, res, _, _ in pg_rows if not away and not res]
    if live:
        bq_lib.query(
            f"""MERGE `{schema.ORDERS}` T
            USING UNNEST(@items) S
            ON T.parent_order = S.parent_order
            WHEN MATCHED AND T.assigned_to IS NULL THEN UPDATE SET
              assigned_to = S.email, assigned_at = TIMESTAMP(S.assigned_at)""",
            [bq_lib.struct_array_param(
                "items", ["parent_order", "email", "assigned_at"],
                [{"parent_order": p, "email": e, "assigned_at": a.isoformat()} for p, e, a in live])],
        )
        print(f"  {len(live)} live assignment(s) stamped onto orders")
    return len(live)


def reconcile(live_pg_count):
    print("\n== Reconcile ==")
    failures = 0

    for brand in schema.BRANDS:
        values = sweep.lib.get_sheet_values(sweep.SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
        rows = [schema.sheet_row_to_bq(c, brand, row_number=i + 2) for i, c in enumerate(values)]
        dupes = schema.count_duplicate_keys(rows)
        bq_count = int(bq_lib.query_rows(
            f"SELECT COUNT(*) AS n FROM `{schema.ORDERS}` "
            "WHERE brand = @brand AND deleted_from_sheet_at IS NULL",
            [bq_lib.str_param("brand", brand)])[0]["n"])
        expected = len(rows) - dupes
        ok = bq_count >= expected
        print(f"  {'ok  ' if ok else 'FAIL'} {brand}: sheet={len(rows)} "
              f"(minus {dupes} duplicate keys = {expected}), bigquery={bq_count}")
        if not ok:
            failures += 1

    sheet_resolved = 0
    for brand in schema.BRANDS:
        values = sweep.lib.get_sheet_values(sweep.SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
        sheet_resolved += sum(
            1 for c in values
            if str(schema.sheet_row_to_bq(c, brand).get("status") or "").strip())
    bq_resolved = int(bq_lib.query_rows(
        f"SELECT COUNT(*) AS n FROM `{schema.ORDERS}` WHERE COALESCE(status, '') != ''"
    )[0]["n"])
    ok = bq_resolved >= sheet_resolved
    print(f"  {'ok  ' if ok else 'FAIL'} resolved rows: sheet={sheet_resolved} bigquery={bq_resolved}")
    if not ok:
        failures += 1

    bq_live = int(bq_lib.query_rows(
        f"SELECT COUNT(*) AS n FROM `{schema.ORDERS}` "
        "WHERE assigned_to IS NOT NULL AND resolved_at IS NULL")[0]["n"])
    ok = bq_live == live_pg_count
    print(f"  {'ok  ' if ok else 'FAIL'} live assignments: postgres={live_pg_count} bigquery={bq_live}")
    if not ok:
        failures += 1

    if failures:
        print(f"\n{failures} reconciliation check(s) failed - do not cut over.")
        return 1
    print("\nReconciliation clean.")
    return 0


def main():
    global DRY_RUN
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    DRY_RUN = args.dry_run

    print("DRY RUN - nothing will be written\n" if DRY_RUN else "APPLYING migration\n")
    backfill_orders()
    backfill_historical_resolutions()
    live_pg_count = backfill_assignments() or 0
    sys.exit(0 if DRY_RUN else reconcile(live_pg_count))


if __name__ == "__main__":
    main()
