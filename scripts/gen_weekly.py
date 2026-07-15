"""Weekly-granularity builders. Python port of gen-weekly.ps1, plus the "Weekly period
derivation" setup block that lived in Generate-Report.ps1 (its lines 185-230) immediately
before gen-weekly.ps1 was dot-sourced there - conceptually all weekly-derivation logic,
just split across two PowerShell files by dot-source ordering. `setup(ctx)` here does both.

Reuses the sheet's own native Week / Total Sales W columns. For each month that has real
week data, builds a week-columned variant of the Overview pivots and each (non-Delivery)
class's category pivot + chart, hidden by default; a global Monthly/Weekly toggle + month
picker (built in gen_panels.py) shows/hides the right one client-side.

Bucketing is done in a single pass per dataset (not once per month) to avoid an
O(months x rows) rescan - important since row counts run into the 100k range.
"""
import calendar
import re

from report_context import ci_key, fnum, h_enc, n0, nice_max, parse_month_label, pretty_month, round1

_week_num_re = re.compile(r"Week\s*(\d+)")


def get_week_num(week_label):
    m = _week_num_re.search(str(week_label))
    return int(m.group(1)) if m else 999


def _week_end_day(month_label, week_val):
    """The sheet buckets tickets into fixed day-ranges per week (confirmed empirically:
    Week 1 = days 1-7, Week 2 = 8-14, Week 3 = 15-21, Week 4 = 22-28, a trailing Week 5
    picks up any days beyond that) - returns (year, month, end_day) for the week's actual
    last calendar day, or None if the month label can't be parsed."""
    parsed = parse_month_label(month_label)
    if not parsed:
        return None
    year, month = parsed
    wn = get_week_num(week_val)
    days_in_month = calendar.monthrange(year, month)[1]
    end_day = min(wn * 7, days_in_month)
    return year, month, end_day


def _get_sales_w_by_week(ctx):
    tmp = {}
    for r in ctx.data_rows:
        wk_val = ctx.cell(r, ctx.col["week"])
        if not str(wk_val).strip() or wk_val == "#N/A":
            continue
        mo_lbl = ctx.cell(r, ctx.col["month"])
        sw = ctx.cell(r, ctx.col["salesW"])
        if not str(sw).strip():
            continue
        wk_key = f"{mo_lbl}||{wk_val}"
        tmp.setdefault(wk_key, {})
        tmp[wk_key][sw] = tmp[wk_key].get(sw, 0) + 1
    res = {}
    for wk_key, counts in tmp.items():
        best = max(counts.items(), key=lambda kv: kv[1])
        res[wk_key] = float(str(best[0]).replace(",", ""))
    return res


def setup(ctx):
    """Populates ctx.weeks_by_month_idx / all_weeks / week_month_of / total_weeks /
    week_start_idx / week_sales_arr / weekly_eligible_months / month_index_lookup."""
    n = ctx.n
    months = ctx.months
    weeks_by_month_idx = []
    all_weeks = []
    week_month_of = []
    for mi in range(n):
        mo_lbl = months[mi]
        wk_seen = {}
        for r in ctx.data_rows:
            if ctx.cell(r, ctx.col["month"]) != mo_lbl:
                continue
            wk_val = ctx.cell(r, ctx.col["week"])
            if not str(wk_val).strip() or wk_val == "#N/A":
                continue
            wk_seen.setdefault(wk_val, True)
        wk_ordered = sorted(wk_seen.keys(), key=get_week_num)
        weeks_by_month_idx.append(wk_ordered)
        for wk_val in wk_ordered:
            all_weeks.append(wk_val)
            week_month_of.append(mi)
    total_weeks = len(all_weeks)
    week_start_idx = []
    acc = 0
    for mi in range(n):
        week_start_idx.append(acc)
        acc += len(weeks_by_month_idx[mi])

    sales_w_lookup = _get_sales_w_by_week(ctx)
    week_sales_arr = []
    for wi in range(total_weeks):
        mi = week_month_of[wi]
        wk_key = f"{months[mi]}||{all_weeks[wi]}"
        week_sales_arr.append(sales_w_lookup.get(wk_key, 0.0))

    ctx.weeks_by_month_idx = weeks_by_month_idx
    ctx.all_weeks = all_weeks
    ctx.week_month_of = week_month_of
    ctx.total_weeks = total_weeks
    ctx.last_week_idx = total_weeks - 1
    ctx.week_start_idx = week_start_idx
    ctx.week_sales_arr = week_sales_arr

    ctx.weekly_eligible_months = [mi for mi in range(n) if len(weeks_by_month_idx[mi]) > 0]
    ctx.month_index_lookup = {months[mi]: mi for mi in range(n)}


