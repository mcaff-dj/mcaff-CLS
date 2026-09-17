#!/usr/bin/env python3
"""Shape check for the heatmap's click-to-expand dip-reasons rows.

No MySQL access: runs on hand-built `capped`/`dip_feedback` fixtures.
`python scripts/test_prodwise_heatmap_dip.py`
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_panels import _build_prodwise_heatmap


def _row(product, nps_by_month, detractors_by_month=None, responses=100):
    detractors_by_month = detractors_by_month or {}
    months = {}
    for ym, nps_pct in nps_by_month.items():
        months[ym] = {
            "responses": responses,
            "nps_pct": nps_pct,
            "detractors": detractors_by_month.get(ym, 10),
            "promoters": 0, "passives": 0,
            "sum_overall": 0.0, "cnt_overall": 0, "sum_packaging": 0.0, "cnt_packaging": 0,
        }
    return {"product": product, "months": months}


def test_dipping_product_gets_chevron_and_hidden_detail_row():
    capped = [_row("Dipper", {"2026-04": 60.0, "2026-05": 50.0, "2026-06": 55.0})]
    html = _build_prodwise_heatmap(capped, {})
    assert "chevron" in html
    assert "dip-row" in html
    assert "hidden" in html
    assert "Dip months for <b>Dipper</b>" in html


def test_flat_product_gets_no_chevron_or_detail_row():
    capped = [_row("Steady", {"2026-04": 60.0, "2026-05": 62.0, "2026-06": 65.0})]
    html = _build_prodwise_heatmap(capped, {})
    assert "chevron" not in html
    assert "dip-row" not in html
    assert "dip-detail" not in html


def test_low_sample_guard_hides_reasons_under_five_detractors():
    capped = [_row("Sparse", {"2026-04": 60.0, "2026-05": 50.0}, detractors_by_month={"2026-05": 3})]
    dip_feedback = {"Sparse": {"2026-05": ["the packaging leaked everywhere"]}}
    html = _build_prodwise_heatmap(capped, dip_feedback)
    assert "Not enough feedback (n&lt;5)" in html
    assert "Packaging/Leakage" not in html


def test_reason_percentage_is_mentions_over_detractors():
    capped = [_row("Leaky", {"2026-04": 60.0, "2026-05": 50.0}, detractors_by_month={"2026-05": 10})]
    dip_feedback = {"Leaky": {"2026-05": [
        "the bottle leaked in my bag",
        "packaging was damaged on arrival",
        "smells lovely though",
    ]}}
    html = _build_prodwise_heatmap(capped, dip_feedback)
    assert "Packaging/Leakage &mdash; 20%" in html  # 2 of 10 detractors
    assert "<td class='num'>100</td>" in html  # real Responses count, not fabricated


def test_biggest_dip_sorts_first_when_product_has_multiple():
    capped = [_row("Rollercoaster", {"2026-04": 70.0, "2026-05": 65.0, "2026-06": 50.0})]
    html = _build_prodwise_heatmap(capped, {})
    detail = html.split("Dip months for")[1]
    assert detail.index("-15.0") < detail.index("-5.0")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all passed")
