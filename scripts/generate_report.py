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

import gen_monthly
import gen_panels
import gen_raw_export
import gen_weekly
import kyc_source
import lib
import nps_source
from brands import BRANDS
from report_context import Ctx, ci_key, fnum, h_enc, n0, pretty_month, round1, year_of

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
    else:
        reason = "--refresh-nps" if args.refresh_nps else "no cache yet"
        print(f"[{b['brand']}] querying NPS tables ({reason})...")
        sheet_mom = lib.get_sheet_values(b["spreadsheet_id"], b["nps_override_tabs"]["mom"])
        sheet_prodnps = lib.get_sheet_values(b["spreadsheet_id"], b["nps_override_tabs"]["prodnps"])
        mom = nps_source.override_months_from_sheet(
            nps_source.fetch_delivery_nps(b["nps_mysql_brand"]), sheet_mom, NPS_SHEET_OVERRIDE_MONTHS)
        prodnps = nps_source.override_months_from_sheet(
            nps_source.fetch_product_nps(b["nps_mysql_brand"]), sheet_prodnps, NPS_SHEET_OVERRIDE_MONTHS)
        nps_cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(nps_cache_path, "w", encoding="utf-8") as f:
            json.dump({"mom": mom, "prodnps": prodnps}, f, separators=(",", ":"))

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
    ctx.mom, ctx.prodnps, ctx.agent, ctx.ai = mom, prodnps, agent, ai
    ctx.months = b["months"]
    ctx.n = len(ctx.months)
    ctx.distinct_years = sorted({year_of(mo) for mo in ctx.months if year_of(mo)})
    ctx.unique = [r for r in data_rows if ctx.cell(r, col["uniq"]) == "Unique"]

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

    ov.append(gen_weekly.build_weekly_overview_block(ctx))
    ov.append(build_insights_card_overview(ctx, uniq_class_month))
    ctx.overview_html = "".join(ov)

    gen_monthly.setup(ctx)
    lap("build panels")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    gen_raw_export.build_raw_exports(ctx, out_path.parent)
    lap("raw-data exports (gzipped CSVs)")

    html = gen_panels.assemble_report(ctx, HERE)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    size_kb = round(out_path.stat().st_size / 1024)
    lap(f"assemble + write HTML ({size_kb} KB)")


def build_insights_card_overview(ctx, uniq_class_month):
    from gen_insights import build_insights_card, get_overview_insight_items
    return build_insights_card("Insights &mdash; Overview", get_overview_insight_items(ctx, uniq_class_month))


if __name__ == "__main__":
    main()