def get_week_sales_map(ctx, month_idx):
    m = {}
    start = ctx.week_start_idx[month_idx]
    wks = ctx.weeks_by_month_idx[month_idx]
    for j, wk in enumerate(wks):
        m[wk] = ctx.week_sales_arr[start + j]
    return m


def is_partial_week(ctx, week_val, month_idx):
    if month_idx != ctx.n - 1:
        return False
    last_month_weeks = ctx.weeks_by_month_idx[month_idx]
    if not last_month_weeks or week_val != last_month_weeks[-1]:
        return False
    # It's the last week bucket the sheet happens to have data for - but that only means
    # "still in progress" if the week's actual day-range hasn't elapsed yet. The sheet can
    # lag a day or more behind on logging (see gen_monthly's Daily Analysis safeguard for
    # the same issue), which previously made an already-complete week ("Jul Week 2", days
    # 8-14, checked on the 15th) show as "(partial)" just because Week 3 hadn't been
    # logged yet.
    rng = _week_end_day(ctx.months[month_idx], week_val)
    if rng is None:
        return True  # can't verify the date range - keep the old conservative behavior
    year, month, end_day = rng
    now = ctx.now_ist
    if (now.year, now.month) != (year, month):
        return (now.year, now.month) < (year, month)
    return now.day <= end_day


def week_col_header(ctx, week_val, month_idx):
    wn = get_week_num(week_val)
    lbl = f"W{wn}"
    if is_partial_week(ctx, week_val, month_idx):
        lbl += " (partial)"
    return lbl


def get_week_buckets_all_months(ctx, rows, key_col_idx):
    by_month = [{"by_key": {}, "key_tot": {}} for _ in range(ctx.n)]
    # One cache per month bucket, matching each being an independent @{} in the original.
    key_caches = [{} for _ in range(ctx.n)]
    for r in rows:
        mo_lbl = ctx.cell(r, ctx.col["month"])
        if mo_lbl not in ctx.month_index_lookup:
            continue
        mi = ctx.month_index_lookup[mo_lbl]
        wk_val = ctx.cell(r, ctx.col["week"])
        if not str(wk_val).strip() or wk_val == "#N/A":
            continue
        k = ctx.cell(r, key_col_idx)
        if not str(k).strip():
            k = "(blank)"
        k = ci_key(k, key_caches[mi])
        bkt = by_month[mi]
        bkt["by_key"].setdefault(k, {})
        bkt["by_key"][k][wk_val] = bkt["by_key"][k].get(wk_val, 0) + 1
        bkt["key_tot"][k] = bkt["key_tot"].get(k, 0) + 1
    return by_month


