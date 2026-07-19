"""Delivery city/state breakdown - reactive to Weekly/Monthly/Yearly granularity.

Joins the sheet's AWB (raw column 9, "Tracking Number" - never named/read anywhere else
in the pipeline) against the mcaff_prod MySQL DWH's Item_level_data table to resolve every
Delivery-class ticket's shipping city/state (any category, not just "Delayed Order" - the
AWB lookup itself covers the whole class). Two consumers read the result:
  1. The aggregate Delayed-Order-only top-10-cities/top-10-states tables (Delivery tab +
     Monthly Analysis's "Delivery Complaints by City & State" section) - ranks by how much
     an area's (complaints / that area's orders) rate rose between two periods, a real
     spike rather than just an area that has more complaints because it also has more
     orders. Embedded as JSON, sliced/ranked client-side in JS (see build_geo_script).
  2. Per-category real state-name movers embedded directly in each Delivery category's
     Monthly Analysis narrative bullet, alongside the courier movers - see
     get_category_state_movers, called from gen_monthly.build_class_period_narrative.
     Computed and rendered server-side (Python), never sent to the browser as JSON.

Must react to whichever period the user has picked via the existing Monthly/Weekly/Yearly
selectors (both the Delivery tab's page-wide gran_toolbar and Monthly Analysis's own
granularity toggle + period dropdown) - pre-rendering a server-side table for every
possible period pair would mean a per-period round of MySQL queries (there can be a dozen+
month pairs, more week pairs), which isn't remotely feasible. Instead this fetches the
FULL history ONCE per brand (complaint counts from the sheet, order counts from MySQL,
both bucketed per calendar week). Consumer 1 embeds it as compact JSON and does the
period-slicing/ranking entirely client-side in JS - the embedded renderGeoForDeliveryTab()
and renderGeoForMonthlyAnalysis() hooks are called from the existing granularity-change
handlers in gen_panels.py/gen_monthly.py. Consumer 2 does the equivalent slicing in Python
at narrative-build time instead, since those bullets are plain pre-rendered HTML.

Order-count queries: a single query spanning the WHOLE date range (whether grouped by
month or by week) reliably times out (>90s) against this ~50M-row table - even a plain
YEAR()/MONTH() grouping with no other computed expression. Only a single CALENDAR MONTH
date-range filter stays fast (~20-35s, confirmed via EXPLAIN using the Order_Date/Brand
index). So this runs one query PER MONTH in ctx.months, not one combined query - a real
increase in report-generation time (roughly 20-35s x months x brands), traded for the
tables actually working at every granularity.

Requires MYSQL_* credentials (see mysql_lib.py) to reach the DWH. If they're not
configured (e.g. CI doesn't have the secrets yet) this whole feature quietly returns None
rather than breaking report generation.

Both MySQL round-trips are persistently cached in data/ (committed to the repo, same
convention as the sheet's own primary/secondary/smalltabs caches) so a full-history re-scan
only ever happens once:
  - data/<brand>_awb_geo_cache.json: AWB -> [city, state] (or null if that AWB has no
    matching row at all). A tracking number's shipping destination never changes once
    resolved, so this is append-only - only AWBs not already in the cache get queried.
  - data/<brand>_geo_orders_cache.json: month label -> that month's full (city, state,
    week-of-month, order count) rows. Only the single most recent calendar month can still
    be accumulating orders; every earlier month is settled and reused from cache forever.
"""
import json
import re
from pathlib import Path

from gen_weekly import get_week_num
from report_context import ci_key, j_enc, year_of

_MYSQL_BRAND = {"mcaffeine": "mCaffeine", "hyphen": "HYPHEN"}
_DELAYED_CATEGORY = "Delayed Order"
_MIN_AREA_ORDERS = 100  # ignore areas too small for a rate to mean anything
_REPO_ROOT = Path(__file__).resolve().parent.parent


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


def _order_counts_by_geo_week(brand_db, start, end):
    """One calendar month's (city, state, week-of-month 1-5) -> distinct order count."""
    import mysql_lib
    return mysql_lib.query(
        "SELECT Shipping_Address_City, Shipping_Address_State, FLOOR((DAYOFMONTH(Order_Date)-1)/7)+1 wk, "
        "COUNT(DISTINCT Sale_Order_Code) FROM Item_level_data "
        "WHERE Brand = %s AND Order_Date >= %s AND Order_Date < %s "
        "GROUP BY Shipping_Address_City, Shipping_Address_State, wk",
        (brand_db, start, end),
    )


