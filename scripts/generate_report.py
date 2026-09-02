#!/usr/bin/env python3
"""Config-driven report generator. Fetches a brand's sheet data and produces the full
self-contained <brand>.html at the repo root. Python port of Generate-Report.ps1.

Usage: python generate_report.py --brand-index 0 [--quick]
"""
import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import gen_digest_facts
import gen_monthly
import gen_panels
import gen_raw_export
import gen_weekly
import kyc_source
import lib
import nps_source
from brands import BRANDS
from report_context import Ctx, ci_key, fnum, h_enc, index_map, j_enc, n0, parse_month_label, pretty_month, round1, year_of

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent


def get_sales_m_by_month(ctx, rows_subset):
    tmp = {}
    sm_caches = {}
    mo_cache = {}
    for r in rows_subset:
        mo = ctx.cell(r, ctx.col["month"])
        sm = ctx.cell(r, ctx.col["sales"])
        if not str(mo).strip() or not str(sm).strip():
            continue
        mo = ci_key(mo, mo_cache)
        tmp.setdefault(mo, {})
        sm = ci_key(sm, sm_caches.setdefault(mo, {}))
        tmp[mo][sm] = tmp[mo].get(sm, 0) + 1
    res = {}
    for mo, counts in tmp.items():
        # Sheet formula errors (#REF!, #N/A, #DIV/0!, etc.) sometimes leak into this
        # column when an upstream reference breaks - skip those candidates rather
        # than crash the whole run; if literally every candidate for a month is
        # unparseable, that month is just left out of res (callers already default
        # missing months to 0 via ctx.sales_m.get(mo, 0)).
        for val, _ in sorted(counts.items(), key=lambda kv: kv[1], reverse=True):
            try:
                res[mo] = float(str(val).replace(",", ""))
                break
            except ValueError:
                continue
    return res


def build_class_month_counts(ctx, rows):
    res = {}
    c_cache = {}
    mo_caches = {}
    for r in rows:
        c = ctx.cell(r, ctx.col["cls"])
        if not str(c).strip():
            continue
        mo = ctx.cell(r, ctx.col["month"])
        if not str(mo).strip():
            continue
        c = ci_key(c, c_cache)
        res.setdefault(c, {})
        mo = ci_key(mo, mo_caches.setdefault(c, {}))
        res[c][mo] = res[c].get(mo, 0) + 1
    return res


