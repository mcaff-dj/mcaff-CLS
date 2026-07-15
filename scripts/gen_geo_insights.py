"""Delivery-complaint city-level "spike" insight.

Joins the sheet's AWB (raw column 9, "Tracking Number" - never named/read anywhere else
in the pipeline) against the mcaff_prod MySQL DWH's Item_level_data table to resolve each
Delivery ticket's shipping city, then finds the city whose (complaints / that city's
orders) rate rose the most from last month to this month - a real spike, not just a city
that has more complaints because it also has more orders.

Requires MYSQL_* credentials (see mysql_lib.py) to reach the DWH. If they're not
configured (e.g. CI doesn't have the secrets yet) this whole feature quietly returns None
rather than breaking report generation - confirmed acceptable with the user, since the
existing report has no dependency on MySQL today.

The two aggregate queries against Item_level_data (~50M rows) take ~15-20s apiece even
with its Order_Date/Brand indexes, so the result is memoized on ctx - both call sites
(the Delivery tab's Insights card and the Monthly Analysis narrative) share one computation.
"""
import re

import mysql_lib
from gen_insights import insight_item
from report_context import fnum, h_enc, n0, pretty_month, round1

_MYSQL_BRAND = {"mcaffeine": "mCaffeine", "hyphen": "HYPHEN"}
_MIN_CITY_COMPLAINTS = 5  # ignore cities too small for a rate to mean anything
# A ticket's Month is when the COMPLAINT was raised, not when its order shipped - a small
# city can rack up a handful of complaints against orders placed (and counted) in an
# earlier month, making this-month's orders look artificially tiny and the rate spike past
# 100%. Requiring a minimum order volume keeps the result to cities large enough that this
# lag averages out.
_MIN_CITY_ORDERS = 100


def _month_bounds(month_label):
    """'7_Jul'26' -> ('2026-07-01', '2026-08-01'). Sheet month labels are inconsistently
    formatted (see gen_panels.build_combo2) but always start with the month number and end
    with a 2-digit year, which is all we need here."""
    m = re.match(r"^(\d+)_", month_label)
    y = re.search(r"['\s](\d{2})$", month_label)
    if not m or not y:
        return None
    month = int(m.group(1))
    year = 2000 + int(y.group(1))
    start = f"{year:04d}-{month:02d}-01"
    end = f"{year + 1:04d}-01-01" if month == 12 else f"{year:04d}-{month + 1:02d}-01"
    return start, end


def _city_order_counts(brand_db, start, end):
    rows = mysql_lib.query(
        "SELECT Shipping_Address_City, COUNT(DISTINCT Sale_Order_Code) FROM Item_level_data "
        "WHERE Brand = %s AND Order_Date >= %s AND Order_Date < %s GROUP BY Shipping_Address_City",
        (brand_db, start, end),
    )
    if rows is None:
        return None
    out = {}
    for city, cnt in rows:
        if not city or not str(city).strip():
            continue
        key = str(city).strip().upper()
        out[key] = out.get(key, 0) + int(cnt)
    return out


def _awb_city_map(awbs):
    if not awbs:
        return {}
    out = {}
    batch_size = 800
    awbs = sorted(awbs)
    for i in range(0, len(awbs), batch_size):
        batch = awbs[i:i + batch_size]
        placeholders = ",".join(["%s"] * len(batch))
        # Deliberately NOT wrapping Tracking_Number in TRIM()/UPPER() - doing so on this
        # ~50M-row table forces a full scan (confirmed: hung >60s) instead of using its
        # index. Matching on the raw indexed value costs some recall (rows with incidental
        # whitespace in Tracking_Number won't match) but stays fast.
        rows = mysql_lib.query(
            f"SELECT Tracking_Number, Shipping_Address_City FROM Item_level_data WHERE Tracking_Number IN ({placeholders})",
            batch,
        )
        if rows is None:
            return None
        for awb, city in rows:
            if not city or not str(city).strip():
                continue
            out[str(awb).strip()] = str(city).strip().upper()
    return out


def _awb_tokens(raw):
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def _delivery_city_complaint_counts(ctx, awb_city, month_label):
    col = ctx.col
    counts = {}
    for r in ctx.unique:
        if ctx.cell(r, col["cls"]) != "Delivery" or ctx.cell(r, col["month"]) != month_label:
            continue
        cities_seen = {awb_city[tok] for tok in _awb_tokens(ctx.cell(r, col["awb"])) if tok in awb_city}
        for city in cities_seen:
            counts[city] = counts.get(city, 0) + 1
    return counts