def _orders_cache_path(ctx):
    return _REPO_ROOT / "data" / f"{ctx.b['brand']}_geo_orders_cache.json"


def _load_json_cache(path):
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _save_json_cache(path, cache):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, separators=(",", ":"))


def _order_counts_by_month_cached(ctx, brand_db):
    """Every month's full (unfiltered) order-count rows, keyed by month label - cached
    indefinitely except the single most recent month, which can still be accumulating
    orders and is always re-queried live. Kept unfiltered by city/state (unlike the
    in-memory city_orders/state_orders dicts built from this) so the cache stays valid
    regardless of which areas happen to have complaints in any given run."""
    cache_path = _orders_cache_path(ctx)
    cache = _load_json_cache(cache_path)
    refresh_months = set(ctx.months[-1:])
    result = {}
    changed = False
    for month_label in ctx.months:
        if month_label in cache and month_label not in refresh_months:
            result[month_label] = cache[month_label]
            continue
        bounds = _month_bounds(month_label)
        if not bounds:
            continue
        rows_mo = _order_counts_by_geo_week(brand_db, *bounds)
        if rows_mo is None:
            if month_label in cache:
                result[month_label] = cache[month_label]
                continue
            return None
        rows_mo = [list(r) for r in rows_mo]
        result[month_label] = rows_mo
        cache[month_label] = rows_mo
        changed = True
    if changed:
        _save_json_cache(cache_path, cache)
    return result


def _awb_cache_path(ctx):
    return _REPO_ROOT / "data" / f"{ctx.b['brand']}_awb_geo_cache.json"


def _awb_geo_map(ctx, awbs):
    """AWB -> (city, state), backed by a persistent append-only cache (an AWB's shipping
    destination never changes once resolved). Only tokens not already in the cache incur a
    MySQL round-trip; a cache entry of null means "queried, no matching row" so unmatchable
    AWBs (typos, pre-DWH tickets) aren't re-queried forever either."""
    if not awbs:
        return {}
    cache_path = _awb_cache_path(ctx)
    cache = _load_json_cache(cache_path)

    out = {}
    to_fetch = []
    for a in awbs:
        if a in cache:
            v = cache[a]
            if v:
                out[a] = (v[0], v[1])
        else:
            to_fetch.append(a)

    if to_fetch:
        import mysql_lib
        batch_size = 800
        to_fetch.sort()
        cache_changed = False
        for i in range(0, len(to_fetch), batch_size):
            batch = to_fetch[i:i + batch_size]
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
                if cache_changed:
                    _save_json_cache(cache_path, cache)
                return None
            found = set()
            for awb, city, state in rows:
                awb_key = str(awb).strip()
                found.add(awb_key)
                city = str(city).strip().upper() if city and str(city).strip() else None
                state = str(state).strip().upper() if state and str(state).strip() else None
                if city or state:
                    out[awb_key] = (city, state)
                    cache[awb_key] = [city, state]
                else:
                    cache[awb_key] = None
            for a in batch:
                if a not in found:
                    cache[a] = None
            cache_changed = True
        if cache_changed:
            _save_json_cache(cache_path, cache)
    return out


def _awb_tokens(raw):
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def _delivery_rows_all(ctx):
    """Every Delivery-class unique ticket (any category) across every month - the tables
    must react to whichever period is selected, not just the most recent one. Covers every
    category (not just 'Delayed Order') so per-category state movers can be computed for
    Monthly Analysis's narrative bullets - see get_category_state_movers."""
    col = ctx.col
    return [r for r in ctx.unique if ctx.cell(r, col["cls"]) == "Delivery"]


def _global_week_index(ctx, row):
    col = ctx.col
    mo = ctx.cell(row, col["month"])
    wk = ctx.cell(row, col["week"])
    if not str(wk).strip() or wk == "#N/A":
        return -1
    return ctx.ma_week_global_idx.get(f"{mo}||{wk}", -1)


