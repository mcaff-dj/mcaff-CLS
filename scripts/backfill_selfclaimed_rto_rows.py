#!/usr/bin/env python3
"""Reconciles MySQL CLS_RTO_calling against the RTO sheet, which is what actually decides who
holds a lead. Same role migrate_lead_assignments_to_cls_rto_calling.py played for the original
Postgres move, and it exists for the same reason that one did: the table drifted out of step
with the sheet and can no longer answer "how many undisposed leads does this agent hold?"

Why it drifted: an agent's own "Claim" button in rto-crm wrote Column Q and nothing else, so a
self-claimed lead had NO live row. recordLeadDisposition (api/_lib/db.js) then inserted one only
when the lead was finally disposed, stamping assigned_at = disposed_at = that moment. Measured
2026-08-18, MySQL vs the sheet's own undisposed counts:

    rasika    12 vs 34      sayli     10 vs 30
    naziyabi  40 vs 25      bhavesh    3 vs 0

- wrong in BOTH directions, so neither store could be trusted on its own. api/rto/claim.js now
records the row at claim time (see db.js's claimRtoLead), which stops NEW drift; this script
repairs what already accumulated.

This is data hygiene, NOT a prerequisite for the quota gate: api/rto/claim.js deliberately counts
load from the sheet precisely because this table cannot be trusted yet (see its getLoadByAgent).
Cleaning it up is what would eventually let that gate use a cheap indexed COUNT instead of a
14k-row sheet read - and it matters in its own right for every KPI built on this table.

The dominant drift is ORPHANED rows: live, undisposed rows whose order is no longer on the sheet
at all (it is a rolling window and old orders age out). One agent had 19 of those, plus 15 rows
whose Column Q now names someone else, against 1 lead she actually held - 35 counted, 1 real.

Two repairs, each behind its own flag so neither happens by accident:

  --apply         MISSING rows: the sheet shows an undisposed lead held by an agent and there is
                  no live row for it. Inserts one. assigned_at is genuinely unrecoverable for a
                  historical claim, so it is stamped now() as an explicit approximation - the
                  same call (and the same wording) as the 402-row NDR backfill in
                  lambda/README.md - rather than inventing a plausible past timestamp.

  --close-stale   STALE rows: a live, undisposed row whose sheet lead IS disposed. These inflate
                  the load count and over-block an agent at the quota gate. Stamps disposed_at =
                  now(). Gated separately because that timestamp is likewise an approximation,
                  and it lands in disposal-time KPIs (see getCallingOverviewStats) - a real
                  disposal from last week will be counted as having happened today.

Rows whose sheet agent disagrees with the live row's agent are REPORTED ONLY, never touched: a
mismatch is a reassignment that was never retired, and guessing which side is right could strip a
lead from whoever is actually working it. Fix those by hand once you have looked at them.

Dry run by default; prints every count and a sample before changing anything.
"""
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib
from lead_priority import (
    COL_AGENT, COL_ATTEMPT, COL_CONNECTED, COL_DISPOSITION, COL_ORDER_ID, COL_AWB_CODE,
    COL_REMARKS, COL_REMARKS_LEGACY_U, COL_RTO_REASON, cell, prefix_rule_partner,
)

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"
SCHEMA = "PEP_CLS"


