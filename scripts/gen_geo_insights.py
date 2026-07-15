"""Delayed-order city/state breakdown.

Joins the sheet's AWB (raw column 9, "Tracking Number" - never named/read anywhere else
in the pipeline) against the mcaff_prod MySQL DWH's Item_level_data table to resolve each
"Delayed Order" (Delivery class) ticket's shipping city/state, then ranks the top 10
cities and top 10 states by how much their (complaints / that area's orders) rate rose
from last month to this month - a real spike, not just an area that has more complaints
because it also has more orders. Scoped to "Delayed Order" specifically (not all Delivery
categories), confirmed with the user.

Requires MYSQL_* credentials (see mysql_lib.py) to reach the DWH. If they're not
configured (e.g. CI doesn't have the secrets yet) this whole feature quietly returns None
rather than breaking report generation - confirmed acceptable with the user, since the
existing report has no dependency on MySQL today.

The two aggregate queries against Item_level_data (~50M rows) take ~15-20s apiece even
with its Order_Date/Brand indexes, so the result is memoized on ctx - both call sites
(the Delivery tab and the Monthly Analysis narrative) share one computation.
"""
import re

from report_context import fnum, h_enc, n0, round1

_MYSQL_BRAND = {"mcaffeine": "mCaffeine", "hyphen": "HYPHEN"}
_DELAYED_CATEGORY = "Delayed Order"
_MIN_AREA_ORDERS = 100  # ignore areas too small for a rate to mean anything
_TOP_N = 10


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


def _order_counts_by_geo(brand_db, start, end):
    import mysql_lib
    rows = mysql_lib.query(
        "SELECT Shipping_Address_City, Shipping_Address_State, COUNT(DISTINCT Sale_Order_Code) FROM Item_level_data "
        "WHERE Brand = %s AND Order_Date >= %s AND Order_Date < %s GROUP BY Shipping_Address_City, Shipping_Address_State",
        (brand_db, start, end),
    )
    if rows is None:
        return None, None
    city_counts, state_counts = {}, {}
    for city, state, cnt in rows:
        cnt = int(cnt)
        if city and str(city).strip():
            k = str(city).strip().upper()
            city_counts[k] = city_counts.get(k, 0) + cnt
        if state and str(state).strip():
            k = str(state).strip().upper()
            state_counts[k] = state_counts.get(k, 0) + cnt
    return city_counts, state_counts


def _awb_geo_map(awbs):
    import mysql_lib
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
            f"SELECT Tracking_Number, Shipping_Address_City, Shipping_Address_State FROM Item_level_data WHERE Tracking_Number IN ({placeholders})",
            batch,
        )
        if rows is None:
            return None
        for awb, city, state in rows:
            city = str(city).strip().upper() if city and str(city).strip() else None
            state = str(state).strip().upper() if state and str(state).strip() else None
            if city or state:
                out[str(awb).strip()] = (city, state)
    return out


def _awb_tokens(raw):
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def _delayed_rows(ctx, month_label):
    col = ctx.col
    for r in ctx.unique:
        if (ctx.cell(r, col["cls"]) == "Delivery" and ctx.cell(r, col["cat"]) == _DELAYED_CATEGORY
                and ctx.cell(r, col["month"]) == month_label):
            yield r


def _geo_complaint_counts(ctx, awb_geo, month_label, dim_idx):
    col = ctx.col
    counts = {}
    for r in _delayed_rows(ctx, month_label):
        seen = set()
        for tok in _awb_tokens(ctx.cell(r, col["awb"])):
            geo = awb_geo.get(tok)
            if geo and geo[dim_idx]:
                seen.add(geo[dim_idx])
        for v in seen:
            counts[v] = counts.get(v, 0) + 1
    return counts


def _rank(complaints_this, complaints_prev, orders_this, orders_prev):
    rows = []
    for key, cur_cnt in complaints_this.items():
        cur_orders = orders_this.get(key, 0)
        if cur_orders < _MIN_AREA_ORDERS:
            continue
        prev_cnt = complaints_prev.get(key, 0)
        prev_orders = orders_prev.get(key, 0)
        rate_cur = cur_cnt / cur_orders * 100
        rate_prev = (prev_cnt / prev_orders * 100) if prev_orders > 0 else 0
        rows.append({"name": key, "cur_cnt": cur_cnt, "cur_orders": cur_orders, "rate_cur": rate_cur,
                     "prev_cnt": prev_cnt, "prev_orders": prev_orders, "rate_prev": rate_prev,
                     "delta": rate_cur - rate_prev})
    rows.sort(key=lambda r: r["delta"], reverse=True)
    return rows[:_TOP_N]