def _compute_geo_dataset(ctx):
    if "awb" not in ctx.col or ctx.total_weeks < 2:
        return None
    brand_db = _MYSQL_BRAND.get(ctx.b["brand"])
    if not brand_db:
        return None

    rows = _delivery_rows_all(ctx)
    if not rows:
        return None

    # ---------- numerator: complaint counts by (category, city/state, global week index) ----------
    # Tallied per-category (cat_city_complaints/cat_state_complaints) so Monthly Analysis can
    # show real state-name movers for EVERY Delivery category (see get_category_state_movers),
    # not just Delayed Order. The aggregate city_complaints/state_complaints dicts below stay
    # scoped to Delayed Order only, unchanged - they still feed the two existing city/state
    # tables (Delivery tab + MA "Delivery Complaints by City & State"), sent to the browser as
    # JSON; the per-category dicts are only ever consumed server-side and never embedded.
    col = ctx.col
    awb_tokens = set()
    for r in rows:
        awb_tokens.update(_awb_tokens(ctx.cell(r, col["awb"])))
    awb_geo = _awb_geo_map(ctx, awb_tokens)
    if awb_geo is None:
        return None

    cat_cache = {}
    city_complaints, state_complaints = {}, {}
    cat_city_complaints, cat_state_complaints = {}, {}
    all_cities, all_states = set(), set()
    for r in rows:
        gi = _global_week_index(ctx, r)
        if gi < 0:
            continue
        cat = ctx.cell(r, col["cat"])
        if not str(cat).strip():
            cat = "(blank)"
        cat = ci_key(cat, cat_cache)
        seen_c, seen_s = set(), set()
        for tok in _awb_tokens(ctx.cell(r, col["awb"])):
            geo = awb_geo.get(tok)
            if not geo:
                continue
            city, state = geo
            if city:
                seen_c.add(city)
            if state:
                seen_s.add(state)
        for city in seen_c:
            all_cities.add(city)
            cat_city_complaints.setdefault(cat, {}).setdefault(city, {})
            cat_city_complaints[cat][city][gi] = cat_city_complaints[cat][city].get(gi, 0) + 1
            if cat == _DELAYED_CATEGORY:
                city_complaints.setdefault(city, {})
                city_complaints[city][gi] = city_complaints[city].get(gi, 0) + 1
        for state in seen_s:
            all_states.add(state)
            cat_state_complaints.setdefault(cat, {}).setdefault(state, {})
            cat_state_complaints[cat][state][gi] = cat_state_complaints[cat][state].get(gi, 0) + 1
            if cat == _DELAYED_CATEGORY:
                state_complaints.setdefault(state, {})
                state_complaints[state][gi] = state_complaints[state].get(gi, 0) + 1

    if not all_cities and not all_states:
        return None

    # ---------- denominator: order counts by (city/state, global week index) ----------
    # One query per calendar month (see module docstring), cached per month (see
    # _order_counts_by_month_cached) so only the most recent month is ever re-queried live.
    # Only cities/states that appear in at least one Delivery category's complaints are kept
    # in the in-memory dicts below (all_cities/all_states, a superset of the Delayed-Order-
    # only city_complaints/state_complaints) - the cache itself stays unfiltered/full so it
    # doesn't need invalidating just because a new area starts having complaints. An area's
    # order volume doesn't depend on complaint category, so this one denominator serves
    # every category's rate calc.
    week_num_to_global_idx = {}
    for wi in range(ctx.total_weeks):
        mi = ctx.week_month_of[wi]
        wn = get_week_num(ctx.all_weeks[wi])
        week_num_to_global_idx[(mi, wn)] = wi

    order_counts_by_month = _order_counts_by_month_cached(ctx, brand_db)
    if order_counts_by_month is None:
        return None

    city_orders, state_orders = {}, {}
    for mi, month_label in enumerate(ctx.months):
        rows_mo = order_counts_by_month.get(month_label)
        if not rows_mo:
            continue
        for city, state, wk, cnt in rows_mo:
            gi = week_num_to_global_idx.get((mi, int(wk)))
            if gi is None:
                continue
            cnt = int(cnt)
            if city and str(city).strip():
                ck = str(city).strip().upper()
                if ck in all_cities:
                    city_orders.setdefault(ck, {})
                    city_orders[ck][gi] = city_orders[ck].get(gi, 0) + cnt
            if state and str(state).strip():
                sk = str(state).strip().upper()
                if sk in all_states:
                    state_orders.setdefault(sk, {})
                    state_orders[sk][gi] = state_orders[sk].get(gi, 0) + cnt

    cities = sorted(city_complaints.keys())
    states = sorted(state_complaints.keys())
    n_weeks = ctx.total_weeks

    def to_matrix(complaints, orders, keys):
        comp = [[complaints.get(k, {}).get(wi, 0) for wi in range(n_weeks)] for k in keys]
        ordr = [[orders.get(k, {}).get(wi, 0) for wi in range(n_weeks)] for k in keys]
        return comp, ordr

    city_comp, city_ord = to_matrix(city_complaints, city_orders, cities)
    state_comp, state_ord = to_matrix(state_complaints, state_orders, states)
    month_year_idx = [ctx.ma_year_index_of.get(year_of(mo), -1) for mo in ctx.months]

    return {
        "cities": cities, "states": states,
        "city_complaints": city_comp, "city_orders": city_ord,
        "state_complaints": state_comp, "state_orders": state_ord,
        "week_month_of": list(ctx.week_month_of), "month_year_idx": month_year_idx,
        "total_weeks": n_weeks, "total_months": ctx.n,
        "cat_state_complaints": cat_state_complaints, "cat_city_complaints": cat_city_complaints,
        "state_orders_raw": state_orders,
    }


