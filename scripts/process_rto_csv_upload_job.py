#!/usr/bin/env python3
"""Background worker for the RTO CSV upload feature (api/rto/upload-start.js). Invoked
fire-and-forget by that endpoint's triggerLambda call, event shape {"jobId": <int>}.

Runs the SAME checks scripts/assign_leads.py already runs for its own pool - check_already_punched
then resolve_refund_statuses, imported unmodified - against the prepaid rows one CSV upload
queued, since those checks need mcaff_prod MySQL access this app deliberately keeps Python-only
(see docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md's "Why Item_level_data is
required" section). Non-prepaid rows never reach this worker at all - api/rto/upload-start.js
already appended them immediately, since they need no check.

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
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import assign_leads
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
    (both only ever touch this table's own columns), but this is Python's own psycopg
    connection, not a call into the Node file. Always sets updated_at."""
    if not fields:
        return
    set_clauses = []
    values = []
    for key, value in fields.items():
        set_clauses.append(f"{key} = %s")
        values.append(value)
    values.append(job_id)
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE rto_csv_upload_jobs SET {', '.join(set_clauses)}, updated_at = now() WHERE id = %s",
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


def _header_index(full_header_row, target_header):
    """0-based column index of target_header in a live header row (exact normalized-equality
    match, no substring fallback - matching headerToColumnLetter's own contract), or None if
    not found."""
    target_norm = _normalize_header(target_header)
    for i, h in enumerate(full_header_row):
        if _normalize_header(h) == target_norm:
            return i
    return None


def process_job(job_id):
    conn_str = os.environ.get("POSTGRES_URL")
    try:
        conn = lib.get_pg_connection(conn_str)
    except Exception as e:
        print(f"process_job({job_id}): could not connect to Postgres, giving up: {e}")
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
            assign_leads.flush_gokwik_refund_cache(dirty, conn=conn)
        except Exception as e:
            print(f"  gokwik cache flush failed (non-fatal): {e}")

        # Step 4: final batched append.
        _update_job(conn, job_id, status="appending")
        stamped_rows = partition_and_stamp(rows, punched_ids, all_refund_results)
        target_headers = [
            "RTO Initiated Date", "Latest NDR Date", "RTO Reason", "Order ID", "Unique",
            "AWB Code", "Customer Email", "Customer Name", "Customer Mobile", "Address",
            "Address City", "Address State", "Address Pincode", "Payment Method", "Order Total",
        ]
        # Fresh live read of the header row, right before writing - this worker runs
        # asynchronously and possibly minutes after api/rto/upload-start.js did its own header
        # read, so that snapshot can no longer be trusted. Same contiguity guard that endpoint
        # applies to its own (synchronous, immediately-followed-by-append) read: only columns
        # that DID resolve are checked (a null is a legitimately-missing column, not
        # misalignment), and each resolved column must sit exactly `i` positions after
        # target_headers[0]'s own column.
        full_header_row = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!A1:AD1")
        full_header_row = full_header_row[0] if full_header_row else []
        start_index = _header_index(full_header_row, target_headers[0])
        resolved_indices = [_header_index(full_header_row, h) for h in target_headers]
        misaligned = start_index is None or any(
            idx is not None and idx != start_index + i for i, idx in enumerate(resolved_indices)
        )
        if misaligned:
            _update_job(
                conn, job_id, status="failed",
                error_message=(
                    f"Sheet column layout has changed unexpectedly - could not find '"
                    f"{target_headers[0]}' or the target columns are no longer contiguous. "
                    "Refusing to append to avoid writing misaligned data."
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
        awb_col_letter = lib.get_column_letter(resolved_indices[target_headers.index("AWB Code")])
        awb_data = lib.get_sheet_values(SPREADSHEET_ID, f"'{SHEET_TAB}'!{awb_col_letter}2:{awb_col_letter}")
        live_awb_set = {(r[0] if r else "").strip().upper() for r in awb_data}
        live_awb_set.discard("")
        before_dedup = len(stamped_rows)
        stamped_rows = [r for r in stamped_rows if r["awbCode"] not in live_awb_set]
        skipped_as_dupe = before_dedup - len(stamped_rows)
        if skipped_as_dupe:
            print(f"process_job({job_id}): {skipped_as_dupe} row(s) already present in sheet "
                  "(live AWB re-check) - skipped to avoid a duplicate append")

        values_to_append = []
        for row in stamped_rows:
            cells = row["cells"]
            base_row = [cells.get(h, "") for h in target_headers]
            if row["stamp"]:
                # Columns Q (agent) through U line up right after P (Order Total, the last of
                # target_headers) - Q blank (never assigned), then the S/T/U stamp. R (Connected)
                # stays blank too, matching how assign_leads.py stamps its own already-
                # refunded/already-punched rows (see its own value_ranges construction).
                s, t, u = row["stamp"]
                base_row += ["", "", s, t, u]
            values_to_append.append(base_row)
        lib.append_sheet_rows(SPREADSHEET_ID, f"'{SHEET_TAB}'!B2:U", values_to_append)

        _update_job(
            conn, job_id, status="done", appended_count=len(values_to_append),
            rows_pending=None,
        )
    except Exception as e:
        print(f"process_job({job_id}) failed: {e}")
        # `conn` may be mid-aborted-transaction (a failed statement leaves Postgres refusing
        # all further commands until ROLLBACK) or simply dropped (plausible after the refund-
        # check phase holds it for up to 600s against a pooled Supabase connection) - roll back
        # first, and if the failure-status write still doesn't take, retry once on a fresh
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
                fresh_conn = lib.get_pg_connection(conn_str)
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
