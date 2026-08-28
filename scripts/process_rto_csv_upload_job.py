#!/usr/bin/env python3
"""Background worker for the RTO CSV upload feature (api/rto/upload-start.js). Invoked
fire-and-forget by that endpoint's triggerLambda call, event shape {"jobId": <int>}.

Runs the SAME checks scripts/assign_leads.py already runs for its own pool - check_already_punched
then resolve_refund_statuses, imported unmodified - against the prepaid rows one CSV upload
queued, since those checks need mcaff_prod MySQL access this app deliberately keeps Python-only
(see docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md's "Why Item_level_data is
required" section). The GoKwik refund check is prepaid-only - COD paid nothing upfront to
refund - but the LMD punch check is not: a replacement order makes the original RTO pointless
however it was paid for. COD rows used to be appended by the endpoint and skip this worker
entirely, so they were never punch-checked at all (found via HYP43652510).

EVERY row from the upload reaches this worker, whatever its payment method - api/rto/upload-start.js
appends nothing itself. The punch check has to run BEFORE the write, so the write lives here too.

Order of operations, matching assign_leads.py's own main() exactly:
  1. LMD punch-check ALL queued rows (any payment method) - one/few fast batched MySQL queries,
     no chunking needed.
  2. Exclude punched rows from the refund-check entirely (no point paying a GoKwik round-trip
     for a lead already excluded for a different reason - same optimization assign_leads.py's
     own main() already applies).
  3. GoKwik refund-check the remaining PREPAID rows, looped in resolve_refund_statuses' own
     internal chunk/time-budget (GOKWIK_MAX_CHECKS_PER_RUN=120, GOKWIK_TIME_BUDGET_SEC=20s) -
     this worker does not re-implement chunking, it just calls that function repeatedly with
     whatever remains unresolved each round, with a pause between rounds for real breathing
     room against GoKwik's own rate limits (the user's own explicit request).

     resolve_refund_statuses(order_ids, dirty) ALWAYS returns an entry for every order_id
     passed to it that round (verified by reading scripts/assign_leads.py:415-509): entries
     over its own GOKWIK_MAX_CHECKS_PER_RUN budget get a conservative False in the return dict
     but are NOT added to `dirty`; same for entries with no vendor credentials, and entries cut
     off by its own GOKWIK_TIME_BUDGET_SEC mid-run. Only entries resolved on real evidence -
     a live GoKwik verdict, or a confirmed "no Shopify platform ID" - get written into `dirty`
     (assign_leads.py:508, `dirty.update(cacheable)`), because those are the only results
     durable enough to cache. So narrowing `remaining` by "not in dirty" is exactly right: it
     keeps retrying only what wasn't actually resolved, while every round's full return value
     still gets merged into all_refund_results so nothing is left without an entry. The
     REFUND_CHECK_PHASE_BUDGET_SEC wall-clock check on the while loop itself (not just reliance
     on `remaining` shrinking to empty) is what guarantees termination even in the pathological
     case where the same head-of-list orders keep getting cut off round after round.
  4. One batched append of every row - punched/refunded rows pre-stamped as disposed, the rest
     as fresh unassigned leads.

Never raises out of process_job (network/DB blips are caught and turn the job status into
'failed' with error_message set, rather than crashing the Lambda invocation silently) - the
browser is polling this job's status and needs SOMETHING to show even on failure.
"""
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import assign_leads
import mysql_lib
from lead_priority import is_prepaid

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"

# Same stamp text scripts/assign_leads.py's own main() writes for these two cases - see its
# ALREADY_REFUNDED/ALREADY_PUNCHED module-level constants, reused directly rather than
# hand-copied so the two paths can never drift on wording.
REFUNDED_STAMP = (assign_leads.ALREADY_REFUNDED, assign_leads.ALREADY_REFUNDED,
                  "Auto-detected via GoKwik refund status check - not assigned.")
PUNCHED_STAMP = (assign_leads.ALREADY_PUNCHED, assign_leads.ALREADY_PUNCHED,
                 f"Auto-detected via {assign_leads.LMD_TABLE} (D2C channel) - order already punched, not assigned.")

