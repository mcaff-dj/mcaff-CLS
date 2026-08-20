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


if __name__ == "__main__":
    test_partition_and_stamp_marks_punched_rows()
    print("  ok  test_partition_and_stamp_marks_punched_rows")
    test_partition_and_stamp_marks_refunded_rows_prepaid_only()
    print("  ok  test_partition_and_stamp_marks_refunded_rows_prepaid_only")
    test_partition_and_stamp_punched_wins_over_refunded()
    print("  ok  test_partition_and_stamp_punched_wins_over_refunded")
    print("3 passed")
