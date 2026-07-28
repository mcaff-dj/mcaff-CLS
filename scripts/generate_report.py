#!/usr/bin/env python3
"""Config-driven report generator. Fetches a brand's sheet data and produces the full
self-contained <brand>.html at the repo root. Python port of Generate-Report.ps1.

Usage: python generate_report.py --brand-index 0 [--quick]
"""
import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import csat_source
import gen_monthly
import gen_panels
import gen_raw_export
import gen_weekly
import kyc_source
import lib
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
    args = parser.parse_args()

    b = BRANDS[args.brand_index]
    col = b["col"]
    ctx = Ctx(b)
    out_path = REPO_ROOT / b["out_file"]
    # Single source of truth for "now" (IST) - shared by the footer/header timestamp and the
    # Daily Analysis narrative's "yesterday" calculation, so both agree on what day it is.
    ctx.now_ist = datetime.now(timezone.utc) + timedelta(hours=5.5)

    report_cache_file = os.environ.get("REPORT_CACHE_FILE")
    if report_cache_file and Path(report_cache_file).exists():
        print(f"[{b['brand']}] loading main rows from cache {report_cache_file}")
        with open(report_cache_file, "r", encoding="utf-8-sig") as f:
            data_rows = json.load(f)
    else:
        # Settled months (everything but the still-moving target window) come from the
        # CLS_KYC_mCaff/CLS_KYC_Hyphen MySQL tables - a column-for-column mirror of this same
        # sheet (see kyc_source.py) - instead of a live Sheets pull; only the target window
        # itself is fetched live. The "Refresh data now" button (workflow_dispatch) only needs
        # the last ~30 days, so it refetches just the latest month live; the scheduled daily
        # run (schedule event) still refetches 3 months. Falls back to the old sheet-only
        # incremental cache if MySQL credentials aren't configured.
        target_months = [b["months"][-1]] if args.quick else b["months"][-3:]
        primary_cache_path = REPO_ROOT / f"data/{b['brand']}_primary_cache.json"
        kyc_table = b.get("kyc_mysql_table")
        settled_rows = kyc_source.fetch_settled_rows(kyc_table, b["kyc_mysql_columns"], target_months) if kyc_table else None
        settled_from_mysql = settled_rows is not None
        if settled_from_mysql:
            print(f"[{b['brand']}] loaded {len(settled_rows)} settled rows from {kyc_table}; "
                  f"fetching {len(target_months)} live month(s) from the sheet...")
            # Reads a generous trailing window of the live sheet (by the sheet's own row
            # count, not settled_rows' count - the MySQL mirror can fold in rows the primary
            # tab alone doesn't carry, e.g. a merged secondary/legacy sheet, so its row count
            # doesn't line up with the primary sheet's own row numbering) and keeps only the
            # target month(s) from it.
            fresh_rows = lib.get_sheet_tail_for_months(b["spreadsheet_id"], b["sheet_name"], b["last_col"],
                                                        20000, col["month"], target_months)
            data_rows = settled_rows + fresh_rows
            primary_cache_path.parent.mkdir(parents=True, exist_ok=True)
            with open(primary_cache_path, "w", encoding="utf-8") as f:
                json.dump(data_rows, f, separators=(",", ":"))
        else:
            print(f"[{b['brand']}] MySQL unavailable - falling back to the sheet-only incremental cache "
                  f"(last {len(target_months)} month(s) live, rest from cache)...")
            data_rows = lib.get_sheet_rows_incremental(b["spreadsheet_id"], b["sheet_name"], b["last_col"],
                                                        primary_cache_path, col["month"], target_months)
    data_rows = [list(r) if isinstance(r, list) else r for r in data_rows]

    # Older KYC raw-dump sheet covering months the primary sheet doesn't (see brands.py).
    # Its Last Source Type / Parent Order columns are swapped vs the primary sheet, so each
    # kept row is realigned before merging; months that overlap with the primary sheet are
    # skipped there to avoid double-counting the same period from two different systems.
    # Its Unique column also uses a different convention: a numeric duplicate-rank ("1","2",...)
    # instead of the primary sheet's literal "Unique"/"Duplicate" strings, so every downstream
    # `== "Unique"` check (KPI cards, per-category tables) silently dropped these rows until
    # the value is normalized here (rank "1" -> "Unique", everything else -> "Duplicate").
    #
    # Skipped entirely when settled_rows came from MySQL above: CLS_KYC_mCaff's settled months
    # already carry this sheet's contribution pre-merged and pre-normalized (verified against
    # its per-month row counts and unique_flag values before wiring this in) - merging it again
    # here would double-count every settled-month row it contributes.
    if "secondary" in b and not settled_from_mysql:
        # The quick (button-triggered) refresh only needs the primary sheet's latest month, so
        # it reuses whatever secondary-sheet snapshot the last full refresh saved instead of
        # re-pulling all ~71k rows live.
        secondary_cache_path = REPO_ROOT / f"data/{b['brand']}_secondary_cache.json"
        if args.quick and secondary_cache_path.exists():
            print(f"[{b['brand']}] quick refresh: reusing cached secondary sheet")
            with open(secondary_cache_path, "r", encoding="utf-8-sig") as f:
                sec_rows = json.load(f)
        else:
            print(f"[{b['brand']}] fetching secondary sheet ({b['secondary']['spreadsheet_id']})...")
            sec_rows = lib.get_sheet_rows_chunked(b["secondary"]["spreadsheet_id"], b["secondary"]["sheet_name"], b["secondary"]["last_col"])
            with open(secondary_cache_path, "w", encoding="utf-8") as f:
                json.dump(sec_rows, f, separators=(",", ":"))
        swap_a, swap_b = b["secondary"]["swap_cols"]
        exclude = b["secondary"]["exclude_months"]
        kept_count = 0
        for r in sec_rows:
            mo = ctx.cell(r, col["month"])
            if mo in exclude:
                continue
            row = list(r)
            if swap_a < len(row) and swap_b < len(row):
                row[swap_a], row[swap_b] = row[swap_b], row[swap_a]
            if col["uniq"] < len(row):
                row[col["uniq"]] = "Unique" if str(ctx.cell(row, col["uniq"])).strip() == "1" else "Duplicate"
            data_rows.append(row)
            kept_count += 1
        print(f"[{b['brand']}] secondary sheet: {len(sec_rows)} rows fetched, {kept_count} kept after excluding overlapping months")

    print(f"[{b['brand']}] fetched {len(data_rows)} rows; fetching small tabs...")
    small_tabs_cache_path = REPO_ROOT / f"data/{b['brand']}_smalltabs_cache.json"
    if args.quick and small_tabs_cache_path.exists():
        print(f"[{b['brand']}] quick refresh: reusing cached small tabs")
        with open(small_tabs_cache_path, "r", encoding="utf-8-sig") as f:
            cache = json.load(f)
        mom, prodnps, agent_hist, ai_hist = cache["mom"], cache["prodnps"], cache["agent"], cache["ai"]
    else:
        mom = lib.get_sheet_values(b["spreadsheet_id"], b["small_tabs"]["mom"])
        prodnps = lib.get_sheet_values(b["spreadsheet_id"], b["small_tabs"]["prodnps"])
        agent_hist = lib.get_sheet_values(b["spreadsheet_id"], b["small_tabs"]["agent"])
        ai_hist = lib.get_sheet_values(b["spreadsheet_id"], b["small_tabs"]["ai"])
        with open(small_tabs_cache_path, "w", encoding="utf-8") as f:
            json.dump({"mom": mom, "prodnps": prodnps, "agent": agent_hist, "ai": ai_hist}, f, separators=(",", ":"))

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

    print(f"[{b['brand']}] fetching Agent/AI CSAT from MySQL...")
    agent_mysql, ai_mysql = csat_source.fetch_agent_ai_csat(b["csat_mysql"]["csat_table"], b["csat_mysql"]["tickets_table"])
    agent = csat_source.splice_with_sheet_history(agent_hist, agent_mysql)
    ai = csat_source.splice_with_sheet_history(ai_hist, ai_mysql)

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

    print(f"[{b['brand']}] building panels...")
    ov.append(gen_weekly.build_weekly_overview_block(ctx))
    ov.append(build_insights_card_overview(ctx, uniq_class_month))
    ctx.overview_html = "".join(ov)

    gen_monthly.setup(ctx)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"[{b['brand']}] building raw-data exports...")
    gen_raw_export.build_raw_exports(ctx, out_path.parent)

    html = gen_panels.assemble_report(ctx, HERE)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    size_kb = round(out_path.stat().st_size / 1024)
    print(f"[{b['brand']}] wrote {out_path} ({size_kb} KB)")


def build_insights_card_overview(ctx, uniq_class_month):
    from gen_insights import build_insights_card, get_overview_insight_items
    return build_insights_card("Insights &mdash; Overview", get_overview_insight_items(ctx, uniq_class_month))


if __name__ == "__main__":
    main()