# Pause between refund-check rounds - the user's own explicit request ("give breathing to
# API") on top of resolve_refund_statuses' own internal per-round time budget. Deliberately
# separate from that function's own GOKWIK_TIME_BUDGET_SEC (20s): that constant bounds ONE
# round; this bounds the GAP between rounds.
REFUND_CHECK_ROUND_PAUSE_SEC = 3
# Overall ceiling on the refund-check phase, comfortably inside the worker Lambda's own
# 900s (15 min) timeout - leaves room for the punch-check phase and the final append too.
REFUND_CHECK_PHASE_BUDGET_SEC = 600


APPENDED_ROW_RANGE_RE = re.compile(r"![A-Za-z]+(\d+):[A-Za-z]+(\d+)$")


def parse_appended_row_range(updated_range):
    r"""('7630', '7639') from a Sheets values:append updates.updatedRange like
    "Data!A7630:AD7639", so the post-append AWB canary can read back exactly the rows that just
    landed. None when the range isn't in that shape.

    [A-Za-z]+, NOT \w+: \w matches digits too, so r"!\w+(\d+):\w+(\d+)$" backtracked into
    capturing only the LAST digit of each row number ("A7630" -> "0"), producing ranges like
    'Data'!G0:G9 that Sheets rejects with "Unable to parse range". This is now the only copy of
    that logic left in the codebase - the JS endpoint no longer appends at all - so it is named
    and tested here rather than left inline."""
    m = APPENDED_ROW_RANGE_RE.search(updated_range or "")
    return (m.group(1), m.group(2)) if m else None


def partition_and_stamp(rows, punched_ids, refund_results):
    """Pure - no I/O. Decides each row's `stamp` (a (S, T, U) tuple to write, or None for a
    plain fresh/unassigned row) from already-computed punch/refund results. Punched wins over
    refunded if a row were somehow in both (see this file's own test for why that shouldn't
    actually happen given the calling order in process_job, but the function stays correct
    either way rather than assuming)."""
    out = []
    for row in rows:
        order_id = row["orderId"]
        if order_id in punched_ids:
            stamp = PUNCHED_STAMP
        elif refund_results.get(order_id):
            stamp = REFUNDED_STAMP
        else:
            stamp = None
        out.append({**row, "stamp": stamp})
    return out


def _update_job(conn, job_id, **fields):
    """Partial UPDATE of one job row - mirrors api/_lib/db.js's updateRtoCsvUploadJob in spirit
    (both only ever touch this table's own columns), but this is Python's own pymysql
    connection, not a call into the Node file. Always sets updated_at - a Python-computed
    naive-but-UTC value (see fetch_current_assignment_times in assign_leads.py), not SQL
    NOW(), whose session time_zone this app does not control."""
    if not fields:
        return
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    set_clauses = []
    values = []
    for key, value in fields.items():
        set_clauses.append(f"{key} = %s")
        values.append(value)
    values.append(now)
    values.append(job_id)
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE rto_csv_upload_jobs SET {', '.join(set_clauses)}, updated_at = %s WHERE id = %s",
            values,
        )
    conn.commit()


def _fetch_job(conn, job_id):
    """Returns (status, rows_pending_list). (None, []) if the job row doesn't exist at all -
    callers only special-case the string 'done', so a missing/NULL status still falls through
    to the same "no pending rows" handling this had before status was added to the query."""
    import json
    with conn.cursor() as cur:
        cur.execute("SELECT status, rows_pending FROM rto_csv_upload_jobs WHERE id = %s", (job_id,))
        row = cur.fetchone()
    if row is None:
        return None, []
    status, rows_pending = row
    if rows_pending is None:
        rows = []
    else:
        rows = rows_pending if isinstance(rows_pending, list) else json.loads(rows_pending)
    return status, rows


def _normalize_header(h):
    """Same normalization convention as api/_lib/rtoCsvImport.js's normalizeHeader (lowercase,
    strip everything but letters/digits) - reimplemented here (not shared) since this file is
    Python and that one is JS; kept in exact sync by hand, same constraint this feature's own
    isPrepaid already lives with (see upload-start.js's own comment on that)."""
    return "".join(c for c in (h or "").lower() if c.isalnum())


def _column_letter_to_index(letter):
    """Bijective base-26: A=0, B=1, ..., Z=25, AA=26, AB=27, ... - Python mirror of
    api/_lib/rtoCsvImport.js's columnLetterToIndex."""
    n = 0
    for c in letter:
        n = n * 26 + (ord(c) - 64)
    return n - 1


