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

from report_context import ci_key, h_enc, j_enc, parse_month_label, sort_keys_by_last_period

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


def get_week_buckets_global(ctx, rows, key_col_idx):
    """Same aggregation as the old get_week_buckets_all_months, but keyed by GLOBAL week
    index (0..ctx.total_weeks-1, ctx.week_month_of[gi] gives the owning month) instead of
    per-month week strings - lets the client-side renderer (see gen_panels.py's toolbar
    script) combine weeks across however many months are selected without needing to
    re-derive which month a given week belongs to. Returns (by_key, key_tot); by_key is
    {key: {global_week_idx: count}}."""
    by_key = {}
    key_tot = {}
    key_cache = {}
    for r in rows:
        mo_lbl = ctx.cell(r, ctx.col["month"])
        if mo_lbl not in ctx.month_index_lookup:
            continue
        mi = ctx.month_index_lookup[mo_lbl]
        wk_val = ctx.cell(r, ctx.col["week"])
        if not str(wk_val).strip() or wk_val == "#N/A":
            continue
        wks = ctx.weeks_by_month_idx[mi]
        if wk_val not in wks:
            continue
        gi = ctx.week_start_idx[mi] + wks.index(wk_val)
        k = ctx.cell(r, key_col_idx)
        if not str(k).strip():
            k = "(blank)"
        k = ci_key(k, key_cache)
        by_key.setdefault(k, {})
        by_key[k][gi] = by_key[k].get(gi, 0) + 1
        key_tot[k] = key_tot.get(k, 0) + 1
    return by_key, key_tot


def _counts_matrix_json(keys, by_key, total_weeks):
    rows = []
    for k in keys:
        counts = by_key.get(k, {})
        rows.append("[" + ",".join(str(counts.get(gi, 0)) for gi in range(total_weeks)) + "]")
    return "[" + ",".join(rows) + "]"


def _totals_by_gi_json(keys, by_key):
    """{global_week_idx: summed count across every key} - what the combined "wrt Sales"
    chart plots (the class/Delivery total, not a per-category breakdown)."""
    totals = {}
    for k in keys:
        for gi, cnt in by_key.get(k, {}).items():
            totals[gi] = totals.get(gi, 0) + cnt
    return "{" + ",".join(f'"{gi}":{cnt}' for gi, cnt in totals.items()) + "}"


def build_weekly_overview_block(ctx):
    if not ctx.weekly_eligible_months:
        return ""
    row_defs = [{"key": c["key"], "label": c["label"]} for c in ctx.b["classes"]]
    keys = [rd["key"] for rd in row_defs]
    labels = [rd["label"] for rd in row_defs]
    overall_by_key, _ = get_week_buckets_global(ctx, ctx.data_rows, ctx.col["cls"])
    unique_by_key, _ = get_week_buckets_global(ctx, ctx.unique, ctx.col["cls"])
    overall_json = _counts_matrix_json(keys, overall_by_key, ctx.total_weeks)
    unique_json = _counts_matrix_json(keys, unique_by_key, ctx.total_weeks)
    labels_json = "[" + ",".join(f'"{j_enc(l)}"' for l in labels) + "]"
    return f"""<div class="gran-weekly gran-weekly-dynamic">
  <p class="note" id="wk-ov-note"></p>
  <div id="wk-ov-overall"></div>
  <div id="wk-ov-unique"></div>
</div>
<script>
(function(){{
  var LABELS={labels_json}, OVERALL={overall_json}, UNIQUE={unique_json};
  window.registerWeeklyRenderer(function(){{
    window.setWeeklyNote('wk-ov-note');
    window.renderMultiWeekPivot('wk-ov-overall', LABELS, OVERALL, window.WK_SALES, 'Query Class', 'Overall Query Class-Wise Comparison (Weekly)', '%');
    window.renderMultiWeekPivot('wk-ov-unique', LABELS, UNIQUE, window.WK_SALES, 'Query Class', 'Unique Query Class-Wise Comparison (Weekly)', '%');
  }});
}})();
</script>"""


def build_weekly_class_block(ctx, cls):
    if not ctx.weekly_eligible_months:
        return ""
    subset = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == cls["key"]]
    by_key, key_tot = get_week_buckets_global(ctx, subset, ctx.col["cat"])
    if not key_tot:
        return f"<div class='gran-weekly gran-weekly-dynamic'><p class='note'>No {h_enc(cls['label'])} tickets found.</p></div>"
    cat_order = sort_keys_by_last_period(by_key, key_tot, list(range(ctx.total_weeks)))
    counts_json = _counts_matrix_json(cat_order, by_key, ctx.total_weeks)
    totals_json = _totals_by_gi_json(cat_order, by_key)
    labels_json = "[" + ",".join(f'"{j_enc(k)}"' for k in cat_order) + "]"
    pfx = cls["id"]
    return f"""<div class="gran-weekly gran-weekly-dynamic">
  <p class="note" id="wk-{pfx}-note"></p>
  <div id="wk-{pfx}-table"></div>
  <div class="card"><div class="pivot-title" style="margin-bottom:18px;">{h_enc(cls['label'])} Complaints wrt Sales (Weekly)</div>
    <div class="legend-row" style="justify-content:center;"><div class="legend-item"><span class="swatch" style="background:{cls['color']};"></span><span class="lname">Complaints</span></div>
    <div class="legend-item"><span class="swatch" style="background:var(--s1);border-radius:50%;"></span><span class="lname">wrt sales %</span></div></div>
    <svg id="wk-{pfx}-chart" viewBox="0 0 1200 380" width="100%" height="380" role="img"></svg>
  </div>
</div>
<script>
(function(){{
  var LABELS={labels_json}, COUNTS={counts_json}, TOTALS={totals_json};
  window.registerWeeklyRenderer(function(){{
    window.setWeeklyNote('wk-{pfx}-note');
    window.renderMultiWeekPivot('wk-{pfx}-table', LABELS, COUNTS, window.WK_SALES, 'Query Category', '{j_enc(cls["label"])} Complaints (Weekly)', '%');
    window.renderMultiWeekChart('wk-{pfx}-chart', TOTALS, '{cls['color']}', 'var(--s1)');
  }});
}})();
</script>"""


