"""Self-check for build_attribute_map (scripts/backfill_ndr_lead_attributes_from_sheet.py) -
pure, no sheet, no DB. Run with `pytest scripts/test_backfill_ndr_lead_attributes_from_sheet.py -v`."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backfill_ndr_lead_attributes_from_sheet import build_attribute_map


def _row(order_id="MC1", awb="AWB1", courier="", payment_mode="", reason=""):
    r = [""] * 17
    r[0] = order_id
    r[4] = awb
    r[5] = courier
    r[11] = payment_mode
    r[16] = reason
    return r


def test_build_attribute_map_captures_all_four_fields():
    rows = [_row(order_id="HYP900", awb="A1", courier="Delhivery", payment_mode="COD", reason="Customer refused")]
    result = build_attribute_map(rows)
    assert result == {"A1": ("Delhivery", "Customer refused", "COD", "Hyphen")}


def test_build_attribute_map_skips_rows_with_no_awb():
    rows = [_row(awb=""), _row(awb="  "), _row(awb="A1")]
    result = build_attribute_map(rows)
    assert list(result.keys()) == ["A1"]


def test_build_attribute_map_first_seen_wins_for_a_repeated_awb():
    rows = [_row(awb="A1", courier="Delhivery"), _row(awb="A1", courier="Bluedart")]
    result = build_attribute_map(rows)
    assert result["A1"][0] == "Delhivery"


def test_build_attribute_map_blank_cells_become_none():
    rows = [_row(awb="A1", courier="", payment_mode="", reason="")]
    result = build_attribute_map(rows)
    courier, reason, payment_mode, brand = result["A1"]
    assert (courier, reason, payment_mode) == (None, None, None)
    assert brand == "mCaffeine"  # order_id "MC1" -> brand_of still runs, just doesn't start with HYP