def build_pivot(ctx, title, counts_by_class_month):
    months = ctx.months
    parts = [f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(title)}</div><div class='pivot-scroll'>"
             f"<table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>Query Class</th>"]
    for mo in months:
        parts.append(f"<th colspan='2' class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    parts.append("</tr><tr>")
    for mo in months:
        yr = year_of(mo)
        parts.append(f"<th class='sub-hdr' data-yr='{yr}'>Count</th><th class='sub-hdr' data-yr='{yr}'>%</th>")
    parts.append("</tr></thead><tbody>")
    totals = {}
    for ri, c in enumerate(ctx.b["classes"], start=1):
        z = "zebra" if ri % 2 == 1 else ""
        parts.append(f"<tr class='{z}'><td class='rowlabel'>{h_enc(c['label'])}</td>")
        for mo in months:
            cnt = counts_by_class_month.get(c["key"], {}).get(mo, 0)
            totals[mo] = totals.get(mo, 0) + cnt
            sm = ctx.sales_m.get(mo, 0)
            pct = round1(cnt / sm * 100) if sm > 0 else 0
            cd = n0(cnt) if cnt > 0 else "-"
            yr = year_of(mo)
            parts.append(f"<td class='num' data-yr='{yr}'>{cd}</td><td class='pct' data-yr='{yr}'>{fnum(pct)}%</td>")
        parts.append("</tr>")
    parts.append("<tr class='total-row'><td class='rowlabel'>Total</td>")
    for mo in months:
        t = totals.get(mo, 0)
        sm = ctx.sales_m.get(mo, 0)
        pct = round1(t / sm * 100) if sm > 0 else 0
        yr = year_of(mo)
        parts.append(f"<td class='num' data-yr='{yr}'>{n0(t)}</td><td class='pct' data-yr='{yr}'>{fnum(pct)}%</td>")
    parts.append("</tr></tbody></table></div></div>")
    return "".join(parts)


def build_pct_trend_chart(ctx, title, counts_by_class_month):
    months = ctx.months
    W, H, pad_l, pad_r, pad_t, pad_b = 1200, 380, 46, 60, 20, 55
    chart_id = gen_panels._next_chart_id("trend")
    months_json = "[" + ",".join(f'"{j_enc(m)}"' for m in months) + "]"
    month_labels_json = "[" + ",".join(f'"{j_enc(pretty_month(m))}"' for m in months) + "]"
    series_parts, legend_parts = [], []
    for c in ctx.b["classes"]:
        vals = []
        for mo in months:
            cnt = counts_by_class_month.get(c["key"], {}).get(mo, 0)
            sm = ctx.sales_m.get(mo, 0)
            vals.append(round1(cnt / sm * 100) if sm > 0 else 0)
        vals_json = "[" + ",".join(str(v) for v in vals) + "]"
        series_parts.append(f"{{label:'{j_enc(c['label'])}', color:'{c['color']}', vals:{vals_json}}}")
        legend_parts.append(f"<div class='legend-item'><span class='swatch' style='background:{c['color']};'></span><span class='lname'>{h_enc(c['label'])}</span></div>")
    series_json = "[" + ",".join(series_parts) + "]"
    parts = [f"<div class='card chart-wrap'><div class='pivot-title' style='margin-bottom:18px;'>{h_enc(title)}</div>"
             f"<div class='legend-row' style='justify-content:center;flex-wrap:wrap;'>{''.join(legend_parts)}</div>"
             f"<svg id='{chart_id}' viewBox='0 0 {W} {H}' width='100%' height='{H}' role='img'></svg>"
             f"<div class='chart-tip' id='{chart_id}-tip'></div></div>"]
    parts.append(f"""<script>
(function(){{
  var svg = document.getElementById('{chart_id}');
  var tip = document.getElementById('{chart_id}-tip');
  var opts = {{ series:{series_json}, months:{months_json}, monthLabels:{month_labels_json},
    W:{W}, H:{H}, padL:{pad_l}, padR:{pad_r}, padT:{pad_t}, padB:{pad_b}}};
  var state = {{ isolated: null }};
  window.registerYearChart(function(){{ window.renderMultiPctTrendChart(svg, tip, opts, state); }});
}})();
</script>""")
    return "".join(parts)


def kpi_row(ctx, cls, subset):
    m = ctx.class_dup.get(cls["key"], {"U": len(subset), "D": 0})
    tot = m["U"] + m["D"]
    dup = round1(m["D"] / tot * 100) if tot > 0 else 0
    share = round1(len(subset) / ctx.total_unique * 100) if ctx.total_unique > 0 else 0
    tm = ctx.count_by_month(subset)
    peak_key = ""
    peak_val = 0
    for mo in ctx.months:
        v = tm.get(mo, 0)
        if v > peak_val:
            peak_val, peak_key = v, mo
    peak_label = pretty_month(peak_key) if peak_key else "-"
    uid = ' id="delivery-kpi-unique-label"' if cls["id"] == "delivery" else ""
    vid = ' id="delivery-kpi-unique-value"' if cls["id"] == "delivery" else ""
    return (f'<div class="kpi-row"><div class="kpi"><div class="label"{uid}>Unique Tickets</div><div class="value"{vid}>{n0(len(subset))}</div></div>'
            f'<div class="kpi"><div class="label">Share of All Unique Tickets</div><div class="value">{fnum(share)}%</div></div>'
            f'<div class="kpi"><div class="label">Duplicate Rate (this class)</div><div class="value">{fnum(dup)}%</div><div class="sub">{n0(m["D"])} duplicates</div></div>'
            f'<div class="kpi"><div class="label">Peak Ticket Month</div><div class="value">{peak_label}</div><div class="sub">{n0(peak_val)} tickets</div></div></div>')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand-index", type=int, required=True)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--refresh-nps", action="store_true",
                        help="Re-query the NPS tables instead of reusing data/<brand>_nps_cache.json. "
                             "Only the dedicated 3 AM IST schedule passes this (see refresh.yml); the "
                             "2 PM refresh and the site's Refresh-now button both reuse the cache.")
    args = parser.parse_args()

    b = BRANDS[args.brand_index]
    col = b["col"]
    ctx = Ctx(b)
    # Carried on ctx rather than threaded through the panel builders as an argument: the
    # geo source reached from deep inside assemble_report (gen_geo_insights, via
    # build_geo_script and gen_monthly's narrative movers) is the only consumer, and every
    # other cross-cutting run input already travels this way.
    ctx.quick = args.quick
    out_path = REPO_ROOT / b["out_file"]

    # Per-stage timings. This job's cost was previously only visible as one ~80s "Regenerate
    # reports" step, which is not enough to tell a slow MySQL pull from slow Sheets calls from
    # slow HTML assembly - i.e. not enough to know what's worth optimising. flush=True because
    # CI captures stdout through a pipe, so without it every line lands in the log at the same
    # timestamp and the ordering/timing is lost.
    _lap_t = [time.perf_counter()]

    def lap(label):
        now = time.perf_counter()
        print(f"[{b['brand']}] +{now - _lap_t[0]:5.1f}s  {label}", flush=True)
        _lap_t[0] = now
    # Single source of truth for "now" (IST) - shared by the footer/header timestamp and the
    # Daily Analysis narrative's "yesterday" calculation, so both agree on what day it is.
    ctx.now_ist = datetime.now(timezone.utc) + timedelta(hours=5.5)

    report_cache_file = os.environ.get("REPORT_CACHE_FILE")
    if report_cache_file and Path(report_cache_file).exists():
        print(f"[{b['brand']}] loading main rows from cache {report_cache_file}")
        with open(report_cache_file, "r", encoding="utf-8-sig") as f:
            data_rows = json.load(f)
    else:
        # Settled months (everything before the current, still-moving 30-day window) come from
        # the CLS_KYC_mCaff/CLS_KYC_Hyphen MySQL tables - a column-for-column mirror of this
        # same sheet (see kyc_source.py) - instead of a live Sheets pull. Only the last ~30 days
        # are ever fetched live from the sheet, regardless of trigger (button or schedule); the
        # secondary/legacy sheet is no longer read at all. Settled months are never re-fetched
        # from Sheets - if the MySQL mirror isn't reachable, this fails loudly instead of
        # silently falling back to a live re-fetch.
        target_months = [b["months"][-1]]
        kyc_table = b.get("kyc_mysql_table")
        settled_rows = kyc_source.fetch_settled_rows(kyc_table, b["kyc_mysql_columns"], target_months) if kyc_table else None
        if settled_rows is None:
            raise RuntimeError(
                f"[{b['brand']}] MySQL settled-row source ({kyc_table}) unavailable - refusing to "
                "fall back to a live Sheets re-fetch of settled months. Check MYSQL_* credentials."
            )
        lap(f"MySQL settled rows ({len(settled_rows)} from {kyc_table})")
        # Reads a generous trailing window of the live sheet (by the sheet's own row count, not
        # settled_rows' count - the MySQL mirror's row count doesn't necessarily line up with
        # the primary sheet's own row numbering) and keeps only the target month from it.
        buffer_rows = 25000
        fresh_rows = lib.get_sheet_tail_for_months(b["spreadsheet_id"], b["sheet_name"], b["last_col"],
                                                    buffer_rows, col["month"], target_months)
        data_rows = settled_rows + fresh_rows
        lap(f"Sheets last-30-days tail ({len(fresh_rows)} rows)")
    data_rows = [list(r) if isinstance(r, list) else r for r in data_rows]

    print(f"[{b['brand']}] fetched {len(data_rows)} rows; fetching small tabs...")
    small_tabs_cache_path = REPO_ROOT / f"data/{b['brand']}_smalltabs_cache.json"
    if args.quick and small_tabs_cache_path.exists():
        print(f"[{b['brand']}] quick refresh: reusing cached small tabs")
        with open(small_tabs_cache_path, "r", encoding="utf-8-sig") as f:
            cache = json.load(f)
        agent_hist, ai_hist = cache["agent"], cache["ai"]
    else:
        agent_hist = lib.get_sheet_values(b["spreadsheet_id"], b["small_tabs"]["agent"])
        ai_hist = lib.get_sheet_values(b["spreadsheet_id"], b["small_tabs"]["ai"])
        with open(small_tabs_cache_path, "w", encoding="utf-8") as f:
            json.dump({"agent": agent_hist, "ai": ai_hist}, f, separators=(",", ":"))

    # NPS - Overall / NPS - Product come from MySQL (mcaff_dwh.nps_delivery / nps_product, see
    # nps_source.py), but are queried on ONE schedule a day rather than on every refresh: both
    # tables lack an index on `brand` (only their primary key exists), so each query is a full
    # scan costing ~10-15s per brand whenever the server's buffer pool has gone cold - a real
    # cost to pay on a run whose point is to pick up the last 30 days of tickets, given survey
    # NPS barely moves within a day. Only the 3 AM IST schedule passes --refresh-nps; the 2 PM
    # refresh and the site's Refresh-now button reuse this cache (committed to the repo, same
    # convention as the smalltabs/rtoconv caches).
    #
    # Jan'26/Feb'26 are patched from the old sheet tabs before caching: those two months hold
    # 13/16 responses in MySQL against the sheet's 1,987/2,660, which renders as a meaningless
    # spike/dip. Everything else, including the pre-Jan'26 history the sheet never carried,
    # stays MySQL-sourced. The cache stores the already-patched result, so a cached run needs
    # neither MySQL nor the sheet's MoM/PRODUCT NPS tabs at all.
    NPS_SHEET_OVERRIDE_MONTHS = {(2026, 1), (2026, 2)}
    nps_cache_path = REPO_ROOT / f"data/{b['brand']}_nps_cache.json"
    if not args.refresh_nps and nps_cache_path.exists():
        print(f"[{b['brand']}] reusing cached NPS (pass --refresh-nps to re-query)")
        with open(nps_cache_path, "r", encoding="utf-8-sig") as f:
            nps_cache = json.load(f)
        mom, prodnps = nps_cache["mom"], nps_cache["prodnps"]
        # Older caches predate the "Product wise NPS" tab and won't have this key yet -
        # backfill just that piece rather than forcing a full re-query of mom/prodnps too.
        # Caches from before the per-month breakdown (Year filter + heatmap) also lack each
        # row's "months" dict - re-query on those too, since there's no way to derive the
        # month-level split back out of the old lifetime-only aggregate.
        prodwise_nps = nps_cache.get("prodwise_nps")
        if prodwise_nps and "months" not in prodwise_nps[0]:
            prodwise_nps = None
        # Cache built before the Apr-2026 cutoff will have pre-2026-04 month keys - re-query.
        if prodwise_nps and any(ym < "2026-04" for r in prodwise_nps for ym in r.get("months", {})):
            prodwise_nps = None
        if prodwise_nps is None:
            print(f"[{b['brand']}] no cached product-wise NPS (or stale pre-Apr-2025 cache) yet, querying...")
            prodwise_nps = nps_source.fetch_product_wise_nps(b["nps_mysql_brand"])
            nps_cache["prodwise_nps"] = prodwise_nps
            with open(nps_cache_path, "w", encoding="utf-8") as f:
                json.dump(nps_cache, f, separators=(",", ":"))
        # Older caches predate the "Top Rated Area" breakdown, or predate its switch from a
        # single-choice count to the five per-question CSAT columns (old cache shape has no
        # "months" key on each row) - same backfill-in-place idea either way.
        top_rated_area = nps_cache.get("top_rated_area")
        if top_rated_area and "months" not in top_rated_area[0]:
            top_rated_area = None
        if top_rated_area is None:
            print(f"[{b['brand']}] no cached top-rated-area breakdown yet, querying...")
            top_rated_area = nps_source.fetch_top_rated_area_by_month(b["nps_mysql_brand"])
            nps_cache["top_rated_area"] = top_rated_area
            with open(nps_cache_path, "w", encoding="utf-8") as f:
                json.dump(nps_cache, f, separators=(",", ":"))
    else:
        reason = "--refresh-nps" if args.refresh_nps else "no cache yet"
        print(f"[{b['brand']}] querying NPS tables ({reason})...")
        sheet_mom = lib.get_sheet_values(b["spreadsheet_id"], b["nps_override_tabs"]["mom"])
        sheet_prodnps = lib.get_sheet_values(b["spreadsheet_id"], b["nps_override_tabs"]["prodnps"])
        mom = nps_source.override_months_from_sheet(
            nps_source.fetch_delivery_nps(b["nps_mysql_brand"]), sheet_mom, NPS_SHEET_OVERRIDE_MONTHS)
        prodnps = nps_source.override_months_from_sheet(
            nps_source.fetch_product_nps(b["nps_mysql_brand"]), sheet_prodnps, NPS_SHEET_OVERRIDE_MONTHS)
        # Product wise NPS (per product name, not per month) - no sheet override, MySQL-only.
        prodwise_nps = nps_source.fetch_product_wise_nps(b["nps_mysql_brand"])
        # Top Rated Area breakdown (per-question CSAT %positive by month) - also no sheet override, MySQL-only.
        top_rated_area = nps_source.fetch_top_rated_area_by_month(b["nps_mysql_brand"])
        nps_cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(nps_cache_path, "w", encoding="utf-8") as f:
            json.dump({"mom": mom, "prodnps": prodnps, "prodwise_nps": prodwise_nps, "top_rated_area": top_rated_area}, f, separators=(",", ":"))

    rtoconv_cache_path = REPO_ROOT / f"data/{b['brand']}_rtoconv_cache.json"
    if args.quick and rtoconv_cache_path.exists():
        print(f"[{b['brand']}] quick refresh: reusing cached RTO-Conversion data")
        with open(rtoconv_cache_path, "r", encoding="utf-8-sig") as f:
            rto_conv_rows = json.load(f)
    else:
        print(f"[{b['brand']}] fetching RTO-Conversion data ('Sales per month'!{b['rto_conv_range']})...")
        rto_conv_rows = lib.get_sheet_values(b["spreadsheet_id"], f"'Sales per month'!{b['rto_conv_range']}")
        with open(rtoconv_cache_path, "w", encoding="utf-8") as f:
            json.dump(rto_conv_rows, f, separators=(",", ":"))
    ctx.rto_conv_rows = rto_conv_rows
    lap("small tabs + RTO-Conversion")

    # Agent/AI CSAT comes straight from the sheet's own AGENT/AI tabs (small_tabs above) -
    # no MySQL involved.
    agent, ai = agent_hist, ai_hist

    ctx.data_rows = data_rows
    ctx.mom, ctx.prodnps, ctx.prodwise_nps, ctx.top_rated_area_by_month, ctx.agent, ctx.ai = mom, prodnps, prodwise_nps, top_rated_area, agent, ai
    ctx.months = b["months"]
    ctx.n = len(ctx.months)
    # ctx.months is a list, and nearly every per-row loop in the panel builders needs the
    # row's month as an index into it. Done as `mo in months` + `months.index(mo)` that was
    # two linear scans of the month list per row; this makes it one hash lookup.
    ctx.month_index = index_map(ctx.months)
    ctx.distinct_years = sorted({year_of(mo) for mo in ctx.months if year_of(mo)})
    ctx.unique = [r for r in data_rows if ctx.cell(r, col["uniq"]) == "Unique"]
    # Bucketed once here because every consumer used to re-derive its own
    # `[r for r in ctx.unique if cell(r, cls) == key]`: the KPI row, the cross-filter panel,
    # the class panel, gen_weekly's two blocks, gen_geo_insights and gen_monthly's four
    # period views each made a full pass over all unique rows - ~10 scans per class.
    # Buckets keep ctx.unique's own order, so every consumer sees the same row sequence the
    # list comprehension gave it.
    ctx.unique_by_class = {}
    for r in ctx.unique:
        ctx.unique_by_class.setdefault(ctx.cell(r, col["cls"]), []).append(r)

    # Delivery-only Order Month axis (Ticket/Order Month toggle) - built from the distinct
    # order_month values actually on Delivery rows, NOT reused from ctx.months: order_month
    # isn't guaranteed to fall inside that hardcoded per-brand ticket-month window (an order
    # can predate the report's tracked range). Sorted chronologically via parse_month_label;
    # anything unparseable is dropped rather than crashing the sort.
    #
    # Capped to the most recent 6 - left unbounded, this pulled in every order_month value
    # ever seen (potentially years of order history), and any one of those months not
    # already in data/<brand>_geo_orders_cache.json costs a live ~20-35s MySQL query (see
    # gen_geo_insights._order_counts_by_month_cached). Confirmed in production: mCaffeine's
    # "assemble: delivery panel" stage alone ran 523s (vs ~1s) the first time this shipped,
    # and got canceled before it could even finish - so nothing was cached for next time
    # either. 6 months keeps the new-query cost bounded and one-time (settled months stay
    # cached from then on) while still covering the window ops actually look at.
    delivery_rows = ctx.unique_by_class.get("Delivery", [])
    om_col = col.get("order_month")
    distinct_order_months = {ctx.cell(r, om_col) for r in delivery_rows} if om_col is not None else set()
    distinct_order_months = {m for m in distinct_order_months if str(m).strip() and parse_month_label(m)}
    ctx.delivery_order_months = sorted(distinct_order_months, key=parse_month_label)[-6:]
    ctx.delivery_order_month_index = index_map(ctx.delivery_order_months)

    ctx.sales_m = get_sales_m_by_month(ctx, data_rows)
    ctx.sales_arr = [ctx.sales_m.get(mo, 0) for mo in ctx.months]

    # ---------- Weekly period derivation (native Week / Total Sales W columns) ----------
    gen_weekly.setup(ctx)
    lap("row indexing + weekly setup")

    # ---------- Overview ----------
    def count_by_month(subset):
        d = {}
        for r in subset:
            mo = ctx.cell(r, col["month"])
            if not str(mo).strip():
                continue
            d[mo] = d.get(mo, 0) + 1
        return d
    ctx.count_by_month = count_by_month

    ctx.total_rows = len(data_rows)
    ctx.total_unique = len(ctx.unique)
    total_dup = ctx.total_rows - ctx.total_unique
    ov = [f'<div class="kpi-row"><div class="kpi"><div class="label">Total Rows</div><div class="value">{n0(ctx.total_rows)}</div></div>'
          f'<div class="kpi"><div class="label">Unique Tickets</div><div class="value">{n0(ctx.total_unique)}</div></div>'
          f'<div class="kpi"><div class="label">Duplicate Rows</div><div class="value">{n0(total_dup)}</div></div>'
          f'<div class="kpi"><div class="label">Overall Duplicate Rate</div><div class="value">{fnum(round1(total_dup/ctx.total_rows*100) if ctx.total_rows else 0)}%</div></div></div>']
    ov.append(gen_raw_export.raw_download_link(ctx, "overview"))
    uniq_class_month = build_class_month_counts(ctx, ctx.unique)
    ov.append("<div class='gran-monthly'>")
    ov.append(build_pivot(ctx, "Overall Query Class-Wise Comparison", build_class_month_counts(ctx, data_rows)))
    ov.append(build_pivot(ctx, "Unique Query Class-Wise Comparison", uniq_class_month))
    ov.append(build_pct_trend_chart(ctx, "Unique Query Class % Trend", uniq_class_month))
    ov.append('<p class="note">Count = tickets that month for that query class. Percent = count &divide; that month\'s total order volume ("Total Sales M"). "Overall" includes duplicates; "Unique" excludes them.</p>')
    ov.append("</div>")

    # ---------- KPI helpers ----------
    class_dup = {}
    for r in data_rows:
        c = ctx.cell(r, col["cls"])
        if not str(c).strip():
            c = "(blank)"
        f_ = ctx.cell(r, col["uniq"])
        class_dup.setdefault(c, {"U": 0, "D": 0})
        if f_ == "Unique":
            class_dup[c]["U"] += 1
        elif f_ == "Duplicate":
            class_dup[c]["D"] += 1
    ctx.class_dup = class_dup
    ctx.kpi_row = lambda cls, subset: kpi_row(ctx, cls, subset)

    ov.append(build_insights_card_overview(ctx, uniq_class_month))
    ov.append(build_business_kpi_insights_table(ctx))
    ctx.overview_html = "".join(ov)

    gen_monthly.setup(ctx)
    lap("build panels")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    gen_raw_export.build_raw_exports(ctx, out_path.parent)
    lap("raw-data exports (gzipped CSVs)")

    html = gen_panels.assemble_report(ctx, HERE, lap=lap)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    size_kb = round(out_path.stat().st_size / 1024)
    lap(f"assemble + write HTML ({size_kb} KB)")

    # Aggregate-only facts for the cross-brand Org_KYC_Trends digest (see
    # gen_digest_facts.py) - a side output of this same run rather than a separate
    # Sheets/MySQL pull, since ctx already holds everything it needs at this point.
    facts_path = REPO_ROOT / f"data/{b['brand']}_digest_facts.json"
    gen_digest_facts.write_facts(ctx, facts_path)
    lap(f"digest facts ({round(facts_path.stat().st_size / 1024)} KB)")


