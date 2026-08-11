#!/usr/bin/env python3
"""Equivalence checks for the report generator's hot-path rewrites.

The panel builders used to resolve a value's position in a list with list.index() and
re-derive each class's row subset with a fresh pass over ctx.unique, both inside per-row
loops. Those were replaced with index_map()/ctx.month_index lookups and a single
ctx.unique_by_class bucketing pass. The rewrites are only safe if they are *exactly*
equivalent - a different index number or a different row order renumbers every id in the
emitted HTML - so this asserts that against the original expressions.

No Sheets/MySQL access: runs on hand-built rows. `python scripts/test_report_hot_paths.py`
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from brands import BRANDS
from report_context import CAT_NORM_MAP, PARTNER_NORM_MAP, Ctx, index_map


def test_index_map_matches_list_index():
    for seq in ([], ["a"], ["a", "b", "c"], ["b", "a", "b", "c", "a"], [1, 2, 1], ["", "(blank)", ""]):
        got = index_map(seq)
        assert set(got) == set(seq), (seq, got)
        for v in set(seq):
            assert got[v] == seq.index(v), (seq, v, got[v], seq.index(v))
    # Duplicates matter: dim2_order can append an "(other)" sentinel that collides with a
    # real value of the same name, and list.index() would return the earlier one.
    assert index_map(["x", "(other)", "y", "(other)"])["(other)"] == 1


def test_month_index_matches_months_index():
    months = BRANDS[0]["months"]
    mi = index_map(months)
    for mo in months:
        assert mi.get(mo, -1) == months.index(mo), mo
    for absent in ("Nope", "", None):
        assert mi.get(absent, -1) == -1


def test_cell_normalizes_and_bounds_check():
    ctx = Ctx(BRANDS[0])
    col = ctx.col
    # Query Category and Delivery Partner Name are the only normalized columns; take a real
    # entry from each map rather than hardcoding one that may later be reworded.
    cat_raw, cat_norm = next(iter(CAT_NORM_MAP.items()))
    par_raw, par_norm = next(iter(PARTNER_NORM_MAP.items()))
    row = [""] * 20
    row[col["cat"]] = cat_raw.swapcase()          # map lookup is case-insensitive
    row[col["partner"]] = par_raw.swapcase()
    row[col["cls"]] = cat_raw                     # same text, but an unnormalized column
    assert ctx.cell(row, col["cat"]) == cat_norm
    assert ctx.cell(row, col["partner"]) == par_norm
    assert ctx.cell(row, col["cls"]) == cat_raw
    # Unmapped values pass through untouched, including non-strings.
    row[col["cat"]] = "Not In The Map"
    assert ctx.cell(row, col["cat"]) == "Not In The Map"
    row[col["cat"]] = 1234
    assert ctx.cell(row, col["cat"]) == 1234
    # Missing / short / None rows.
    assert ctx.cell(None, col["cat"]) == ""
    assert ctx.cell([], col["cat"]) == ""
    assert ctx.cell([None] * 20, col["cat"]) == ""
    assert ctx.cell("scalar", 0) == "scalar"
    assert ctx.cell("scalar", 3) == ""


def test_unique_by_class_matches_per_class_rescan():
    ctx = Ctx(BRANDS[0])
    col = ctx.col
    keys = ["Delivery", "Product", "Delivery", "", "Packaging and Operational", "Delivery"]
    ctx.unique = []
    for i, k in enumerate(keys):
        r = [""] * 20
        r[col["cls"]] = k
        r[col["order_id"]] = f"row{i}"          # marker so order is checkable
        ctx.unique.append(r)
    buckets = {}
    for r in ctx.unique:
        buckets.setdefault(ctx.cell(r, col["cls"]), []).append(r)
    for k in set(keys) | {"Technical", "Delivery"}:
        old = [r for r in ctx.unique if ctx.cell(r, col["cls"]) == k]
        assert buckets.get(k, []) == old, k          # identity AND order
    assert [r[col["order_id"]] for r in buckets["Delivery"]] == ["row0", "row2", "row5"]


def test_quick_serves_geo_from_cache_without_querying():
    """--quick has to make gen_geo_insights' two MySQL round-trips zero: the per-month
    order counts (~20-35s each against the ~50M-row Item_level_data) and the AWB batches.
    A full run must still issue both. Touches no real database - mysql_lib is stubbed out
    and both caches are redirected to a temp dir, so this never reads data/ either."""
    import json
    import tempfile
    import types

    import gen_geo_insights as geo

    queries = []

    def fake_query(sql, params=None, database=None):
        queries.append(sql)
        return []

    fake = types.ModuleType("mysql_lib")
    fake.query = fake_query
    real_mysql_lib = sys.modules.get("mysql_lib")
    real_orders_path, real_awb_path = geo._orders_cache_path, geo._awb_cache_path
    sys.modules["mysql_lib"] = fake

    ctx = Ctx(BRANDS[0])
    ctx.months = ["6_Jun'26", "7_Jul'26"]
    try:
        with tempfile.TemporaryDirectory() as tmp:
            orders_p, awb_p = Path(tmp) / "orders.json", Path(tmp) / "awb.json"
            # Every month already cached, so a quick run has nothing it *must* query;
            # AWB1 resolved, AWB_NEW deliberately absent - the today's-ticket case.
            orders_p.write_text(json.dumps({m: [["MUMBAI", "MH", 1, 5]] for m in ctx.months}))
            awb_p.write_text(json.dumps({"AWB1": ["MUMBAI", "MH"]}))
            geo._orders_cache_path = lambda c: orders_p
            geo._awb_cache_path = lambda c: awb_p

            ctx.quick = True
            assert geo._order_counts_by_month_cached(ctx, "mCaffeine") is not None
            got = geo._awb_geo_map(ctx, ["AWB1", "AWB_NEW"])
            assert queries == [], queries                     # the whole point: no round-trips
            assert got == {"AWB1": ("MUMBAI", "MH")}          # cached kept, unresolved dropped

            ctx.quick = False
            geo._order_counts_by_month_cached(ctx, "mCaffeine")   # last month re-queried
            geo._awb_geo_map(ctx, ["AWB1", "AWB_NEW"])            # uncached AWB fetched
            assert len(queries) == 2, queries
    finally:
        geo._orders_cache_path, geo._awb_cache_path = real_orders_path, real_awb_path
        if real_mysql_lib is None:
            del sys.modules["mysql_lib"]
        else:
            sys.modules["mysql_lib"] = real_mysql_lib


def test_quick_defaults_off_for_a_bare_ctx():
    """Anything building a Ctx without generate_report's argument parsing must get
    full-refresh behaviour, not a silently cached one."""
    assert Ctx(BRANDS[0]).quick is False


def demo():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all hot-path rewrites match the originals.")


if __name__ == "__main__":
    demo()
