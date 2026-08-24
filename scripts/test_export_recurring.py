import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_recurring import build_dispatch_delay_duplicate

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


if __name__ == "__main__":
    test_triggers_for_delivery_over_24h()
    test_triggers_for_requests_and_enquiries_over_24h()
    test_no_trigger_at_or_under_24h()
    test_no_trigger_for_other_query_class()
    test_no_trigger_on_blank_or_missing_dispatch_value()
    print("all tests passed")