def _get_geo_dataset(ctx):
    if not hasattr(ctx, "_geo_dataset"):
        try:
            ctx._geo_dataset = _compute_geo_dataset(ctx)
        except Exception as e:
            print(f"[{ctx.b['brand']}] delivery geo dataset skipped: {e}")
            ctx._geo_dataset = None
    return ctx._geo_dataset


def get_category_state_movers(ctx, category, cur_weeks, prev_weeks, proj_factor=None, min_cur=3, top_n=2):
    """Real state-name movers (via MySQL AWB lookup) for one Delivery category, for an
    already-resolved (cur_weeks, prev_weeks) global-week-index pair - see gen_monthly's
    period 'weeks_fn' callbacks. Mirrors the sheet-column courier-mover format/semantics
    (gen_monthly.build_class_period_narrative) but sourced from the geo dataset instead,
    since state name isn't a sheet column. Returns [] if geo data isn't available (MySQL
    not configured, or nothing resolved for this category)."""
    dataset = _get_geo_dataset(ctx)
    if not dataset:
        return []
    cat_states = dataset["cat_state_complaints"].get(category)
    if not cat_states:
        return []
    state_orders = dataset["state_orders_raw"]

    movers = []
    for state, weekmap in cat_states.items():
        cur = sum(weekmap.get(wi, 0) for wi in cur_weeks)
        cur_proj = round(cur * proj_factor) if proj_factor else cur
        if cur_proj < min_cur:
            continue
        prev = sum(weekmap.get(wi, 0) for wi in prev_weeks)
        delta = cur_proj - prev
        if delta <= 0:
            continue
        cur_orders = sum(state_orders.get(state, {}).get(wi, 0) for wi in cur_weeks)
        prev_orders = sum(state_orders.get(state, {}).get(wi, 0) for wi in prev_weeks)
        if cur_orders < _MIN_AREA_ORDERS:
            continue
        rate_cur = (cur / cur_orders * 100) if cur_orders > 0 else 0
        rate_prev = (prev / prev_orders * 100) if prev_orders > 0 else 0
        movers.append({"name": state, "cur": cur, "cur_proj": cur_proj, "prev": prev,
                        "rate_cur": rate_cur, "rate_prev": rate_prev, "delta": delta})
    movers.sort(key=lambda m: m["delta"], reverse=True)
    return movers[:top_n]


def _aj_num_matrix(m):
    return "[" + ",".join("[" + ",".join(str(v) for v in row) + "]" for row in m) + "]"


def _aj_str(a):
    return "[" + ",".join(f'"{j_enc(x)}"' for x in a) + "]"


def _aj_num(a):
    return "[" + ",".join(str(v) for v in a) + "]"


