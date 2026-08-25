"""One-time reconciliation of PEP_CLS.ndr_lead_assignments against the NDR sheet, which is the
source of truth for who holds a lead and whether it was worked (see assign_ndr_leads.py's module
docstring - this table is a parallel history mirror, never the thing the CRM reads leads from).

Why it was needed (2026-08-25): both halves of that mirror are best-effort writes that swallow
their own failures, and both had been dropping rows. Measured drift at the time:

    disposed on the sheet, no live row here at all ....... 1,257
    disposed on the sheet, row here still showing open ....   226
    open on the sheet, live row under another agent .......     1

Every reader of this table - getAllNdrLeadDates, the CRM's Agent Performance Summary, the NDR
KPI tiles - was that far behind while the sheet itself stayed correct throughout, which is why
nobody saw it until agents asked why their numbers had stopped moving. The write paths are fixed
separately (assign_ndr_leads.record_new_assignments now reports failure instead of swallowing it,
and db.js's disposeNdrLead inserts the cycle when it finds none to update); this script repairs
the history those bugs already lost.

TIMESTAMPS ARE APPROXIMATED, deliberately and visibly. The sheet records Calling Date (column R)
as a day, with no time, and keeps no assignment date at all, so:

  * disposed_at = that day at 06:30 UTC (= 12:00 IST, mid-day, so the instant can never land on
    the neighbouring IST date whichever way it is read back).
  * assigned_at = the SAME instant. The true one is unrecoverable. Same-instant is the least
    wrong option available: it attributes each lead to the day it was actually called, whereas
    stamping now() - what the 2026-08-13 NDR backfill did (see lambda/README.md) - would pile
    1,257 leads onto "assigned today" and corrupt exactly the report this is meant to repair.
    The cost is that FRT/handle-time for these rows reads as zero; they are identifiable as
    backfilled by that (assigned_at = disposed_at to the second).

Rows whose Calling Date will not parse are skipped and counted, not guessed at.

Idempotent: re-running converges, so it is safe to run again after a later drift.

    python scripts/backfill_ndr_mirror_from_sheet.py            # dry run, changes nothing
    python scripts/backfill_ndr_mirror_from_sheet.py --apply
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib

SPREADSHEET_ID = "12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI"
SHEET_TAB = "Latest NDR "  # trailing space is part of the real tab name - do not trim it
APP_SCHEMA = "PEP_CLS"

# Same indices assign_ndr_leads.py uses, plus the three disposition columns NdrCallingClient.js's
# saveNdrDisposition writes (R/U/AB - see its `ranges` array).
COL_AWB = 4            # E
COL_CALLING_DATE = 17  # R - written on disposition
COL_AGENT = 18         # S
COL_CONNECTED = 19     # T - non-blank == worked, the same signal assign_ndr_leads.py uses
COL_OUTCOME = 20       # U
COL_REMARKS = 27       # AB

# 12:00 IST expressed as UTC - see the module docstring on why mid-day, not midnight.
MIDDAY_IST_AS_UTC = timedelta(hours=6, minutes=30)

BATCH = 500


def cell(row, index):
    return row[index].strip() if len(row) > index and row[index] else ""


def parse_calling_date(raw):
    """The sheet writes DD-MM-YYYY (see saveNdrDisposition's callingDate), but this column is
    also hand-edited by the other CS/ops team that owns this spreadsheet, so the two other
    orderings actually present are accepted too. None if it will not parse at all - the caller
    skips those rather than inventing a date."""
    raw = (raw or "").strip()
    if not raw:
        return None
    for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt) + MIDDAY_IST_AS_UTC
        except ValueError:
            continue
    return None


def read_sheet_truth():
    """{awb: (agent_email, disposed_at_or_None, disposition, remarks, unparsed_date_flag)}.

    Last sheet row wins for a repeated AWB - the sheet carries 358 duplicated AWBs, and only one
    live row per AWB can exist here (ndr_lead_assignments_live_awb_key), so the later row is
    taken as current for the same reason record_new_assignments dedupes its own batch."""
    rows = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A2:AB1000000")
    truth = {}
    for row in rows or []:
        awb, agent = cell(row, COL_AWB), cell(row, COL_AGENT).lower()
        if not awb or not agent:
            continue
        connected = cell(row, COL_CONNECTED)
        disposed_at = parse_calling_date(cell(row, COL_CALLING_DATE)) if connected else None
        truth[awb] = (
            agent,
            disposed_at,
            cell(row, COL_OUTCOME) or None,
            cell(row, COL_REMARKS) or None,
            bool(connected) and disposed_at is None,
        )
    return truth


def read_live_rows():
    """{awb: (email, disposed_at)} for every non-retired cycle."""
    rows = mysql_lib.query(
        "SELECT awb_number, email, disposed_at FROM ndr_lead_assignments "
        "WHERE reassigned_away_at IS NULL",
        database=APP_SCHEMA,
    )
    return {awb: (email, disposed_at) for awb, email, disposed_at in (rows or [])}


def plan(truth, live):
    """(inserts, disposals, reowns, skipped_unparsed) - what would be written, decided purely
    from the two snapshots so the dry run and the real run can never disagree."""
    inserts, disposals, reowns, skipped = [], [], [], []
    for awb, (agent, disposed_at, disposition, remarks, unparsed) in truth.items():
        if unparsed:
            skipped.append(awb)
            continue
        current = live.get(awb)
        if current is None:
            if disposed_at is not None:
                # Worked on the sheet with nothing here to show it - the assignment mirror never
                # landed, so the disposal mirror had no row to update either.
                inserts.append((awb, agent, disposed_at, disposition, remarks))
            # else: open on the sheet and absent here. Left alone deliberately - the lead is
            # still live work and the next disposal now inserts its own cycle (see db.js's
            # disposeNdrLead), so inventing an assigned_at for it buys nothing.
            continue
        current_email, current_disposed = current
        if current_email.lower() != agent:
            reowns.append((awb, agent, disposed_at, disposition, remarks))
        elif disposed_at is not None and current_disposed is None:
            # Row exists and is the right agent's, but still reads open here.
            disposals.append((awb, disposed_at, disposition, remarks))
    return inserts, disposals, reowns, skipped


def apply_plan(inserts, disposals, reowns):
    cred = mysql_lib.get_credential()
    if cred is None:
        print("MYSQL_* credentials not configured - cannot apply.")
        return False
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=APP_SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        for start in range(0, len(disposals), BATCH):
            cur.executemany(
                "UPDATE ndr_lead_assignments SET disposed_at = %s, "
                "disposition = COALESCE(%s, disposition), "
                "agent_remarks = COALESCE(%s, agent_remarks) "
                "WHERE awb_number = %s AND reassigned_away_at IS NULL",
                [(d, disp, rem, awb) for awb, d, disp, rem in disposals[start:start + BATCH]],
            )
            print(f"  disposals {start + 1}-{min(start + BATCH, len(disposals))} stamped")

        now = datetime.now(timezone.utc).replace(tzinfo=None)  # stored naive-but-UTC, as everywhere here

        # Retire before inserting: the outgoing cycle has to leave live_awb_number before the
        # incoming one can take it - same ordering record_lead_assignments needs.
        if reowns:
            cur.executemany(
                "UPDATE ndr_lead_assignments SET reassigned_away_at = %s "
                "WHERE awb_number = %s AND reassigned_away_at IS NULL",
                [(d or now, awb) for awb, _a, d, _disp, _rem in reowns],
            )

        to_insert = inserts + reowns
        for start in range(0, len(to_insert), BATCH):
            chunk = to_insert[start:start + BATCH]
            cur.executemany(
                "INSERT INTO ndr_lead_assignments "
                "(awb_number, email, assigned_at, disposed_at, disposition, agent_remarks) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                # assigned_at = disposed_at, on purpose - see the module docstring. A reown of a
                # lead still OPEN on the sheet has no disposed_at at all, so it takes `now` for
                # assigned_at (it is a live cycle starting now, not a historical one) and stays
                # NULL for disposed_at - assigned_at is NOT NULL, disposed_at is not.
                [(awb, agent, d or now, d, disp, rem) for awb, agent, d, disp, rem in chunk],
            )
            print(f"  inserts {start + 1}-{start + len(chunk)} written")
        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main(argv):
    apply_it = "--apply" in argv
    truth = read_sheet_truth()
    live = read_live_rows()
    print(f"sheet rows with an agent: {len(truth)}   live rows in MySQL: {len(live)}")

    inserts, disposals, reowns, skipped = plan(truth, live)
    print(f"\n  missing cycles to insert ............ {len(inserts)}")
    print(f"  open-here-but-disposed-there ........ {len(disposals)}")
    print(f"  live under the wrong agent .......... {len(reowns)}")
    print(f"  skipped, Calling Date unparseable ... {len(skipped)}")
    for label, sample in (("insert", inserts[:3]), ("dispose", disposals[:3]), ("reown", reowns[:3])):
        for item in sample:
            print(f"    e.g. {label}: {item}")
    if skipped[:5]:
        print(f"    e.g. skipped AWBs: {skipped[:5]}")

    if not (inserts or disposals or reowns):
        print("\nAlready reconciled - nothing to do.")
        return 0
    if not apply_it:
        print("\nDRY RUN - nothing written. Re-run with --apply to write.")
        return 0

    print("\nApplying...")
    if not apply_plan(inserts, disposals, reowns):
        return 1

    # Re-read and re-plan rather than trusting the counts above: the only claim worth printing
    # is that a fresh snapshot now agrees.
    remaining = plan(read_sheet_truth(), read_live_rows())
    left = len(remaining[0]) + len(remaining[1]) + len(remaining[2])
    print(f"\nRe-checked: {left} row(s) still out of sync "
          f"({len(remaining[3])} skipped for an unparseable Calling Date).")
    return 0 if left == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