def build_insights_card_overview(ctx, uniq_class_month):
    from gen_insights import build_insights_card, get_overview_insight_items
    return build_insights_card("Insights &mdash; Overview", get_overview_insight_items(ctx, uniq_class_month))


# Hand-curated from the "D2C Business Overview" monthly PDF decks (O2D/RTO/SPCD/warehouse/
# logistics KPIs) - a separate manual deliverable, not derived from this report's own
# ticket-sheet data, so there's no sheet column to compute these from. Update by hand each
# month as a new deck comes in.
_BUSINESS_KPI_INSIGHTS = {
    "mcaffeine": [
        ("May 2026", [
            "O2D closed at 2.97d vs 2.84d target &mdash; SPCD/RU dip driven by Take-a-Dip Bodywash &amp; Hair Spray SKUs.",
            "RTO + Cancellation at 13.20%, NDR Conversion down ~3% vs April.",
            "Warehouse hit by election manpower shortages (Kolkata, Guwahati) and Mumbai planning errors (6th &amp; 31st May).",
            "Elasticrun performance fell from ~96% to ~86% in the first two weeks (Mumbai, Ahmedabad, Jaipur worst-hit).",
        ], [
            ("Wk18 (27 Apr-3 May)", "1,01,095", "12.70%", "3.18", "87.77%", "88.20%"),
            ("Wk19 (4-10 May)", "46,500", "12.00%", "3.29", "85.85%", "82.03%"),
            ("Wk20 (11-17 May)", "86,087", "12.00%", "2.89", "92.64%", "92.70%"),
            ("Wk21 (18-24 May)", "51,852", "14.10%", "2.79", "91.73%", "93.29%"),
            ("Wk22 (25-31 May)", "91,378", "14.00%", "2.74", "96.54%", "98.64%"),
        ]),
        ("June 2026", [
            "O2D closed at 2.93d vs 2.88d target &mdash; weak first half (same SKU issue) recovered sharply from 11 June.",
            "RTO + Cancellation eased slightly to 12.10% from May's 13.20%, but FASR stayed below the 80% benchmark all month.",
            "Guwahati worst-performing warehouse all month (DTDC device/manifestation issue at pickup).",
            "Xpressbees (76.00% SLA) and Delhivery (81.30%) weakest couriers, both hit by monsoon in the southern belt.",
        ], [
            ("Wk23 (1-7 Jun)", "1,26,467", "13.70%", "3.18", "88.09%", "81.20%"),
            ("Wk24 (8-14 Jun)", "41,074", "13.60%", "2.99", "86.60%", "87.00%"),
            ("Wk25 (15-21 Jun)", "90,976", "11.70%", "2.76", "94.40%", "96.30%"),
            ("Wk26 (22-28 Jun)", "53,312", "12.80%", "2.60", "94.50%", "93.70%"),
        ]),
        ("July 2026", [
            "O2D closed at 2.93d, marginally above the 2.91d target &mdash; Wk28 worst (Mumbai warehouse closed for waterlogging), recovered by Wk30.",
            "RU (90.80%) and SPCD&lt;3hrs (90.80%) both closed below target; Take-a-Dip Bodywash &amp; Hair Spray remained the SKU drivers.",
            "RTO + Cancellation rose to ~14.20%, NDR Conversion fell to 58.50% &mdash; COD NDRs increasingly converting to RTO.",
            "TAT+2% rose to 4.70%; Xpressbees the largest contributor despite remaining the preferred allocation partner (highest FASR).",
        ], [
            ("Wk27 (29 Jun-5 Jul)", "1,10,831", "13.80%", "2.94", "92.10%", "86.10%"),
            ("Wk28 (6-12 Jul)", "53,556", "14.40%", "3.14", "86.80%", "83.70%"),
            ("Wk29 (13-19 Jul)", "96,560", "13.30%", "2.86", "91.70%", "94.30%"),
            ("Wk30 (20-26 Jul)", "35,850", "10.50%", "2.79", "91.80%", "95.10%"),
            ("Wk31 (27 Jul-02 Aug)", "14,495", "2.80%", "2.84", "91.60%", "94.60%"),
        ]),
    ],
    "hyphen": [
        ("May 2026", [
            "O2D closed at 2.72d vs 2.63d target &mdash; RU delay (+0.18d) driven by the ADP Dual Phase SKU.",
            "RTO + Cancellation rose to 8.60% from 6.53% in April, driven by higher NDR%.",
            "Rapid Commerce launched in May (~50% of volume) but averaged only ~50% performance, limiting O2D gains.",
            "Warehouse impacted in Guwahati, Kolkata, Mumbai in Wk18-19 (elections + sale-period planning issues).",
        ], [
            ("Wk18 (27 Apr-3 May)", "1,35,286", "8.60%", "2.76", "95.71%", "97.20%"),
            ("Wk19 (4-10 May)", "1,27,717", "8.20%", "2.79", "93.55%", "96.85%"),
            ("Wk20 (11-17 May)", "48,824", "8.60%", "2.68", "95.23%", "97.26%"),
            ("Wk21 (18-24 May)", "45,507", "8.60%", "2.52", "96.94%", "98.27%"),
            ("Wk22 (25-31 May)", "48,259", "7.00%", "2.61", "96.33%", "96.88%"),
        ]),
        ("June 2026", [
            "O2D improved to 2.62d, beating the 2.68d target &mdash; RU delay nearly disappeared as the ADP Dual Phase issue resolved.",
            "RTO + Cancellation kept rising to 9.40% (from 8.60% in May) &mdash; the one metric moving the wrong way even as O2D improved.",
            "Total order volume dropped sharply to 2.16L vs 3.75L in May and 3.57L in April.",
            "Guwahati (94.20%) and Hyderabad (95.90%) remained the weakest warehouses, same drivers as Mcaffeine.",
        ], [
            ("Wk23 (1-7 Jun)", "53,460", "8.90%", "2.63", "94.40%", "98.00%"),
            ("Wk24 (8-14 Jun)", "52,696", "9.00%", "2.61", "95.10%", "96.80%"),
            ("Wk25 (15-21 Jun)", "45,688", "9.90%", "2.59", "96.80%", "96.30%"),
            ("Wk26 (22-28 Jun)", "48,122", "10.40%", "2.52", "95.90%", "98.70%"),
            ("29-30 Jun", "16,234", "1.50%", "1.43", "97.30%", "96.80%"),
        ]),
        ("July 2026", [
            "O2D on track at 2.65d, in line with the 2.63d target &mdash; delay tightly controlled across every component.",
            "RTO + Cancellation eased slightly to 9.10% from June's 9.40%; FASR improved marginally to 81.60%.",
            "RU (95.10%) and SPCD&lt;3hrs (96.40%) marginally below target &mdash; ADP Dual Phase SKU still the primary driver.",
            "Bangalore warehouse share rising fast to 23.00% &mdash; flagged as the key capacity watch item for August.",
        ], [
            ("Wk27 (29 Jun-5 Jul)", "56,623", "10.00%", "2.66", "97.20%", "96.50%"),
            ("Wk28 (6-12 Jul)", "51,803", "10.50%", "2.73", "94.30%", "93.20%"),
            ("Wk29 (13-19 Jul)", "50,106", "9.60%", "2.60", "95.10%", "97.30%"),
            ("Wk30 (20-26 Jul)", "43,992", "9.50%", "2.39", "94.90%", "99.20%"),
            ("Wk31 (27 Jul-2 Aug)", "1,61,460", "7.40%", "1.39", "93.70%", "98.00%"),
        ]),
    ],
}