def build_geo_script(ctx):
    """Embedded once per report (see gen_panels.assemble_report). Provides window.GEO_DATA
    plus the rendering/aggregation functions both the Delivery tab and the Monthly
    Analysis tab call into when their granularity/period selectors change."""
    dataset = _get_geo_dataset(ctx)
    if not dataset:
        return "<script>window.GEO_DATA=null;</script>"

    data_js = (
        "window.GEO_DATA={"
        f"cities:{_aj_str(dataset['cities'])},states:{_aj_str(dataset['states'])},"
        f"cityComplaints:{_aj_num_matrix(dataset['city_complaints'])},cityOrders:{_aj_num_matrix(dataset['city_orders'])},"
        f"stateComplaints:{_aj_num_matrix(dataset['state_complaints'])},stateOrders:{_aj_num_matrix(dataset['state_orders'])},"
        f"weekMonthOf:{_aj_num(dataset['week_month_of'])},monthYearIdx:{_aj_num(dataset['month_year_idx'])},"
        f"totalWeeks:{dataset['total_weeks']},totalMonths:{dataset['total_months']},minOrders:{_MIN_AREA_ORDERS}"
        "};"
    )

    return f"""<script>
{data_js}
(function(){{
  function titleCase(s){{ return String(s).replace(/\\w\\S*/g, function(t){{ return t.charAt(0).toUpperCase()+t.slice(1).toLowerCase(); }}); }}
  function fmt(n){{ return n.toLocaleString('en-IN'); }}
  function fnum1(v){{ v = Math.round(v*10)/10; var s=v.toFixed(1); return s.replace(/\\.0$/,''); }}
  function weeksForMonth(mi){{ var out=[]; window.GEO_DATA.weekMonthOf.forEach(function(m,wi){{ if(m===mi) out.push(wi); }}); return out; }}
  function weeksForYear(yi){{ var out=[]; for(var mi=0;mi<window.GEO_DATA.monthYearIdx.length;mi++){{ if(window.GEO_DATA.monthYearIdx[mi]===yi){{ out=out.concat(weeksForMonth(mi)); }} }} return out; }}
  window.geoWeeksForMonth = weeksForMonth;
  window.geoWeeksForYear = weeksForYear;
  function sumOver(arr, weeks){{ var t=0; for(var i=0;i<weeks.length;i++){{ t+=arr[weeks[i]]||0; }} return t; }}
  function rankGeo(names, complaintsM, ordersM, curWeeks, prevWeeks){{
    var rows=[];
    for(var i=0;i<names.length;i++){{
      var curOrders=sumOver(ordersM[i],curWeeks);
      if(curOrders<window.GEO_DATA.minOrders) continue;
      var curCnt=sumOver(complaintsM[i],curWeeks), prevCnt=sumOver(complaintsM[i],prevWeeks), prevOrders=sumOver(ordersM[i],prevWeeks);
      var rateCur=curOrders>0?(curCnt/curOrders*100):0, ratePrev=prevOrders>0?(prevCnt/prevOrders*100):0;
      rows.push({{name:names[i],cur:curCnt,curO:curOrders,prev:prevCnt,prevO:prevOrders,rateCur:rateCur,ratePrev:ratePrev,delta:rateCur-ratePrev}});
    }}
    rows.sort(function(a,b){{ return b.delta-a.delta; }});
    return rows.slice(0,10);
  }}
  function tableHTML(title,nameLabel,rows){{
    if(!rows.length) return '<p class="note">No '+nameLabel.toLowerCase()+' had enough order volume to rank for this period.</p>';
    var trs=rows.map(function(r,i){{
      return '<tr><td class="rowlabel">'+(i+1)+'. '+titleCase(r.name)+'</td><td class="num">'+fmt(r.cur)+'</td><td class="num">'+fmt(r.curO)+'</td>'
        +'<td class="pct">'+fnum1(r.rateCur)+'%</td><td class="pct">'+fnum1(r.ratePrev)+'%</td></tr>';
    }}).join('');
    return '<div class="pivot-wrap"><div class="pivot-title">'+title+'</div><div class="pivot-scroll"><table class="pivot-table"><thead><tr>'
      +'<th class="corner">'+nameLabel+'</th><th>Delayed Tickets</th><th>Orders</th><th>Rate</th><th>Prev Rate</th></tr></thead><tbody>'+trs+'</tbody></table></div></div>';
  }}
  window.geoRenderTables=function(cityElId,stateElId,curWeeks,prevWeeks){{
    if(!window.GEO_DATA) return;
    var cityEl=document.getElementById(cityElId), stateEl=document.getElementById(stateElId);
    if(cityEl){{ cityEl.innerHTML=tableHTML('Top 10 Cities \\u2014 Delayed Order','City',rankGeo(window.GEO_DATA.cities,window.GEO_DATA.cityComplaints,window.GEO_DATA.cityOrders,curWeeks,prevWeeks)); }}
    if(stateEl){{ stateEl.innerHTML=tableHTML('Top 10 States \\u2014 Delayed Order','State',rankGeo(window.GEO_DATA.states,window.GEO_DATA.stateComplaints,window.GEO_DATA.stateOrders,curWeeks,prevWeeks)); }}
    if(window.injectButtons) window.injectButtons();
  }};
  window.renderGeoForDeliveryTab=function(){{
    if(!window.GEO_DATA) return;
    var activeBtn=document.querySelector('.gran-toggle .gran-btn.active');
    var g=activeBtn?activeBtn.dataset.gran:'monthly';
    var curWeeks,prevWeeks;
    if(g==='weekly'&&window.GEO_DATA.totalWeeks>=2){{
      curWeeks=[window.GEO_DATA.totalWeeks-1]; prevWeeks=[window.GEO_DATA.totalWeeks-2];
    }} else {{
      var lastMi=window.GEO_DATA.totalMonths-1;
      curWeeks=weeksForMonth(lastMi); prevWeeks=weeksForMonth(lastMi-1);
    }}
    window.geoRenderTables('geo-delivery-cities','geo-delivery-states',curWeeks,prevWeeks);
  }};
  window.renderGeoForMonthlyAnalysis=function(granularity,curIdx){{
    if(!window.GEO_DATA) return;
    var wrap=document.getElementById('geo-ma-wrap');
    if(granularity==='daily'){{ if(wrap) wrap.style.display='none'; return; }}
    if(wrap) wrap.style.display='';
    var curWeeks,prevWeeks;
    if(granularity==='monthly'){{ curWeeks=weeksForMonth(curIdx); prevWeeks=weeksForMonth(curIdx-1); }}
    else if(granularity==='weekly'){{ curWeeks=[curIdx]; prevWeeks=[curIdx-1]; }}
    else if(granularity==='yearly'){{ curWeeks=weeksForYear(curIdx); prevWeeks=weeksForYear(curIdx-1); }}
    else return;
    window.geoRenderTables('geo-ma-cities','geo-ma-states',curWeeks,prevWeeks);
  }};
  function init(){{ window.renderGeoForDeliveryTab(); }}
  if(document.readyState==='loading'){{document.addEventListener('DOMContentLoaded',init);}}else{{init();}}
}})();
</script>"""