# The live "Data" sheet's own header text at each column this feature writes to, as read on
# 2026-08-22 - Python mirror of api/_lib/rtoCsvImport.js's EXPECTED_SHEET_HEADER. Not used to
# LOCATE columns (COLUMN_FOR below fixes those absolutely) - only to detect drift before
# writing: if a column gets inserted/reordered in the live sheet, refuse rather than silently
# land data in the wrong place.
EXPECTED_SHEET_HEADER = {
    "A": "CXB CV", "B": "RTO Initiated Date", "C": "Latest NDR Date", "D": "RTO Reason",
    "E": "Order ID", "F": "Unique", "G": "AWB Code", "H": "Customer Email",
    "I": "Customer Name", "J": "Customer Mobile", "K": "Address", "L": "Address City",
    "M": "Address State", "N": "Address Pincode", "O": "Payment Method", "P": "Order Total",
    # 2026-08-28: the "Key" column at AA was deleted from the live sheet, shifting these two one
    # left (Facility Name AB->AA, Courier Company AC->AB). Kept in sync by hand with
    # api/_lib/rtoCsvImport.js, same as the rest of this mirror.
    "AA": "Facility Name", "AB": "Courier Company",
}

# Fixed sheet column each row's cellsByColumn key maps to what column letter it already is
# (api/_lib/rtoCsvImport.js's buildRowPlan already keys cellsByColumn by column letter, so
# this worker just needs AWB Code's own letter, not a full mapping).
AWB_COLUMN = "G"
LAST_COLUMN_LETTER = "AB"
ROW_WIDTH = _column_letter_to_index(LAST_COLUMN_LETTER) + 1

# Sheets' values:append does NOT write at the range it is given. It searches that range for a
# "table" and writes starting at THAT table's own first column - so the range only ever selects
# which block of data to append after, never where the columns land.
#
# Handing it the full A2:AC width is what caused the 2026-08-28 corruption: the range spanned two
# blocks whose data ended at different rows (A-P, then AB-AC), Sheets picked the AB one, and every
# field landed exactly 27 columns right of target - A->AB, B->AC, C->AD, D->AE, E->AF, G->AH, and
# so on through L->AM. Worse, it cascades: those shifted rows then sit lower than the A-P block,
# so the NEXT append mis-detects for the same reason, which is why it looked random rather than
# one-off.
#
# Anchoring on column A alone leaves exactly one column to detect, so "the table's first column"
# can only ever be A. The row array is still the full ROW_WIDTH, and append writes all of it
# starting at that first column - the write stays A..AC, only the detection narrows. Column A is
# the right anchor because this feature fills it on every row it writes and never leaves it empty
# (api/_lib/rtoCsvImport.js's blankPlaceholder = 'NA'), so its block always reaches the true
# bottom of our data.
APPEND_ANCHOR_RANGE = "A2:A"
# Q (Agent Name) blank, R (Connected) blank, then S/T/U carry the punched/refunded stamp -
# same layout PUNCHED_STAMP/REFUNDED_STAMP above have always targeted.
STAMP_START_INDEX = _column_letter_to_index("S")


def _check_sheet_layout(full_header_row):
    """Returns a list of human-readable mismatch descriptions (empty if the live header row
    still matches EXPECTED_SHEET_HEADER at every column this feature writes to)."""
    issues = []
    for letter, expected in EXPECTED_SHEET_HEADER.items():
        idx = _column_letter_to_index(letter)
        actual = full_header_row[idx] if idx < len(full_header_row) else ""
        if _normalize_header(actual) != _normalize_header(expected):
            issues.append(f'Column {letter} is now "{actual}", expected "{expected}"')
    return issues


def _connect():
    """This connection is used only for rto_csv_upload_jobs (_fetch_job/_update_job below) -
    the DWH-side LMD/Item_level_data/GoKwik calls go through assign_leads.py's own separately
    scoped mysql_lib.query(..., database=ITEM_LEVEL_SCHEMA) calls, not this connection. That
    table lives in PEP_CLS (same schema api/_lib/db.js's pool defaults to), not
    MYSQL_DATABASE's mcaff_prod - hardcoding it here, same as db.js's own 'PEP_CLS' default,
    rather than trusting cred["database"]."""
    cred = mysql_lib.get_credential()
    if cred is None:
        raise RuntimeError("MYSQL_* credentials not configured")
    import pymysql
    return pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database="PEP_CLS", port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )


