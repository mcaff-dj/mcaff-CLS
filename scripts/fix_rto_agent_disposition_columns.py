#!/usr/bin/env python3
"""One-off repair: RTO 'Data' rows where the agent's DISPOSITION was written into Column Q
("Agent Name") instead of Column T ("RTO Reason - Agent"), leaving T empty and the real agent
lost from the sheet.

Scope, established by reading the live sheet before writing this:
  - 775 rows affected, in one contiguous block (sheet rows ~2117-2934) with ZERO occurrences
    outside it, and T empty in 100% of them. The CRM's own writeToSheetRow maps
    disposition -> T and assignedAgent -> Q correctly, and rows both before and after the
    block carry proper agent emails - so this was a one-off bulk write into the wrong column,
    not the live code path. Some values even use labels the current CRM no longer emits
    ("Switch Off", "Not Interested / Cancelled", "Busy", "Invalid / Out of Service").
  - The real agent is recovered from PEP_CLS.CLS_RTO_calling (order_id -> agent_email), the
    MySQL mirror of the CRM's own lead_assignments table. ~603 of the 775 are present there.

Deliberate decisions (confirmed before running):
  - Q gets the recovered agent email; T gets whatever disposition is currently in Q.
  - Rows with NO recoverable agent are LEFT ALONE. Q is never blanked: assign_leads.py treats
    any value in Q as "already assigned", so clearing it would put ~172 already-disposed
    leads back into the calling queue and customers would be called again.
  - Where the mirror's stored disposition disagrees with the sheet's Q value (~38 rows), the
    SHEET's value wins - the instruction was to move the disposition that's already in Q, and
    the mirror may hold a later attempt.
  - A cell whose Q value is a person's name rather than a disposition (e.g. "Aditi Sarkar")
    is not touched - only the known disposition labels below are treated as misplaced.

Dry-run by default; --apply performs the writes. Every affected cell's BEFORE value is
written to a timestamped JSON backup next to this script's output first, so the change can be
reversed.

Idempotent: once Q holds an email it no longer matches, so re-running is a no-op.
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib
from lead_priority import COL_AGENT, COL_DISPOSITION, COL_ORDER_ID

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"
KYC_DATABASE = "PEP_CLS"
REPO_ROOT = Path(__file__).resolve().parent.parent

# Every disposition label seen in Column Q, including the older ones the current CRM no longer
# emits. Anything NOT in this set is left alone - that is what keeps a genuine agent name from
# being mistaken for a misplaced disposition.
MISPLACED_DISPOSITIONS = {
    "Customer Agreed to Accept", "Delivered", "Already Refunded", "Refund Requested",
    "Product Issue / Exchange", "Address Change Requested", "Language Barrier", "Disconnected",
    "Not Interested", "Wrong Number", "Ringing / No Answer", "Line Busy", "Not Reachable",
    "Switched Off", "Call Back Later", "Invalid Number",
    # legacy labels from whatever wrote the affected block
    "Switch Off", "Not Interested / Cancelled", "Busy", "Invalid / Out of Service",
}

# 1-based column letters for the two cells this repairs, derived from the shared indices so it
# can't drift from lead_priority.py.
def _col_letter(idx0):
    n, s = idx0 + 1, ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def cell(row, i):
    return (row[i] if i < len(row) and row[i] is not None else "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    agent_col, disp_col = _col_letter(COL_AGENT), _col_letter(COL_DISPOSITION)
    print(f"Repairing '{SHEET_TAB}' column {agent_col} (Agent Name) / {disp_col} (RTO Reason - Agent)")

    rows = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A1:AE")
    if not rows:
        raise SystemExit("Could not read the sheet.")

    mirror = mysql_lib.query(
        "SELECT order_id, agent_email FROM CLS_RTO_calling WHERE agent_email IS NOT NULL AND agent_email <> ''",
        database=KYC_DATABASE,
    )
    if mirror is None:
        raise SystemExit("MySQL credentials not configured - cannot recover agent emails.")
    agent_by_order = {str(o).strip(): str(e).strip() for o, e in mirror}
    print(f"  {len(agent_by_order)} order->agent pairs available from {KYC_DATABASE}.CLS_RTO_calling")

    repairable, unrecoverable, skipped_name = [], [], []
    for n, row in enumerate(rows[1:], start=2):   # n = 1-based sheet row (row 1 is the header)
        q = cell(row, COL_AGENT)
        if q not in MISPLACED_DISPOSITIONS:
            if q and "@" not in q and cell(row, COL_DISPOSITION) == "":
                skipped_name.append((n, q))
            continue
        if cell(row, COL_DISPOSITION):
            continue  # T already populated - not one of the misplaced rows
        order_id = cell(row, COL_ORDER_ID)
        agent = agent_by_order.get(order_id)
        if agent:
            repairable.append({"row": n, "order_id": order_id, "disposition": q, "agent": agent})
        else:
            unrecoverable.append({"row": n, "order_id": order_id, "disposition": q})

    print(f"\n  repairable (agent recovered)      : {len(repairable)}")
    print(f"  left alone (no agent in mirror)    : {len(unrecoverable)}")
    print(f"  left alone (Q looks like a name)   : {len(skipped_name)}")
    for s in skipped_name:
        print(f"      row {s[0]}: {s[1]!r}")

    print("\n  sample of what would change:")
    for r in repairable[:5]:
        print(f"      row {r['row']:5} {r['order_id']:14}  {agent_col}: {r['disposition']!r} -> {r['agent']!r}"
              f"   |  {disp_col}: '' -> {r['disposition']!r}")

    if not repairable:
        print("\nNothing to repair.")
        return

    if not args.apply:
        print(f"\nDRY RUN - nothing written. Re-run with --apply to update {len(repairable)} rows "
              f"({len(repairable) * 2} cells).")
        return

    stamp = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%Y%m%d-%H%M%S")
    backup = REPO_ROOT / "data" / f"rto_agent_disposition_repair_backup_{stamp}.json"
    backup.parent.mkdir(parents=True, exist_ok=True)
    with open(backup, "w", encoding="utf-8") as f:
        json.dump({
            "spreadsheet_id": SPREADSHEET_ID, "tab": SHEET_TAB,
            "note": f"BEFORE values. To reverse: put 'disposition' back in {agent_col} and clear {disp_col}.",
            "repaired": repairable, "left_alone_no_agent": unrecoverable,
        }, f, indent=2)
    print(f"\n  backup of BEFORE values: {backup}")

    # Chunked so one batchUpdate never carries an unreasonable number of ranges.
    value_ranges = []
    for r in repairable:
        value_ranges.append({"range": f"'{SHEET_TAB}'!{agent_col}{r['row']}", "values": [[r["agent"]]]})
        value_ranges.append({"range": f"'{SHEET_TAB}'!{disp_col}{r['row']}", "values": [[r["disposition"]]]})

    CHUNK = 200
    for i in range(0, len(value_ranges), CHUNK):
        part = value_ranges[i:i + CHUNK]
        lib.set_sheet_values_batch(SPREADSHEET_ID, part)
        print(f"    wrote cells {i + 1}-{i + len(part)} of {len(value_ranges)}")

    print(f"\nRepaired {len(repairable)} rows. {len(unrecoverable)} left alone (no recoverable agent).")


if __name__ == "__main__":
    main()
