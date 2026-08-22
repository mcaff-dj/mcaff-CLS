"""Self-check for build_class_period_narrative's per-category qualifying logic
(scripts/gen_monthly.py). Run directly: python scripts/test_gen_monthly_qualifies.py

Covers the bug this fix addresses: a category whose ticket count fell but whose
rate-of-sales rose (partial-month sales denominator shrinking faster than the
category's ticket count) was silently dropped from the narrative because
qualification only looked at raw count growth/delta, never the rate the bullet
itself displays.
"""
from gen_monthly import build_class_period_narrative

CLS = {"id": "test", "label": "Delivery"}


def make_data(cat, prev_c, cur_c):
    return {
        "class_period_tot": [prev_c, cur_c],
        "cat_order": [cat],
        "cat_period": {cat: [prev_c, cur_c]},
        "sub_dims": [],
        "sub_period": {},
    }


def make_period(sales_prev, sales_cur):
    return {
        "label_fn": lambda i: "cur" if i == 1 else "prev",
        "sales": [sales_prev, sales_cur],
    }


# Case 1a: count fell (1000 -> 900) but sales fell harder, so rate rose 0.5% -> 0.65%
# (1.3x, a partial-month-style denominator squeeze). growth/abs_delta alone (the old
# test) would drop this; rate_growth now catches it.
data = make_data("Rate Rise Category", 1000, 900)
period = make_period(sales_prev=200_000, sales_cur=138_462)
html = build_class_period_narrative(None, CLS, data, period, 1)
assert "Rate Rise Category" in html, "rate_growth >= 1.3x despite a count drop should qualify"

# Case 1b: count fell slightly (500 -> 480), rate only crept 5.0% -> 5.15% (1.03x, under
# the 1.3x rate_growth bar) but that's still +0.15 percentage point of sales - pp_delta
# is what catches this one.
data = make_data("Slow Creep Category", 500, 480)
period = make_period(sales_prev=10_000, sales_cur=9_320)
html = build_class_period_narrative(None, CLS, data, period, 1)
assert "Slow Creep Category" in html, "pp_delta >= 0.1 despite rate_growth < 1.3 should qualify"

# Case 2: both count and rate flat -> no bullet, and the whole section collapses to "".
data = make_data("Steady Category", 100, 101)
period = make_period(sales_prev=1_000_000, sales_cur=1_000_000)
html = build_class_period_narrative(None, CLS, data, period, 1)
assert html == "", "flat count and flat rate must not qualify"

# Case 3: existing count-growth path (unaffected by the new OR clause) still works.
data = make_data("Delayed Order-Product", 295, 459)
period = make_period(sales_prev=1_000_000, sales_cur=1_000_000)
html = build_class_period_narrative(None, CLS, data, period, 1)
assert "Delayed Order-Product" in html, "existing raw-count-growth qualification must still fire"

print("OK: build_class_period_narrative qualifying logic")
