import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from push_hyphen_to_dashboard import is_excluded_from_dashboard, parse_flowcall_date


def test_parse_flowcall_date():
    assert parse_flowcall_date("10/8/2026, 2:32:59 PM") == "08/10/2026"
    assert parse_flowcall_date("27-08-26 11:14:44") == "08/27/2026"  # FlowCall's format since 2026-08-25
    assert parse_flowcall_date("") == ""
    assert parse_flowcall_date("garbage") == "garbage"


def test_is_excluded_from_dashboard():
    assert is_excluded_from_dashboard("Cancelation request", "")
    assert is_excluded_from_dashboard("General", "")
    assert is_excluded_from_dashboard("Wrong Item Delivered", "Awaiting Response")
    assert not is_excluded_from_dashboard("Wrong Item Delivered", "Resolved")
    assert not is_excluded_from_dashboard("", "")
    assert is_excluded_from_dashboard("Enquiry about offers/coupons", "Product")
    assert is_excluded_from_dashboard("Refund enquiry", "Packaging and Operational")


if __name__ == "__main__":
    test_parse_flowcall_date()
    test_is_excluded_from_dashboard()
    print("all tests passed")