_BIZ_KPI_STYLE = """<style>
  .biz-kpi{background:var(--surface-card);border:1px solid var(--border);border-radius:14px;padding:18px clamp(14px,3vw,22px) 6px;margin:4px 0 32px;max-width:100%;}
  .biz-kpi h3{font-size:12px;margin:0 0 14px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);font-weight:700;}
  .biz-kpi-month{padding:14px 0;border-top:1px solid var(--border);}
  .biz-kpi-month:first-of-type{border-top:none;padding-top:0;}
  .biz-kpi-month summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;margin-bottom:10px;}
  .biz-kpi-month summary::-webkit-details-marker{display:none;}
  .biz-kpi-month summary::marker{content:'';}
  .biz-kpi-month-label{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;color:var(--text-primary);background:var(--active-bg,rgba(74,58,167,.08));padding:3px 10px;border-radius:999px;}
  .biz-kpi-chev{font-size:9px;color:var(--text-muted);transition:transform .15s ease;}
  .biz-kpi-month[open] .biz-kpi-chev{transform:rotate(180deg);}
  .biz-kpi-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;}
  .biz-kpi-list li{position:relative;padding-left:17px;font-size:13px;line-height:1.55;color:var(--text-secondary);}
  .biz-kpi-list li::before{content:'';position:absolute;left:0;top:7px;width:6px;height:6px;border-radius:50%;background:var(--s1);}
  .biz-week-scroll{display:flex;gap:10px;overflow-x:auto;margin:14px 0 4px;padding-bottom:6px;}
  .biz-week-card{flex:0 0 138px;background:var(--page);border:1px solid var(--border);border-radius:10px;padding:10px 12px;}
  .biz-week-hdr{font-size:10px;font-weight:700;color:var(--text-muted);margin-bottom:8px;white-space:nowrap;}
  .biz-week-stat{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--text-secondary);padding:2px 0;}
  .biz-week-stat b{color:var(--text-primary);font-weight:600;}
</style>"""

