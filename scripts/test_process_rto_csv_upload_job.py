"""Self-check for process_rto_csv_upload_job.py's pure row-partitioning logic - deciding
which rows get stamped Already Refunded / Already Punched vs written plain, given the results
of the (mocked-out-in-this-test) punch/refund checks. No MySQL, no Postgres, no GoKwik, no
Sheets - those are exercised only by manual verification against the real environment, same
acknowledged limitation as every other endpoint built this same week (no live server available
in this environment). Run: python scripts/test_process_rto_csv_upload_job.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_rto_csv_upload_job as worker


def test_partition_and_stamp_marks_punched_rows():
    rows = [
        {"orderId": "HYP1", "awbCode": "AWB1", "paymentMethod": "COD", "rtoReason": "X", "cells": {"AWB Code": "AWB1"}},
        {"orderId": "HYP2", "awbCode": "AWB2", "paymentMethod": "Prepaid", "rtoReason": "Y", "cells": {"AWB Code": "AWB2"}},
    ]
    result = worker.partition_and_stamp(rows, punched_ids={"HYP1"}, refund_results={"HYP2": False})
    assert result[0]["stamp"] == worker.PUNCHED_STAMP
    assert result[1]["stamp"] is None, "not refunded, not punched - plain unassigned row"


def test_partition_and_stamp_marks_refunded_rows_prepaid_only():
    rows = [
        {"orderId": "HYP3", "awbCode": "AWB3", "paymentMethod": "Prepaid", "rtoReason": "X", "cells": {}},
        {"orderId": "HYP4", "awbCode": "AWB4", "paymentMethod": "COD", "rtoReason": "Y", "cells": {}},
    ]
    # refund_results only ever contains prepaid order ids in real use (see process_job below),
    # but this test proves the function itself does not need to re-derive is_prepaid - it
    # trusts refund_results' keys, matching how resolve_refund_statuses is actually called.
    result = worker.partition_and_stamp(rows, punched_ids=set(), refund_results={"HYP3": True})
    assert result[0]["stamp"] == worker.REFUNDED_STAMP
    assert result[1]["stamp"] is None, "COD row was never in refund_results - plain unassigned"


def test_partition_and_stamp_punched_wins_over_refunded():
    # Mirrors scripts/assign_leads.py's own main(): punch-check runs first, and a punched row
    # is excluded from the refund-check entirely - so in practice a row can never be BOTH, but
    # if it somehow were, punched must win since that's what the row would have been excluded
    # from refund-checking for in the first place.
    rows = [{"orderId": "HYP5", "awbCode": "AWB5", "paymentMethod": "Prepaid", "rtoReason": "", "cells": {}}]
    result = worker.partition_and_stamp(rows, punched_ids={"HYP5"}, refund_results={"HYP5": True})
    assert result[0]["stamp"] == worker.PUNCHED_STAMP


def test_column_letter_to_index_matches_js_mirror():
    assert worker._column_letter_to_index("A") == 0
    assert worker._column_letter_to_index("G") == 6
    assert worker._column_letter_to_index("P") == 15
    assert worker._column_letter_to_index("AB") == 27
    assert worker._column_letter_to_index("AC") == 28


def test_check_sheet_layout_clean_on_production_header_row():
    full_header_row = [
        " CXB CV", "RTO Initiated Date", "Latest NDR Date", "RTO Reason", "Order ID", "Unique",
        "AWB Code", "Customer Email", "Customer Name", "Customer Mobile", "Address",
        "Address City", "Address State", "Address Pincode", "  Payment Method", "Order Total",
        "Agent Name", "Connected", "Attempt", "", "New product needed", "New  order ID",
        # No "Key" at AA any more - deleted from the live sheet on 2026-08-28, which pulled
        # Facility Name to AA and Courier Company to AB.
        "Change in address", "x", "Calling Date", " Remark", "Facility Name",
        "Courier Company",
    ]
    assert worker._check_sheet_layout(full_header_row) == []


def test_check_sheet_layout_reports_drifted_column():
    full_header_row = [
        " CXB CV", "RTO Initiated Date", "Latest NDR Date", "RTO Reason", "Order ID", "Unique",
        "Some New Column",  # column G, was 'AWB Code'
    ]
    issues = worker._check_sheet_layout(full_header_row)
    assert any("Column G" in issue for issue in issues)


def test_parse_appended_row_range():
    r"""Regression guard for the 'Data'!G0:G9 bug: the original r"!\w+(\d+):\w+(\d+)$" captured
    only the trailing digit of each row number, so an append at rows 7630-7639 asked Sheets to
    read G0:G9 and got a 400 back - which used to abort the whole upload mid-flight."""
    assert worker.parse_appended_row_range("Data!A7630:AD7639") == ("7630", "7639")
    assert worker.parse_appended_row_range("'Data'!A2:AC11") == ("2", "11")
    assert worker.parse_appended_row_range("Data!A7:AC7") == ("7", "7")
    assert worker.parse_appended_row_range("Data!A:AC") is None
    assert worker.parse_appended_row_range("") is None
    assert worker.parse_appended_row_range(None) is None


def test_append_anchor_range_stays_single_column():
    """The 2026-08-28 corruption in one assertion. values:append writes starting at the first
    column of whatever table it detects inside the range it is handed - so a range spanning more
    than one column of data can, and did, make it start at AB instead of A and shift every field
    27 columns right. Widening this back reintroduces that silently (the sheet still accepts the
    write; only the post-append canary notices, after the bad rows are already in), so it is
    pinned here rather than left to a comment."""
    anchor = worker.APPEND_ANCHOR_RANGE
    start, _, end = anchor.partition(":")
    assert anchor.count(":") == 1, f"expected a start:end range, got {anchor!r}"
    start_col = "".join(c for c in start if c.isalpha())
    end_col = "".join(c for c in end if c.isalpha())
    assert start_col == end_col, (
        f"append anchor must span ONE column or Sheets can detect the wrong table and shift "
        f"every written value sideways - got {anchor!r} ({start_col}..{end_col})"
    )
    # Column A specifically: it is the only column this worker guarantees is non-empty on every
    # row it writes (rtoCsvImport's blankPlaceholder = 'NA'), so its block always reaches the
    # true bottom of our data. An anchor on a column that can be blank would find a short table
    # and append into the middle of existing rows.
    assert start_col == "A", f"anchor must be column A, got {start_col}"
    assert worker._column_letter_to_index(start_col) == 0


if __name__ == "__main__":
    test_partition_and_stamp_marks_punched_rows()
    print("  ok  test_partition_and_stamp_marks_punched_rows")
    test_partition_and_stamp_marks_refunded_rows_prepaid_only()
    print("  ok  test_partition_and_stamp_marks_refunded_rows_prepaid_only")
    test_partition_and_stamp_punched_wins_over_refunded()
    print("  ok  test_partition_and_stamp_punched_wins_over_refunded")
    test_column_letter_to_index_matches_js_mirror()
    print("  ok  test_column_letter_to_index_matches_js_mirror")
    test_check_sheet_layout_clean_on_production_header_row()
    print("  ok  test_check_sheet_layout_clean_on_production_header_row")
    test_check_sheet_layout_reports_drifted_column()
    print("  ok  test_check_sheet_layout_reports_drifted_column")
    test_parse_appended_row_range()
    print("  ok  test_parse_appended_row_range")
    test_append_anchor_range_stays_single_column()
    print("  ok  test_append_anchor_range_stays_single_column")
    print("8 passed")
