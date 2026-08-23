"""Self-check for process_order_punch_job.py's pure functions - no network, no Postgres. Same
plain-assert, run-directly style as test_process_rto_csv_upload_job.py.
Run: python scripts/test_process_order_punch_job.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_order_punch_job as worker

MCAFFEINE_CHANNELS = ["SHOPIFY", "FIEN_SHOPIFY", "HYPD", "COMPENSATION", "MCaf_Shopify.in", "MCAFF_TEST"]
HYPHEN_CHANNELS = ["HYP_SHOPIFY", "HYPD_HYPHEN", "HYP_COMPENSATION", "HYP_SHOPIFY_IN"]
TARGET_MCAFFEINE = "MCAFFEINE_D2C"
TARGET_HYPHEN = "HYPHEN_D2C"


def test_resolve_target_channel_known_channels():
    for ch in MCAFFEINE_CHANNELS:
        assert worker.resolve_target_channel(ch, MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_MCAFFEINE
    for ch in HYPHEN_CHANNELS:
        assert worker.resolve_target_channel(ch, MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_HYPHEN


def test_resolve_target_channel_hyp_prefix_fallback():
    # Unknown channel starting with "HYP" defaults to Hyphen, everything else to mCaffeine -
    # matches the script's ch.indexOf("HYP") === 0 fallback exactly.
    assert worker.resolve_target_channel("HYP_SOMETHING_NEW", MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_HYPHEN
    assert worker.resolve_target_channel("SOME_OTHER_CHANNEL", MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_MCAFFEINE
    assert worker.resolve_target_channel("", MCAFFEINE_CHANNELS, HYPHEN_CHANNELS, TARGET_MCAFFEINE, TARGET_HYPHEN) == TARGET_MCAFFEINE


def test_pick_so_code_bare_code_when_different_channel_and_free():
    assert worker.pick_so_code("HYP1001", False, {}, 2) == "HYP1001"


def test_pick_so_code_suffix_when_same_channel():
    assert worker.pick_so_code("HYP1001", True, {}, 2) == "HYP1001_1"


def test_pick_so_code_skips_taken_suffixes():
    assert worker.pick_so_code("HYP1001", True, {"HYP1001_1": True}, 2) == "HYP1001_2"


def test_pick_so_code_returns_none_when_exhausted():
    assert worker.pick_so_code("HYP1001", True, {"HYP1001_1": True, "HYP1001_2": True}, 2) is None


def test_build_create_payload_field_mapping():
    order = {
        "addresses": [{"id": 1, "name": "A", "city": "Pune", "country": "IN", "pincode": 411001, "phone": "999", "email": "a@x.com"}],
        "billingAddress": {"id": 1},
        "saleOrderItems": [{"itemSku": "SKU1", "sellingPrice": 100, "totalPrice": 100}],
        "channel": "SHOPIFY",
        "cod": False,
        "currencyCode": "INR",
        "customerCode": "CUST1",
    }
    payload = worker.build_create_payload(order, "HYP1001", "HYP1001", "MCAFFEINE_D2C", "HYP_SRKOL", "wrong address", "agent@mcaffeine.com")
    item = payload["saleOrder"]["saleOrderItems"][0]
    assert item["giftMessage"] == "wrong address", "reason must map to giftMessage"
    assert item["voucherCode"] == "agent@mcaffeine.com", "triggering agent's email must map to voucherCode"
    assert item["facilityCode"] == "HYP_SRKOL"
    assert payload["saleOrder"]["code"] == "HYP1001"
    assert payload["saleOrder"]["displayOrderCode"] == "HYP1001"
    assert payload["saleOrder"]["channel"] == "MCAFFEINE_D2C"


def test_extract_status_known_field_names():
    assert worker.extract_status({"status": "delivered"}) == "DELIVERED"
    assert worker.extract_status({"orderStatus": "Shipped"}) == "SHIPPED"


def test_extract_status_auto_scan_fallback():
    # No known field name, but a key containing "status" (and not "updat") exists.
    assert worker.extract_status({"weirdStatusField": "cancelled"}) == "CANCELLED"


def test_extract_status_excludes_updat_keys():
    # "lastUpdatedStatus" contains "status" but ALSO "updat" - excluded, same as the script's
    # own kl.indexOf("updat") < 0 guard. No other key matches, so this must be None, not a match.
    assert worker.extract_status({"lastUpdatedStatus": "x"}) is None


def test_extract_status_none_when_absent():
    assert worker.extract_status({"foo": "bar"}) is None


def test_parse_timestamp_epoch_ms():
    assert worker.parse_timestamp(1700000000000) == 1700000000000


def test_parse_timestamp_epoch_seconds():
    assert worker.parse_timestamp(1700000000) == 1700000000000


def test_parse_timestamp_iso_string():
    ms = worker.parse_timestamp("2023-11-14T22:13:20+00:00")
    assert ms == 1700000000000


def test_parse_timestamp_invalid_returns_none():
    assert worker.parse_timestamp("not a date") is None
    assert worker.parse_timestamp(None) is None


def test_should_retry_after_crash_caps_at_max():
    # Below the cap: keep retrying. At/above: stop, so a deterministic crash (bad creds, DB
    # unreachable) can't loop invoke_self forever - see MAX_CRASH_RETRIES's comment.
    for n in range(worker.MAX_CRASH_RETRIES):
        assert worker.should_retry_after_crash(n) is True
    assert worker.should_retry_after_crash(worker.MAX_CRASH_RETRIES) is False
    assert worker.should_retry_after_crash(worker.MAX_CRASH_RETRIES + 5) is False


if __name__ == "__main__":
    tests = [
        test_resolve_target_channel_known_channels,
        test_resolve_target_channel_hyp_prefix_fallback,
        test_pick_so_code_bare_code_when_different_channel_and_free,
        test_pick_so_code_suffix_when_same_channel,
        test_pick_so_code_skips_taken_suffixes,
        test_pick_so_code_returns_none_when_exhausted,
        test_build_create_payload_field_mapping,
        test_extract_status_known_field_names,
        test_extract_status_auto_scan_fallback,
        test_extract_status_excludes_updat_keys,
        test_extract_status_none_when_absent,
        test_parse_timestamp_epoch_ms,
        test_parse_timestamp_epoch_seconds,
        test_parse_timestamp_iso_string,
        test_parse_timestamp_invalid_returns_none,
        test_should_retry_after_crash_caps_at_max,
    ]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