# The live-AWB-re-check-then-append sequence below is only safe against a CONCURRENT worker if
# nothing else can append between the read and the write. Two jobs overlapping is not
# hypothetical: RtoUploadModal aborts its chunk loop on the first failed chunk but cannot cancel
# a worker job already queued, so an orphaned job from an aborted upload keeps running (the
# punch/refund phases take minutes) and appends long after the modal gave up. Re-uploading the
# same file then races it - both workers read column G before either appends, both conclude the
# AWB is absent, and both append it. That is the only way a duplicate AWB can reach this sheet,
# and it produced real duplicates (SF3739213893MCA and a batch of SF36163*MCA rows).
#
# A MySQL named lock, not a row lock or a sheet-side marker: this connection already exists, the
# lock is released automatically if the Lambda dies mid-job (it is connection-scoped), and there
# is no table to keep clean afterwards.
APPEND_LOCK_NAME = "rto_csv_append"
# Longer than a worst-case append (one values:append of a few thousand rows, plus lib.py's own
# retry budget) but far under the 900s Lambda timeout, so waiting for the lock can never be what
# kills the job.
APPEND_LOCK_TIMEOUT_SEC = 180


def _acquire_append_lock(conn):
    """True if this worker now holds the append lock. GET_LOCK returns 1 on success, 0 on
    timeout, NULL on error - only 1 means we may append."""
    with conn.cursor() as cur:
        cur.execute("SELECT GET_LOCK(%s, %s)", (APPEND_LOCK_NAME, APPEND_LOCK_TIMEOUT_SEC))
        got = cur.fetchone()[0]
    return got == 1


def _release_append_lock(conn):
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT RELEASE_LOCK(%s)", (APPEND_LOCK_NAME,))
    except Exception as e:
        # Not fatal: the lock is connection-scoped, so it goes away when this connection does.
        print(f"  could not release {APPEND_LOCK_NAME} lock (harmless, it is connection-scoped): {e}")