def build_delivery_geo_containers(ctx):
    """Static placeholder for the Delivery tab - populated reactively by
    renderGeoForDeliveryTab() (see build_geo_script), which re-runs whenever the page-wide
    Monthly/Weekly toggle changes. Deliberately NOT tagged '.gran-monthly'/'.gran-weekly' -
    those classes make applyGranularity() hide the element entirely in the other mode, but
    this section should stay visible and just re-render its own content in both modes."""
    if not _get_geo_dataset(ctx):
        return ""
    return (f"<section><h2>Delayed Order by City &amp; State</h2>"
            f"<p class=\"desc\">Ranked by how much each area's (delayed-order tickets &divide; that area's orders) rate rose vs the "
            f"previous period. City/state resolved via AWB lookup against the MySQL order DWH; areas with fewer than {_MIN_AREA_ORDERS} "
            f"orders that period are excluded as too small to rank. Follows the Monthly/Weekly toggle above.</p>"
            f"<div id='geo-delivery-cities'></div><div id='geo-delivery-states'></div></section>")


def build_monthly_analysis_geo_containers(ctx):
    """Static placeholder for the Monthly Analysis tab - one shared container (not one per
    wrap) since only one of Monthly/Weekly/Yearly is visible at a time; populated/hidden
    reactively by renderGeoForMonthlyAnalysis() (see build_geo_script)."""
    if not _get_geo_dataset(ctx):
        return ""
    return (f"<div class='ma-class' id='geo-ma-wrap'><h4>Delivery Complaints by City &amp; State "
            f"<span style='font-weight:400;font-size:12px;color:var(--text-muted);'>(via MySQL AWB lookup, Delayed Order only)</span></h4>"
            f"<p class=\"desc\">Ranked by how much each area's rate rose vs the previous period; areas with fewer than {_MIN_AREA_ORDERS} "
            f"orders that period are excluded. Follows the Monthly/Weekly/Yearly selection above.</p>"
            f"<div id='geo-ma-cities'></div><div id='geo-ma-states'></div></div>")