def build_period_pivot(ctx, title, corner_label, row_defs, by_key_counts, week_list, week_sales_map, month_idx):
    parts = [f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(title)}</div><div class='pivot-scroll'>"
             f"<table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>{h_enc(corner_label)}</th>"]
    for wk in week_list:
        parts.append(f"<th colspan='2' class='month-hdr'>{h_enc(week_col_header(ctx, wk, month_idx))}</th>")
    parts.append("</tr><tr>")
    for _ in week_list:
        parts.append("<th class='sub-hdr'>Count</th><th class='sub-hdr'>%</th>")
    parts.append("</tr></thead><tbody>")
    totals = {}
    for ri, rd in enumerate(row_defs, start=1):
        z = "zebra" if ri % 2 == 1 else ""
        parts.append(f"<tr class='{z}'><td class='rowlabel'>{h_enc(rd['label'])}</td>")
        for wk in week_list:
            cnt = by_key_counts.get(rd["key"], {}).get(wk, 0)
            totals[wk] = totals.get(wk, 0) + cnt
            sm = week_sales_map.get(wk, 0)
            pct = round1(cnt / sm * 100) if sm > 0 else 0
            cd = n0(cnt) if cnt > 0 else "-"
            parts.append(f"<td class='num'>{cd}</td><td class='pct'>{fnum(pct)}%</td>")
        parts.append("</tr>")
    parts.append("<tr class='total-row'><td class='rowlabel'>Total</td>")
    for wk in week_list:
        t = totals.get(wk, 0)
        sm = week_sales_map.get(wk, 0)
        pct = round1(t / sm * 100) if sm > 0 else 0
        parts.append(f"<td class='num'>{n0(t)}</td><td class='pct'>{fnum(pct)}%</td>")
    parts.append("</tr></tbody></table></div></div>")
    return "".join(parts)


def build_period_chart(ctx, title, vals, week_list, week_sales_map, month_idx, bar_color, line_color):
    n = len(week_list)
    if n == 0:
        return "<div class='card'><p class='note'>No weekly data.</p></div>"
    pcts = []
    for i in range(n):
        sm = week_sales_map.get(week_list[i], 0)
        p = round(vals[i] / sm * 100, 2) if sm > 0 else 0
        pcts.append(p)
    bar_max = nice_max(max(vals) * 1.15 if vals else 0)
    pct_max = nice_max(max(pcts) * 1.2 if pcts else 0)
    W, H, pad_l, pad_r, pad_t, pad_b = 1200, 380, 55, 55, 40, 55
    plot_w, plot_h = W - pad_l - pad_r, H - pad_t - pad_b
    slot = plot_w / n
    bar_w = slot * 0.55
    parts = [f"<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>{h_enc(title)}</div>"
             f"<div class='legend-row' style='justify-content:center;'>"
             f"<div class='legend-item'><span class='swatch' style='background:{bar_color};'></span><span class='lname'>Complaints</span></div>"
             f"<div class='legend-item'><span class='swatch' style='background:{line_color};border-radius:50%;'></span><span class='lname'>wrt sales %</span></div></div>"]
    parts.append(f"<svg viewBox='0 0 {W} {H}' width='100%' height='{H}' role='img'>"
                 f"<line x1='{pad_l}' y1='{pad_t+plot_h}' x2='{W-pad_r}' y2='{pad_t+plot_h}' stroke='var(--baseline)' stroke-width='1'/>")
    pts = []
    for i in range(n):
        cx = pad_l + slot * i + slot / 2
        bx = cx - bar_w / 2
        bh = plot_h * (vals[i] / bar_max)
        by = pad_t + plot_h - bh
        parts.append(f"<rect x='{fnum(bx)}' y='{fnum(by)}' width='{fnum(bar_w)}' height='{fnum(bh)}' fill='{bar_color}' rx='2'/>"
                     f"<text x='{fnum(cx)}' y='{fnum(by-8)}' text-anchor='middle' font-size='10.5' fill='var(--text-primary)' font-weight='600'>{n0(vals[i])}</text>")
        ly = pad_t + plot_h - (plot_h * (pcts[i] / pct_max))
        pts.append(f"{fnum(cx)},{fnum(ly)}")
        ml = week_col_header(ctx, week_list[i], month_idx)
        parts.append(f"<text x='{fnum(cx)}' y='{H-pad_b+18}' text-anchor='middle' font-size='10.5' fill='var(--text-muted)'>{ml}</text>")
    parts.append(f"<polyline points='{' '.join(pts)}' fill='none' stroke='{line_color}' stroke-width='2'/>")
    for i in range(n):
        cx_s, cy_s = pts[i].split(",")
        parts.append(f"<circle cx='{cx_s}' cy='{cy_s}' r='3' fill='{line_color}'/>"
                     f"<text x='{cx_s}' y='{fnum(float(cy_s)-10)}' text-anchor='middle' font-size='10.5' font-weight='600' fill='{line_color}'>{fnum(pcts[i])}%</text>")
    parts.append("</svg></div>")
    return "".join(parts)


