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
        "Change in address", "x", "Calling Date", " Remark", "Key", "Facility Name",
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
    print("6 passed")