def _compute_delivery_city_spike(ctx):
    if ctx.n < 2 or "awb" not in ctx.col:
        return None
    brand_db = _MYSQL_BRAND.get(ctx.b["brand"])
    if not brand_db:
        return None
    this_month, prev_month = ctx.months[-1], ctx.months[-2]
    this_bounds, prev_bounds = _month_bounds(this_month), _month_bounds(prev_month)
    if not this_bounds or not prev_bounds:
        return None

    orders_this = _city_order_counts(brand_db, *this_bounds)
    orders_prev = _city_order_counts(brand_db, *prev_bounds) if orders_this is not None else None
    if orders_this is None or orders_prev is None:
        return None

    col = ctx.col
    awb_tokens = set()
    for r in ctx.unique:
        if ctx.cell(r, col["cls"]) != "Delivery" or ctx.cell(r, col["month"]) not in (this_month, prev_month):
            continue
        awb_tokens.update(_awb_tokens(ctx.cell(r, col["awb"])))
    awb_city = _awb_city_map(awb_tokens)
    if awb_city is None:
        return None

    complaints_this = _delivery_city_complaint_counts(ctx, awb_city, this_month)
    complaints_prev = _delivery_city_complaint_counts(ctx, awb_city, prev_month)

    best = None
    for city, cur_cnt in complaints_this.items():
        if cur_cnt < _MIN_CITY_COMPLAINTS:
            continue
        cur_orders = orders_this.get(city, 0)
        if cur_orders < _MIN_CITY_ORDERS:
            continue
        prev_cnt = complaints_prev.get(city, 0)
        prev_orders = orders_prev.get(city, 0)
        rate_cur = cur_cnt / cur_orders * 100
        rate_prev = (prev_cnt / prev_orders * 100) if prev_orders > 0 else 0
        delta = rate_cur - rate_prev
        if best is None or delta > best["delta"]:
            best = {"city": city, "cur_cnt": cur_cnt, "cur_orders": cur_orders, "rate_cur": rate_cur,
                    "prev_cnt": prev_cnt, "prev_orders": prev_orders, "rate_prev": rate_prev,
                    "delta": delta, "month_label": this_month}
    if best is None or best["delta"] <= 0:
        return None
    return best


def _get_spike(ctx):
    if not hasattr(ctx, "_delivery_geo_spike"):
        try:
            ctx._delivery_geo_spike = _compute_delivery_city_spike(ctx)
        except Exception as e:
            print(f"[{ctx.b['brand']}] delivery city-spike insight skipped: {e}")
            ctx._delivery_geo_spike = None
    return ctx._delivery_geo_spike


def _city_title(city):
    return city.title()


def build_delivery_geo_insight_item(ctx):
    """For the Delivery tab's 'Insights - Delivery' card."""
    spike = _get_spike(ctx)
    if not spike:
        return None
    return insight_item("watch",
        f"<b>{h_enc(_city_title(spike['city']))}</b> has the sharpest delivery complaint-rate spike in "
        f"{h_enc(pretty_month(spike['month_label']))}: {fnum(round1(spike['rate_cur']))}% of orders "
        f"({n0(spike['cur_cnt'])} tickets / {n0(spike['cur_orders'])} orders), up from {fnum(round1(spike['rate_prev']))}% "
        f"last month. City resolved via AWB lookup against the MySQL order DWH.")


def build_delivery_geo_narrative(ctx):
    """For the Monthly Analysis tab's Delivery narrative (current month vs last only)."""
    spike = _get_spike(ctx)
    if not spike:
        return ""
    return (f"<div class='ma-class'><h4>Delivery Complaints by City <span style='font-weight:400;font-size:12px;color:var(--text-muted);'>"
            f"(via MySQL AWB lookup)</span></h4>"
            f"<p class='ma-overall'><b>{h_enc(_city_title(spike['city']))}</b> shows the sharpest city-level complaint-rate spike this month: "
            f"{fnum(round1(spike['rate_cur']))}% of that city's orders ({n0(spike['cur_cnt'])} tickets / {n0(spike['cur_orders'])} orders) "
            f"resulted in a delivery complaint, up from {fnum(round1(spike['rate_prev']))}% last month "
            f"({n0(spike['prev_cnt'])} tickets / {n0(spike['prev_orders'])} orders).</p></div>")