def build_weekly_overview_block(ctx):
    if not ctx.weekly_eligible_months:
        return ""
    row_defs = [{"key": c["key"], "label": c["label"]} for c in ctx.b["classes"]]
    overall_by_month = get_week_buckets_all_months(ctx, ctx.data_rows, ctx.col["cls"])
    unique_by_month = get_week_buckets_all_months(ctx, ctx.unique, ctx.col["cls"])
    parts = []
    for mi in ctx.weekly_eligible_months:
        week_list = ctx.weeks_by_month_idx[mi]
        week_sales_map = get_week_sales_map(ctx, mi)
        parts.append(f"<div class='gran-weekly' data-month='{mi}' style='display:none;'>")
        parts.append(f"<p class='note'>Weekly view for {h_enc(pretty_month(ctx.months[mi]))}.</p>")
        parts.append(build_period_pivot(ctx, "Overall Query Class-Wise Comparison (Weekly)", "Query Class",
                                         row_defs, overall_by_month[mi]["by_key"], week_list, week_sales_map, mi))
        parts.append(build_period_pivot(ctx, "Unique Query Class-Wise Comparison (Weekly)", "Query Class",
                                         row_defs, unique_by_month[mi]["by_key"], week_list, week_sales_map, mi))
        parts.append("</div>")
    return "".join(parts)


def build_weekly_class_block(ctx, cls):
    if not ctx.weekly_eligible_months:
        return ""
    subset = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == cls["key"]]
    by_month = get_week_buckets_all_months(ctx, subset, ctx.col["cat"])
    parts = []
    for mi in ctx.weekly_eligible_months:
        week_list = ctx.weeks_by_month_idx[mi]
        week_sales_map = get_week_sales_map(ctx, mi)
        bkt = by_month[mi]
        if not bkt["key_tot"]:
            parts.append(f"<div class='gran-weekly' data-month='{mi}' style='display:none;'>"
                         f"<p class='note'>No {h_enc(cls['label'])} tickets in {h_enc(pretty_month(ctx.months[mi]))}.</p></div>")
            continue
        cat_order = [k for k, _ in sorted(bkt["key_tot"].items(), key=lambda kv: kv[1], reverse=True)]
        row_defs = [{"key": k, "label": k} for k in cat_order]
        vals = [sum(bkt["by_key"][k].get(wk, 0) for k in cat_order) for wk in week_list]
        parts.append(f"<div class='gran-weekly' data-month='{mi}' style='display:none;'>")
        parts.append(f"<p class='note'>Weekly view for {h_enc(pretty_month(ctx.months[mi]))}.</p>")
        parts.append(build_period_pivot(ctx, f"{h_enc(cls['label'])} Complaints (Weekly)", "Query Category",
                                         row_defs, bkt["by_key"], week_list, week_sales_map, mi))
        parts.append(build_period_chart(ctx, f"{h_enc(cls['label'])} Complaints wrt Sales (Weekly)", vals,
                                         week_list, week_sales_map, mi, cls["color"], "var(--s1)"))
        parts.append("</div>")
    return "".join(parts)


