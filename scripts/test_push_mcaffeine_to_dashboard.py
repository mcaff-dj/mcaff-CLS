import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from push_mcaffeine_to_dashboard import (
    extract_mcaffeine_order_code,
    is_excluded_from_dashboard,
    parse_created_at,
    pick_awb_before_ticket_date,
)


def test_extract_order_code():
    assert extract_mcaffeine_order_code("MCaff9119979") == "9119979"
    assert extract_mcaffeine_order_code("mcaff123") == "123"
    assert extract_mcaffeine_order_code("Fien2701940") is None
    assert extract_mcaffeine_order_code("ECOMMERCE") is None
    assert extract_mcaffeine_order_code("") is None


def test_parse_created_at():
    assert parse_created_at("10/8/2026, 2:32:59 PM") == datetime(2026, 8, 10, 14, 32, 59)
    assert parse_created_at("9/8/2026, 12:05:00 AM") == datetime(2026, 8, 9, 0, 5, 0)
    assert parse_created_at("9/8/2026, 12:05:00 PM") == datetime(2026, 8, 9, 12, 5, 0)
    assert parse_created_at("garbage") is None
    assert parse_created_at("") is None


def test_pick_awb_before_ticket_date_picks_latest_prior():
    candidates = [
        (datetime(2026, 8, 1), "AWB_EARLY"),
        (datetime(2026, 8, 5), "AWB_JUST_BEFORE"),
        (datetime(2026, 8, 10), "AWB_AFTER_TICKET"),
    ]
    ticket_dt = datetime(2026, 8, 6)
    assert pick_awb_before_ticket_date(candidates, ticket_dt) == "AWB_JUST_BEFORE"


def test_pick_awb_before_ticket_date_none_qualify():
    candidates = [(datetime(2026, 8, 10), "AWB_AFTER_TICKET")]
    ticket_dt = datetime(2026, 8, 6)
    assert pick_awb_before_ticket_date(candidates, ticket_dt) is None


def test_pick_awb_before_ticket_date_exact_match_qualifies():
    ticket_dt = datetime(2026, 8, 6, 12, 0, 0)
    candidates = [(ticket_dt, "AWB_SAME_INSTANT")]
    assert pick_awb_before_ticket_date(candidates, ticket_dt) == "AWB_SAME_INSTANT"


def test_is_excluded_from_dashboard():
    assert is_excluded_from_dashboard("Cancelation request", "")
    assert is_excluded_from_dashboard("General", "")
    assert is_excluded_from_dashboard("Wrong Item Delivered", "Awaiting Response")
    assert not is_excluded_from_dashboard("Wrong Item Delivered", "Resolved")
    assert not is_excluded_from_dashboard("", "")
    assert is_excluded_from_dashboard("Enquiry about offers/coupons", "Product")
    assert is_excluded_from_dashboard("Refund enquiry", "Packaging and Operational")


if __name__ == "__main__":
    test_extract_order_code()
    test_parse_created_at()
    test_pick_awb_before_ticket_date_picks_latest_prior()
    test_pick_awb_before_ticket_date_none_qualify()
    test_pick_awb_before_ticket_date_exact_match_qualifies()
    test_is_excluded_from_dashboard()
    print("all tests passed")