def build_weekly_delivery_block(ctx):
    if not ctx.weekly_eligible_months:
        return ""
    delivery = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == "Delivery"]
    cat_by_key, cat_tot = get_week_buckets_global(ctx, delivery, ctx.col["cat"])
    if not cat_tot:
        return "<div class='gran-weekly gran-weekly-dynamic'><p class='note'>No Delivery tickets found.</p></div>"

    partner_by_key = {}
    partner_tot = {}
    alloc_sum = {}
    alloc_cnt = {}
    partner_cache = {}
    for r in delivery:
        mo_lbl = ctx.cell(r, ctx.col["month"])
        if mo_lbl not in ctx.month_index_lookup:
            continue
        mi = ctx.month_index_lookup[mo_lbl]
        wk_val = ctx.cell(r, ctx.col["week"])
        if not str(wk_val).strip() or wk_val == "#N/A":
            continue
        wks = ctx.weeks_by_month_idx[mi]
        if wk_val not in wks:
            continue
        gi = ctx.week_start_idx[mi] + wks.index(wk_val)
        p = ctx.cell(r, ctx.col["partner"])
        if not str(p).strip():
            p = "(blank)"
        p = ci_key(p, partner_cache)
        partner_by_key.setdefault(p, {})
        partner_by_key[p][gi] = partner_by_key[p].get(gi, 0) + 1
        partner_tot[p] = partner_tot.get(p, 0) + 1

        ar = ctx.cell(r, ctx.col["alloc"])
        try:
            av = float(str(ar).replace(",", ""))
        except (ValueError, TypeError):
            av = 0.0
        if av > 0:
            ak = (p, gi)
            alloc_sum[ak] = alloc_sum.get(ak, 0.0) + av
            alloc_cnt[ak] = alloc_cnt.get(ak, 0) + 1

    period_order = list(range(ctx.total_weeks))
    cat_order = sort_keys_by_last_period(cat_by_key, cat_tot, period_order)
    cat_counts_json = _counts_matrix_json(cat_order, cat_by_key, ctx.total_weeks)
    cat_totals_json = _totals_by_gi_json(cat_order, cat_by_key)
    cat_labels_json = "[" + ",".join(f'"{j_enc(k)}"' for k in cat_order) + "]"

    partner_block = ""
    if partner_tot:
        partner_order = sort_keys_by_last_period(partner_by_key, partner_tot, period_order)
        partner_counts_json = _counts_matrix_json(partner_order, partner_by_key, ctx.total_weeks)
        partner_labels_json = "[" + ",".join(f'"{j_enc(p)}"' for p in partner_order) + "]"
        alloc_rows = []
        for p in partner_order:
            row = []
            for gi in range(ctx.total_weeks):
                ak = (p, gi)
                avg = (alloc_sum[ak] / alloc_cnt[ak]) if alloc_cnt.get(ak, 0) > 0 else 0
                row.append(str(avg))
            alloc_rows.append("[" + ",".join(row) + "]")
        alloc_json = "[" + ",".join(alloc_rows) + "]"
        partner_block = f"""
  <div id="wk-delivery-partner-table"></div>
</div>
<script>
(function(){{
  var PLABELS={partner_labels_json}, PCOUNTS={partner_counts_json}, ALLOC={alloc_json};
  window.registerWeeklyRenderer(function(){{
    window.renderMultiWeekPivot('wk-delivery-partner-table', PLABELS, PCOUNTS, ALLOC, 'Delivery Partner Name', 'Delivery Complaints wrt Delivery Partners (Weekly)', 'wrt allocation');
  }});
}})();
</script>"""
    else:
        partner_block = "</div>"

    return f"""<div class="gran-weekly gran-weekly-dynamic">
  <p class="note" id="wk-delivery-note"></p>
  <div id="wk-delivery-table"></div>
  <div class="card"><div class="pivot-title" style="margin-bottom:18px;">Delivery Complaints wrt Sales (Weekly)</div>
    <div class="legend-row" style="justify-content:center;"><div class="legend-item"><span class="swatch" style="background:var(--s1);"></span><span class="lname">Complaints</span></div>
    <div class="legend-item"><span class="swatch" style="background:var(--s3);border-radius:50%;"></span><span class="lname">wrt sales %</span></div></div>
    <svg id="wk-delivery-chart" viewBox="0 0 1200 380" width="100%" height="380" role="img"></svg>
  </div>
<script>
(function(){{
  var LABELS={cat_labels_json}, COUNTS={cat_counts_json}, TOTALS={cat_totals_json};
  window.registerWeeklyRenderer(function(){{
    window.setWeeklyNote('wk-delivery-note');
    window.renderMultiWeekPivot('wk-delivery-table', LABELS, COUNTS, window.WK_SALES, 'Query Category', 'Delivery Complaints (Weekly)', '%');
    window.renderMultiWeekChart('wk-delivery-chart', TOTALS, 'var(--s1)', 'var(--s3)');
  }});
}})();
</script>{partner_block}"""
