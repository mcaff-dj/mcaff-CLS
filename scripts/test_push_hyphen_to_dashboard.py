import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from push_hyphen_to_dashboard import is_excluded_from_dashboard


def test_is_excluded_from_dashboard():
    assert is_excluded_from_dashboard("Cancelation request", "")
    assert is_excluded_from_dashboard("General", "")
    assert is_excluded_from_dashboard("Wrong Item Delivered", "Awaiting Response")
    assert not is_excluded_from_dashboard("Wrong Item Delivered", "Resolved")
    assert not is_excluded_from_dashboard("", "")
    assert not is_excluded_from_dashboard("Refund enquiry", "Packaging and Operational")
    assert not is_excluded_from_dashboard("Enquiry about offers/coupons", "Product")


if __name__ == "__main__":
    test_is_excluded_from_dashboard()
    print("all tests passed")
