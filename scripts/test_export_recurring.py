import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_recurring import build_dispatch_delay_duplicate, fetch_export_csv

IDX_DISPATCH, IDX_QCLASS, IDX_TICKET, IDX_SUBCAT = 0, 1, 2, 3


def test_triggers_for_delivery_over_24h():
    row = ["25.5", "Delivery", "T123", "Old Subcat"]
    dup = build_dispatch_delay_duplicate(row, IDX_DISPATCH, IDX_QCLASS, IDX_TICKET, IDX_SUBCAT)
    assert dup is not None
    assert dup[IDX_QCLASS] == "Warehouse"
    assert dup[IDX_SUBCAT] == "Late/Delay Dispatch"
    assert dup[IDX_TICKET].startswith("T123-WH")
    assert dup[IDX_TICKET] != row[IDX_TICKET]
    assert row == ["25.5", "Delivery", "T123", "Old Subcat"]  # original untouched


def test_triggers_for_requests_and_enquiries_over_24h():
    row = ["48.0", "Requests & Enquiries", "T999", "X"]
    dup = build_dispatch_delay_duplicate(row, IDX_DISPATCH, IDX_QCLASS, IDX_TICKET, IDX_SUBCAT)
    assert dup is not None
    assert dup[IDX_QCLASS] == "Warehouse"


def test_no_trigger_at_or_under_24h():
    row = ["24.0", "Delivery", "T1", "X"]
    assert build_dispatch_delay_duplicate(row, IDX_DISPATCH, IDX_QCLASS, IDX_TICKET, IDX_SUBCAT) is None


def test_no_trigger_for_other_query_class():
    row = ["48.0", "Technical", "T1", "X"]
    assert build_dispatch_delay_duplicate(row, IDX_DISPATCH, IDX_QCLASS, IDX_TICKET, IDX_SUBCAT) is None


def test_no_trigger_on_blank_or_missing_dispatch_value():
    row = ["", "Delivery", "T1", "X"]
    assert build_dispatch_delay_duplicate(row, IDX_DISPATCH, IDX_QCLASS, IDX_TICKET, IDX_SUBCAT) is None
    assert build_dispatch_delay_duplicate(row, -1, IDX_QCLASS, IDX_TICKET, IDX_SUBCAT) is None


def test_fetch_export_csv_polls_async_job_instead_of_treating_envelope_as_csv():
    queued_resp = MagicMock(status_code=202)
    queued_resp.json.return_value = {
        "jobId": "job-1",
        "statusUrl": "/apis/task-runs/tickets/export/job-1",
    }
    running_resp = MagicMock(status_code=200)
    running_resp.json.return_value = {"job": {"status": "running"}}
    done_resp = MagicMock(status_code=200)
    done_resp.json.return_value = {
        "job": {"status": "succeeded"},
        "downloadUrl": "https://storage.example.com/tickets.csv",
    }
    csv_resp = MagicMock(status_code=200, text="Ticket Number\nT1\n")

    with patch("export_recurring.requests.post", return_value=queued_resp), \
         patch("export_recurring.requests.get", side_effect=[running_resp, done_resp, csv_resp]), \
         patch("export_recurring.time.sleep"):
        result = fetch_export_csv("token", "mcaffeine", "start", "end")

    assert result == "Ticket Number\nT1\n"


if __name__ == "__main__":
    test_triggers_for_delivery_over_24h()
    test_triggers_for_requests_and_enquiries_over_24h()
    test_no_trigger_at_or_under_24h()
    test_no_trigger_for_other_query_class()
    test_no_trigger_on_blank_or_missing_dispatch_value()
    test_fetch_export_csv_polls_async_job_instead_of_treating_envelope_as_csv()
    print("all tests passed")