def process_job(job_id):
    try:
        conn = _connect()
    except Exception as e:
        print(f"process_job({job_id}): could not connect to MySQL, giving up: {e}")
        return
    try:
        status, rows = _fetch_job(conn, job_id)
        if status == "done":
            # Cost-avoidance only, not the correctness fix - a genuinely duplicate append is
            # already prevented by the live AWB re-check right before the append below. This
            # just skips redoing the expensive GoKwik/MySQL check phases when the same job
            # somehow gets invoked twice for a reason other than a mid-run crash.
            print(f"process_job({job_id}): status already 'done', skipping duplicate invoke")
            return
        if not rows:
            _update_job(conn, job_id, status="failed", error_message="Job has no pending rows")
            return

        _update_job(conn, job_id, status="checking_punch")

        # Step 1: LMD punch-check, ALL rows regardless of payment method - see module docstring.
        all_order_ids = [r["orderId"] for r in rows]
        try:
            punched_ids = assign_leads.check_already_punched(set(all_order_ids))
        except Exception as e:
            print(f"  punch-check failed, treating as none punched: {e}")
            punched_ids = set()
        _update_job(conn, job_id, already_punched_count=len(punched_ids))

        # Step 2: exclude punched rows from the refund-check entirely.
        prepaid_unpunched = [
            r["orderId"] for r in rows
            if is_prepaid(r["paymentMethod"]) and r["orderId"] not in punched_ids
        ]

        # Step 3: GoKwik refund-check, looped over resolve_refund_statuses' own internal
        # chunk/time-budget, with a pause between rounds for real breathing room.
        _update_job(conn, job_id, status="checking_refund")
        all_refund_results = {}
        dirty = {}
        remaining = list(prepaid_unpunched)
        phase_started = time.monotonic()
        while remaining and (time.monotonic() - phase_started) < REFUND_CHECK_PHASE_BUDGET_SEC:
            dirty_before = len(dirty)
            round_results = assign_leads.resolve_refund_statuses(set(remaining), dirty)
            all_refund_results.update(round_results)
            # Only order_ids resolve_refund_statuses actually resolved on real evidence this
            # round land in `dirty` (over-budget, no-credentials, and time-cutoff ones are
            # deliberately excluded from it - see this module's own docstring above) -
            # narrowing `remaining` to exactly those still unresolved is what makes repeated
            # calls advance instead of re-checking the same head of the list every round.
            remaining = [oid for oid in remaining if oid not in dirty]
            checked_so_far = len(prepaid_unpunched) - len(remaining)
            already_refunded_so_far = sum(1 for v in all_refund_results.values() if v)
            _update_job(
                conn, job_id,
                checked_count=checked_so_far,
                already_refunded_count=already_refunded_so_far,
            )
            if len(dirty) == dirty_before:
                # Zero progress this round (e.g. GoKwik creds misconfigured for this worker
                # Lambda, or a batch permanently failing platform-ID lookup) - without this,
                # the loop would burn the full REFUND_CHECK_PHASE_BUDGET_SEC re-issuing the same
                # doomed batched query every REFUND_CHECK_ROUND_PAUSE_SEC for nothing.
                print(f"process_job({job_id}): refund-check round made no progress, stopping early")
                break
            if remaining:
                time.sleep(REFUND_CHECK_ROUND_PAUSE_SEC)
        try:
            assign_leads.flush_gokwik_refund_cache(dirty)
        except Exception as e:
            print(f"  gokwik cache flush failed (non-fatal): {e}")

        # Step 4: final batched append.
        _update_job(conn, job_id, status="appending")
        stamped_rows = partition_and_stamp(rows, punched_ids, all_refund_results)

        # Everything from here to the append itself must be serialised against other workers -
        # see APPEND_LOCK_NAME above for the duplicate-AWB race this closes. No explicit release
        # on the failure paths: the lock is connection-scoped and this function's own
        # `finally: conn.close()` drops it, whichever way we leave.
        if not _acquire_append_lock(conn):
            _update_job(
                conn, job_id, status="failed",
                error_message=(
                    f"Another upload has been appending for over {APPEND_LOCK_TIMEOUT_SEC}s - "
                    "nothing was written for this batch. Re-upload it once the other one finishes."
                ),
            )
            return

        # Fresh live read of the header row, right before writing - this worker runs
        # asynchronously and possibly minutes after api/rto/upload-start.js did its own header
        # read, so that snapshot can no longer be trusted. Same drift check that endpoint
        # applies to its own (synchronous, immediately-followed-by-append) read: the column
        # each field goes to is fixed (see EXPECTED_SHEET_HEADER above), this only confirms the
        # live sheet still agrees before writing to it.
        full_header_row = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A1:AD1")
        full_header_row = full_header_row[0] if full_header_row else []
        layout_issues = _check_sheet_layout(full_header_row)
        if layout_issues:
            _update_job(
                conn, job_id, status="failed",
                error_message=(
                    "Sheet column layout has changed unexpectedly - refusing to append to avoid "
                    "writing misaligned data: " + "; ".join(layout_issues)
                ),
            )
            return

        # Fresh AWB dedup, read RIGHT NOW rather than trusting upload-start.js's snapshot from
        # whenever /start ran. Two ways that snapshot goes stale by the time this worker
        # actually appends: (a) two overlapping uploads close together - job A's worker hasn't
        # appended yet when job B's /start reads the AWB set, so both would otherwise append the
        # same AWB; (b) a Lambda retry re-running this same job after a timeout that killed the
        # process after the append already landed but before the status write to 'done' did.
        # Re-checking against the sheet as it stands right this moment is what actually closes
        # both gaps - upload-start.js's own dedup only ever protected against what was in the
        # sheet at upload time.
        # UNFORMATTED_VALUE for the same reason api/rto/upload-start.js gives on its own copy of
        # this read: AWBs written before they were forced to text are stored as numbers, whose
        # FORMATTED value is "5.4E+13" and matches no real AWB. Unformatted gives back the number,
        # so str() below yields the digits - hence str(), a raw int has no .strip().
        awb_data = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!{AWB_COLUMN}2:{AWB_COLUMN}",
                                        value_render_option="UNFORMATTED_VALUE")
        live_awb_set = {str(r[0] if r else "").strip().upper() for r in awb_data}
        live_awb_set.discard("")
        before_dedup = len(stamped_rows)
        stamped_rows = [r for r in stamped_rows if r["awbCode"] not in live_awb_set]
        skipped_as_dupe = before_dedup - len(stamped_rows)
        if skipped_as_dupe:
            print(f"process_job({job_id}): {skipped_as_dupe} row(s) already present in sheet "
                  "(live AWB re-check) - skipped to avoid a duplicate append")

        values_to_append = []
        for row in stamped_rows:
            base_row = [""] * ROW_WIDTH
            for col, val in row["cellsByColumn"].items():
                base_row[_column_letter_to_index(col)] = val
            if row["stamp"]:
                # S/T/U carry the punched/refunded stamp - Q (Agent Name) and R (Connected)
                # stay blank, matching how assign_leads.py stamps its own already-
                # refunded/already-punched rows (see its own value_ranges construction).
                s, t, u = row["stamp"]
                base_row[STAMP_START_INDEX:STAMP_START_INDEX + 3] = [s, t, u]
            values_to_append.append(base_row)
        append_resp = lib.append_sheet_rows(SPREADSHEET_ID, f"'{SHEET_TAB}'!{APPEND_ANCHOR_RANGE}", values_to_append)
        # Released the moment the rows are in: the verification read and status writes below
        # cannot create a duplicate, so holding another worker off through them buys nothing.
        _release_append_lock(conn)

        # Post-write sanity check - same reasoning as api/rto/upload-start.js's own AWB
        # canary check on its immediate-append path: fixed-column writes assume this worker's
        # deployed code matches what's on disk, which is exactly what didn't hold for the
        # 2026-08-22 corrupted rows (replaying that upload through the current matching code
        # produced correct output; the live append still landed shifted). AWB Code is the one
        # column checked because row["awbCode"] comes straight from the dedup step above,
        # independent of the cellsByColumn map this is verifying.
        # ponytail: single-column canary, not a full-row round-trip - upgrade if insufficient.
        range_match = parse_appended_row_range((append_resp.get("updates") or {}).get("updatedRange", ""))
        mapping_failed = False
        if range_match and stamped_rows:
            first_row, last_row = range_match
            # Verification only - never let it decide the job's fate. The rows are already
            # appended by this point, so a failure to READ them back (a malformed range, a
            # transient Sheets error) must not fall through to the generic handler below and
            # stamp an otherwise-successful job 'failed'.
            try:
                awb_check = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!{AWB_COLUMN}{first_row}:{AWB_COLUMN}{last_row}",
                                                 value_render_option="UNFORMATTED_VALUE")
                actual_awbs = [str(r[0] if r else "").strip().upper() for r in awb_check]
                mapping_failed = any(
                    i >= len(actual_awbs) or actual_awbs[i] != stamped_rows[i]["awbCode"]
                    for i in range(len(stamped_rows))
                )
            except Exception as e:
                print(f"process_job({job_id}): post-append AWB verification could not run: {e}")
        if mapping_failed:
            print(f"process_job({job_id}): post-append AWB verification FAILED for rows "
                  f"{first_row}-{last_row} - appended data landed in the wrong columns")
            _update_job(
                conn, job_id, status="failed", appended_count=len(values_to_append), rows_pending=None,
                error_message=(
                    f"Appended {len(values_to_append)} row(s) but a post-write check found them in "
                    f"the wrong columns (rows {first_row}-{last_row}). Data is already written in the "
                    "sheet - contact an admin, do not trust it."
                ),
            )
        else:
            _update_job(
                conn, job_id, status="done", appended_count=len(values_to_append),
                rows_pending=None,
            )
    except Exception as e:
        print(f"process_job({job_id}) failed: {e}")
        # `conn` may simply be dropped (plausible after the refund-check phase holds it for up
        # to 600s - MySQL's own idle/wait_timeout, or a network blip) - roll back first (a
        # no-op on a healthy connection), and if the failure-status write still doesn't take,
        # retry once on a fresh
        # connection rather than letting the job silently never reach 'failed' (the browser is
        # polling this status and needs SOMETHING to show).
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            _update_job(conn, job_id, status="failed", error_message=str(e))
        except Exception:
            try:
                fresh_conn = _connect()
                try:
                    _update_job(fresh_conn, job_id, status="failed", error_message=str(e))
                finally:
                    fresh_conn.close()
            except Exception as e2:
                print(f"process_job({job_id}): could not record failure status either: {e2}")
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python process_rto_csv_upload_job.py <job_id>")
    process_job(int(sys.argv[1]))
