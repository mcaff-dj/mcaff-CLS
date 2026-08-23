import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_recurring import build_dispatch_delay_duplicate, resolve_query_class

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


def test_resolve_query_class_single_valued_subcategory_always_forced():
    assert resolve_query_class("Broken Bottle", "") == "Packaging and Operational"
    assert resolve_query_class("Broken Bottle", "Technical") == "Packaging and Operational"


def test_resolve_query_class_ambiguous_subcategory_keeps_valid_existing():
    assert resolve_query_class("Others", "Product") == "Product"
    assert resolve_query_class("Product enquiry( price, how to, ingredients,effects)", "Technical") == "Technical"


def test_resolve_query_class_ambiguous_subcategory_leaves_invalid_or_blank_untouched():
    assert resolve_query_class("Others", "") == ""
    assert resolve_query_class("Others", "Delivery") == "Delivery"  # "Others" itself isn't a Delivery-mapped row


def test_resolve_query_class_unknown_subcategory_untouched():
    assert resolve_query_class("Some New Subcategory", "Whatever") == "Whatever"


def test_resolve_query_class_case_sensitive_others_variants():
    assert resolve_query_class("others", "Technical") == "Delivery"  # lowercase "others" is single-valued


if __name__ == "__main__":
    test_triggers_for_delivery_over_24h()
    test_triggers_for_requests_and_enquiries_over_24h()
    test_no_trigger_at_or_under_24h()
    test_no_trigger_for_other_query_class()
    test_no_trigger_on_blank_or_missing_dispatch_value()
    test_resolve_query_class_single_valued_subcategory_always_forced()
    test_resolve_query_class_ambiguous_subcategory_keeps_valid_existing()
    test_resolve_query_class_ambiguous_subcategory_leaves_invalid_or_blank_untouched()
    test_resolve_query_class_unknown_subcategory_untouched()
    test_resolve_query_class_case_sensitive_others_variants()
    print("all tests passed")