_WEEK_STAT_LABELS = ("Orders", "RTO+Canc", "O2D", "RU", "SPCD<3h")


def build_business_kpi_insights_table(ctx):
    months = _BUSINESS_KPI_INSIGHTS.get(ctx.b["brand"])
    if not months:
        return ""
    blocks = []
    for mi, (month, bullets, weeks) in enumerate(months):
        items = "".join(f"<li>{b}</li>" for b in bullets)
        cards = []
        for week_label, *stats in weeks:
            stat_rows = "".join(f"<div class='biz-week-stat'><span>{lbl}</span><b>{h_enc(v)}</b></div>" for lbl, v in zip(_WEEK_STAT_LABELS, stats))
            cards.append(f"<div class='biz-week-card'><div class='biz-week-hdr'>{h_enc(week_label)}</div>{stat_rows}</div>")
        open_attr = " open" if mi == len(months) - 1 else ""
        blocks.append(
            f"<details class='biz-kpi-month'{open_attr}><summary><span class='biz-kpi-month-label'>{h_enc(month)}</span>"
            f"<span class='biz-kpi-chev'>&#9662;</span></summary><ul class='biz-kpi-list'>{items}</ul>"
            f"<div class='biz-week-scroll'>{''.join(cards)}</div></details>"
        )
    return f"<div class='biz-kpi'><h3>Business KPI Insights &mdash; D2C Monthly Report</h3>{''.join(blocks)}</div>{_BIZ_KPI_STYLE}"


if __name__ == "__main__":
    main()