def sheet_state():
    """{order_id: (agent_email, is_disposed, awb_code, rto_reason)} for every row that names an
    order. Same disposed test as scripts/assign_leads.py and the CRM (Connected / Attempt /
    Disposition / Remarks, including the legacy U column), so this agrees with both about what
    "worked" means. First row wins per order id, matching the CRM's own dedup."""
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A:AD")
    state = {}
    for row in values[1:]:
        order_id = cell(row, COL_ORDER_ID).strip()
        if not order_id or order_id in state:
            continue
        agent = cell(row, COL_AGENT).strip().lower()
        disposed = bool(
            cell(row, COL_CONNECTED) or cell(row, COL_ATTEMPT) or cell(row, COL_DISPOSITION)
            or cell(row, COL_REMARKS) or cell(row, COL_REMARKS_LEGACY_U)
        )
        state[order_id] = (agent, disposed, cell(row, COL_AWB_CODE).strip(), cell(row, COL_RTO_REASON).strip())
    return state


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Insert the MISSING rows (default is a dry run).")
    ap.add_argument("--close-stale", action="store_true",
                    help="Also stamp disposed_at on STALE live rows the sheet shows as disposed. "
                         "See the module docstring - this lands in disposal-time KPIs.")
    args = ap.parse_args()

    if mysql_lib.get_credential() is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    print(f"Reading '{SHEET_TAB}'...")
    state = sheet_state()
    print(f"  {len(state)} distinct order id(s) on the sheet")

    live = {}
    for order_id, agent, disposed_at in mysql_lib.query(
        "SELECT order_id, agent_email, disposed_at FROM CLS_RTO_calling WHERE reassigned_away_at IS NULL",
        database=SCHEMA,
    ) or []:
        live[order_id] = ((agent or "").strip().lower(), disposed_at)
    print(f"  {len(live)} live (non-reassigned) row(s) in CLS_RTO_calling")

    missing, stale, mismatched = [], [], []
    for order_id, (agent, disposed, awb, reason) in state.items():
        if not agent or agent == "unassigned":
            continue
        row = live.get(order_id)
        if row is None:
            if not disposed:
                missing.append((order_id, agent, awb, reason))
            continue
        live_agent, disposed_at = row
        if live_agent != agent:
            mismatched.append((order_id, agent, live_agent))
        elif disposed and disposed_at is None:
            stale.append(order_id)

    # Live rows for orders the sheet no longer carries at all. These are the single biggest
    # source of inflated load counts, and they are REPORTED ONLY: absence from the sheet is not
    # evidence of anything having happened to the lead, so closing them would be inventing a
    # disposal. Deciding what these mean (worked and aged out? dropped in a refresh?) needs a
    # human who knows how the sheet is rebuilt.
    orphaned = [o for o, (_a, d) in live.items() if d is None and o not in state]

    print()
    print(f"MISSING   (sheet holds an undisposed lead, no live row): {len(missing)}")
    print(f"STALE     (live row undisposed, sheet says disposed)   : {len(stale)}")
    print(f"MISMATCH  (sheet agent != live row agent, NOT touched) : {len(mismatched)}")
    print(f"ORPHANED  (live row, order absent from sheet, NOT touched): {len(orphaned)}")
    for label, sample in (("missing", missing[:5]), ("stale", stale[:5]),
                          ("mismatch", mismatched[:5]), ("orphaned", orphaned[:5])):
        if sample:
            print(f"  sample {label}: {sample}")

    if not args.apply and not args.close_stale:
        print("\nDry run - re-run with --apply (and optionally --close-stale) to write.")
        return

    now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive-but-UTC, this table's convention
    cred = mysql_lib.get_credential()
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        if args.apply and missing:
            # One at a time, not executemany: a live_awb_code_key collision is a real data error
            # for that ONE lead (two leads sharing a live AWB) and must not abort the other
            # several hundred legitimate inserts.
            inserted = failed = 0
            for order_id, agent, awb, reason in missing:
                try:
                    cur.execute(
                        "INSERT INTO CLS_RTO_calling (order_id, agent_email, assigned_at, awb_code, rto_reason, delivery_partner) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        (order_id, agent, now, awb or None, reason or None, prefix_rule_partner(awb) or None),
                    )
                    inserted += 1
                except Exception as e:
                    failed += 1
                    print(f"  ! {order_id} ({agent}): {e}")
            conn.commit()
            print(f"\nInserted {inserted} missing row(s); {failed} failed (listed above).")

        if args.close_stale and stale:
            cur.executemany(
                "UPDATE CLS_RTO_calling SET disposed_at = %s WHERE order_id = %s AND disposed_at IS NULL "
                "AND reassigned_away_at IS NULL",
                [(now, order_id) for order_id in stale],
            )
            conn.commit()
            print(f"Closed {len(stale)} stale row(s) (disposed_at = now, an approximation).")

        if mismatched:
            print(f"\n{len(mismatched)} mismatched row(s) left untouched - review by hand:")
            for order_id, sheet_agent, live_agent in mismatched[:20]:
                print(f"  {order_id}: sheet={sheet_agent}  live_row={live_agent}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