def _compute_delayed_order_geo(ctx):
    if ctx.n < 2 or "awb" not in ctx.col:
        return None
    brand_db = _MYSQL_BRAND.get(ctx.b["brand"])
    if not brand_db:
        return None
    this_month, prev_month = ctx.months[-1], ctx.months[-2]
    this_bounds, prev_bounds = _month_bounds(this_month), _month_bounds(prev_month)
    if not this_bounds or not prev_bounds:
        return None

    city_orders_this, state_orders_this = _order_counts_by_geo(brand_db, *this_bounds)
    if city_orders_this is None:
        return None
    city_orders_prev, state_orders_prev = _order_counts_by_geo(brand_db, *prev_bounds)
    if city_orders_prev is None:
        return None

    col = ctx.col
    awb_tokens = set()
    for month_label in (this_month, prev_month):
        for r in _delayed_rows(ctx, month_label):
            awb_tokens.update(_awb_tokens(ctx.cell(r, col["awb"])))
    awb_geo = _awb_geo_map(awb_tokens)
    if awb_geo is None:
        return None

    city_complaints_this = _geo_complaint_counts(ctx, awb_geo, this_month, 0)
    city_complaints_prev = _geo_complaint_counts(ctx, awb_geo, prev_month, 0)
    state_complaints_this = _geo_complaint_counts(ctx, awb_geo, this_month, 1)
    state_complaints_prev = _geo_complaint_counts(ctx, awb_geo, prev_month, 1)

    top_cities = _rank(city_complaints_this, city_complaints_prev, city_orders_this, city_orders_prev)
    top_states = _rank(state_complaints_this, state_complaints_prev, state_orders_this, state_orders_prev)
    if not top_cities and not top_states:
        return None
    return {"month_label": this_month, "cities": top_cities, "states": top_states}


def _get_delayed_geo(ctx):
    if not hasattr(ctx, "_delayed_order_geo"):
        try:
            ctx._delayed_order_geo = _compute_delayed_order_geo(ctx)
        except Exception as e:
            print(f"[{ctx.b['brand']}] delayed-order geo breakdown skipped: {e}")
            ctx._delayed_order_geo = None
    return ctx._delayed_order_geo


def _geo_title(v):
    return v.title()


def _geo_table_html(title, rows, name_label):
    if not rows:
        return f"<p class='note'>No {h_enc(name_label.lower())} had enough order volume to rank.</p>"
    trs = []
    for i, r in enumerate(rows, start=1):
        trs.append(
            f"<tr><td class='rowlabel'>{i}. {h_enc(_geo_title(r['name']))}</td>"
            f"<td class='num'>{n0(r['cur_cnt'])}</td><td class='num'>{n0(r['cur_orders'])}</td>"
            f"<td class='pct'>{fnum(round1(r['rate_cur']))}%</td>"
            f"<td class='pct'>{fnum(round1(r['rate_prev']))}%</td></tr>"
        )
    return (f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(title)}</div><div class='pivot-scroll'>"
            f"<table class='pivot-table'><thead><tr><th class='corner'>{h_enc(name_label)}</th>"
            f"<th>Delayed Tickets</th><th>Orders</th><th>Rate</th><th>Prev Rate</th></tr></thead>"
            f"<tbody>{''.join(trs)}</tbody></table></div></div>")


def _geo_block(ctx, heading_extra=""):
    geo = _get_delayed_geo(ctx)
    if not geo:
        return ""
    cities_html = _geo_table_html("Top 10 Cities — Delayed Order", geo["cities"], "City")
    states_html = _geo_table_html("Top 10 States — Delayed Order", geo["states"], "State")
    return (f"<div class='gran-monthly'><section><h2>Delayed Order by City &amp; State{heading_extra}</h2>"
            f"<p class=\"desc\">Ranked by how much each area's (delayed-order tickets &divide; that area's orders) rate rose vs last month. "
            f"City/state resolved via AWB lookup against the MySQL order DWH; areas with fewer than {n0(_MIN_AREA_ORDERS)} orders that month are excluded as too small to rank.</p>"
            f"{cities_html}{states_html}</section></div>")


def build_delivery_geo_block(ctx):
    """For the Delivery tab, appended after the Insights card."""
    return _geo_block(ctx)


def build_delivery_geo_narrative(ctx):
    """For the Monthly Analysis tab's Delivery narrative (current month vs last only)."""
    return _geo_block(ctx)
