#!/usr/bin/env python3
"""Shape check for the Product/Packaging drill-down table's markup.

The five frozen label columns (SKU / Product Name / Query Class / Query Category / Batch
Number) were collapsed into a single indented column, so every row now emits exactly one
`td.rowlabel` and the row count per `<tr>` is 1 + 2*periods. Getting that wrong shifts every
numeric cell under the wrong month header without any Python error, so it is asserted here.

No Sheets/MySQL access: runs on hand-built rows. `python scripts/test_ppk_table_shape.py`
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from brands import BRANDS
from gen_panels import _build_ppk_core
from report_context import Ctx

PERIODS = ["01_Jan'25", "02_Feb'25", "03_Mar'25"]


def _core():
    ctx = Ctx(BRANDS[0])
    col = ctx.col
    width = max(col.values()) + 1

    def row(sku, prod, cls, cat, batch, month, prosales):
        r = [""] * width
        r[col["sku"]], r[col["prod"]], r[col["cls"]] = sku, prod, cls
        r[col["cat"]], r[col["batch"]] = cat, batch
        r[col["month"]], r[col["prosales"]] = month, prosales
        return r

    subset = [
        row("SKU-A", "Face Wash", "Product", "Leakage", "B1", PERIODS[0], "1000"),
        row("SKU-A", "Face Wash", "Product", "Leakage", "B1", PERIODS[2], "1000"),
        row("SKU-A", "Face Wash", "Packaging and Operational", "Seal broken", "B2", PERIODS[2], "1000"),
        row("SKU-B", "Serum", "Product", "Leakage", "B3", PERIODS[1], "500"),
    ]
    pidx = {m: i for i, m in enumerate(PERIODS)}
    core = _build_ppk_core(ctx, subset, PERIODS, lambda r: pidx.get(ctx.cell(r, col["month"]), -1),
                           lambda p: p, "ppktest", "Month")
    assert core is not None
    return core


def test_one_label_column_and_correct_cell_count():
    html = _core()["table_html"]
    head, body = html.split("<tbody>", 1)
    # Two header rows, one corner cell each (the second is the empty spacer above the
    # complain/complain% sub-headers).
    assert head.count("class='corner'") == 2, head.count("class='corner'")
    assert head.count("class='month-hdr'") == len(PERIODS)
    assert head.count("class='sub-hdr'") == 2 * len(PERIODS)

    rows = [r for r in body.split("<tr ")[1:]]
    assert rows, "no body rows emitted"
    for r in rows:
        assert r.count("class='rowlabel") == 1, r[:160]
        assert r.count("<td ") == 1 + 2 * len(PERIODS), (r.count("<td "), r[:160])


def test_every_level_present_and_indented():
    body = _core()["table_html"].split("<tbody>", 1)[1]
    for lvl in range(1, 6):
        assert f"ppk-lvl{lvl}" in body, lvl
        assert f"ppk-ind{lvl}" in body, lvl
    # Levels 1-4 are expandable (collapsed chevron + a row-level toggle); the batch leaf
    # is not, and must carry neither.
    assert body.count("ppk-drill") == body.count("ppkToggle(")
    leaf = re.search(r"<tr class='ppk-lvl5[^>]*>", body).group(0)
    assert "ppk-drill" not in leaf and "ppkToggle(" not in leaf, leaf


def test_toggle_swaps_chevron_not_plus_minus():
    js = _core()["js"]
    assert "&#9662;" in js and "&#9656;" in js, "expand/collapse chevrons missing from toggle"
    assert "'+'" not in js, "old +/- toggle glyph still emitted"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all passed")