def build_weekly_delivery_block(ctx):
    if not ctx.weekly_eligible_months:
        return ""
    delivery = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == "Delivery"]
    cat_by_month = get_week_buckets_all_months(ctx, delivery, ctx.col["cat"])

    n = ctx.n
    partner_by_month = [{"by_key": {}, "key_tot": {}} for _ in range(n)]
    alloc_by_month = [{} for _ in range(n)]
    partner_caches = [{} for _ in range(n)]
    for r in delivery:
        mo_lbl = ctx.cell(r, ctx.col["month"])
        if mo_lbl not in ctx.month_index_lookup:
            continue
        mi2 = ctx.month_index_lookup[mo_lbl]
        wk_val = ctx.cell(r, ctx.col["week"])
        if not str(wk_val).strip() or wk_val == "#N/A":
            continue
        p = ctx.cell(r, ctx.col["partner"])
        if not str(p).strip():
            p = "(blank)"
        p = ci_key(p, partner_caches[mi2])
        bkt = partner_by_month[mi2]
        bkt["by_key"].setdefault(p, {})
        bkt["by_key"][p][wk_val] = bkt["by_key"][p].get(wk_val, 0) + 1
        bkt["key_tot"][p] = bkt["key_tot"].get(p, 0) + 1

        ar = ctx.cell(r, ctx.col["alloc"])
        try:
            av = float(str(ar).replace(",", ""))
        except (ValueError, TypeError):
            av = 0.0
        if av > 0:
            ak = f"{p}|{wk_val}"
            am = alloc_by_month[mi2]
            if ak not in am:
                am[ak] = {"sum": 0.0, "cnt": 0}
            am[ak]["sum"] += av
            am[ak]["cnt"] += 1

    parts = []
    for mi in ctx.weekly_eligible_months:
        week_list = ctx.weeks_by_month_idx[mi]
        week_sales_map = get_week_sales_map(ctx, mi)
        cat_bkt = cat_by_month[mi]

        parts.append(f"<div class='gran-weekly' data-month='{mi}' style='display:none;'>")
        parts.append(f"<p class='note'>Weekly view for {h_enc(pretty_month(ctx.months[mi]))}.</p>")

        if not cat_bkt["key_tot"]:
            parts.append(f"<p class='note'>No Delivery tickets in {h_enc(pretty_month(ctx.months[mi]))}.</p></div>")
            continue
        cat_order = [k for k, _ in sorted(cat_bkt["key_tot"].items(), key=lambda kv: kv[1], reverse=True)]
        row_defs = [{"key": k, "label": k} for k in cat_order]
        vals = [sum(cat_bkt["by_key"][k].get(wk, 0) for k in cat_order) for wk in week_list]

        parts.append(build_period_pivot(ctx, "Delivery Complaints (Weekly)", "Query Category",
                                         row_defs, cat_bkt["by_key"], week_list, week_sales_map, mi))
        parts.append(build_period_chart(ctx, "Delivery Complaints wrt Sales (Weekly)", vals,
                                         week_list, week_sales_map, mi, "var(--s1)", "var(--s3)"))

        p_bkt = partner_by_month[mi]
        if p_bkt["key_tot"]:
            partner_order = [k for k, _ in sorted(p_bkt["key_tot"].items(), key=lambda kv: kv[1], reverse=True)]
            am = alloc_by_month[mi]
            tparts = ["<div class='pivot-wrap'><div class='pivot-title'>Delivery Complaints wrt Delivery Partners (Weekly)</div>"
                      "<div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>Delivery Partner Name</th>"]
            for wk in week_list:
                tparts.append(f"<th colspan='2' class='month-hdr'>{h_enc(week_col_header(ctx, wk, mi))}</th>")
            tparts.append("</tr><tr>")
            for _ in week_list:
                tparts.append("<th class='sub-hdr'>Complaints</th><th class='sub-hdr'>wrt allocation</th>")
            tparts.append("</tr></thead><tbody>")
            for ri, p in enumerate(partner_order, start=1):
                z = "zebra" if ri % 2 == 1 else ""
                tparts.append(f"<tr class='{z}'><td class='rowlabel'>{h_enc(p)}</td>")
                for wk in week_list:
                    cnt = p_bkt["by_key"][p].get(wk, 0)
                    ak = f"{p}|{wk}"
                    avg = (am[ak]["sum"] / am[ak]["cnt"]) if am.get(ak, {}).get("cnt", 0) > 0 else 0
                    cd = n0(cnt) if cnt > 0 else "-"
                    pd = f"{fnum(round1(cnt/avg*100))}%" if (cnt > 0 and avg > 0) else "-"
                    tparts.append(f"<td class='num'>{cd}</td><td class='pct'>{pd}</td>")
                tparts.append("</tr>")
            tparts.append("</tbody></table></div></div>")
            parts.append("".join(tparts))
        parts.append("</div>")
    return "".join(parts)
