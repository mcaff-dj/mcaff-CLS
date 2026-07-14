"""Monthly/Weekly/Yearly Analysis tab: auto-generated narrative comparing a picked period to
the one before it, mirroring the manual "segmented KYC" write-up style. Stats-only - no
root-cause text is inferred, since that isn't present in any structured column.
Python port of gen-monthly.ps1. Depends on gen_weekly.setup(ctx) having already run.
"""
import math

from gen_weekly import get_week_num
from report_context import ci_key, fnum, h_enc, n0, pretty_month, year_of

_SUB_DIM = {"delivery": "partner", "warehouse": "wh", "packaging": "prod", "product": "prod", "suggestion": "prod"}
_SUB_LABEL = {"partner": "courier", "wh": "warehouse", "prod": "product"}


def pct_fmt(v):
    if v is None:
        return "-"
    if v >= 1:
        return f"{fnum(round(v, 2))}%"
    return f"{fnum(round(v, 3))}%"


def change_verb(prev, cur):
    if prev <= 0:
        return "appeared" if cur > 0 else "held at"
    if cur <= 0:
        return "disappeared"
    mult = cur / prev
    if mult < 1:
        drop = 1 - mult
        if drop >= 0.5:
            return "dropped sharply"
        elif drop >= 0.25:
            return "fell"
        else:
            return "eased"
    if mult >= 5.5:
        return f"increased {round(mult)}-fold"
    elif mult >= 2.6:
        return "nearly tripled"
    elif mult >= 1.8:
        return "nearly doubled"
    elif mult >= 1.35:
        return "surged"
    elif mult >= 1.12:
        return "rose"
    else:
        return "edged up"


def setup(ctx):
    """Populates ctx.ma_week_global_idx / ma_month_ctx / ma_week_ctx / ma_year_ctx /
    ma_year_index_of / ma_year_sales_arr."""
    week_global_idx = {}
    for wi in range(ctx.total_weeks):
        week_global_idx[f"{ctx.months[ctx.week_month_of[wi]]}||{ctx.all_weeks[wi]}"] = wi
    ctx.ma_week_global_idx = week_global_idx

    def pretty_week_full(week_idx):
        mi = ctx.week_month_of[week_idx]
        wn = get_week_num(ctx.all_weeks[week_idx])
        lbl = f"{pretty_month(ctx.months[mi])} W{wn}"
        if week_idx == ctx.last_week_idx:
            lbl += " (partial)"
        return lbl
    ctx.ma_pretty_week_full = pretty_week_full

    def get_global_week_index(mo_lbl, wk_val):
        return week_global_idx.get(f"{mo_lbl}||{wk_val}", -1)

    ctx.ma_month_ctx = {
        "n": ctx.n,
        "sales": ctx.sales_arr,
        "index_fn": lambda r: ctx.months.index(ctx.cell(r, ctx.col["month"])) if ctx.cell(r, ctx.col["month"]) in ctx.months else -1,
        "label_fn": lambda idx: pretty_month(ctx.months[idx]),
    }
    ctx.ma_week_ctx = {
        "n": ctx.total_weeks,
        "sales": ctx.week_sales_arr,
        "index_fn": lambda r: (
            -1 if not str(ctx.cell(r, ctx.col["week"])).strip() or ctx.cell(r, ctx.col["week"]) == "#N/A"
            else get_global_week_index(ctx.cell(r, ctx.col["month"]), ctx.cell(r, ctx.col["week"]))
        ),
        "label_fn": pretty_week_full,
    }

    year_index_of = {yr: i for i, yr in enumerate(ctx.distinct_years)}
    ctx.ma_year_index_of = year_index_of
    year_sales_arr = [0.0] * len(ctx.distinct_years)
    for mi in range(ctx.n):
        yr = year_of(ctx.months[mi])
        if yr in year_index_of:
            year_sales_arr[year_index_of[yr]] += ctx.sales_arr[mi]
    ctx.ma_year_sales_arr = year_sales_arr
    ctx.ma_year_ctx = {
        "n": len(ctx.distinct_years),
        "sales": year_sales_arr,
        "index_fn": lambda r: year_index_of.get(year_of(ctx.cell(r, ctx.col["month"])), -1),
        "label_fn": lambda idx: ctx.distinct_years[idx],
    }


def build_class_period_data(ctx, cls, period):
    subset = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == cls["key"]]
    sub_dim_name = _SUB_DIM.get(cls["id"])
    sub_col = ctx.col[sub_dim_name] if sub_dim_name else None

    cat_period = {}
    cat_tot = {}
    sub_period = {}
    class_period_tot = [0] * period["n"]
    cat_cache = {}
    sub_caches = {}

    for r in subset:
        p_idx = period["index_fn"](r)
        if p_idx < 0:
            continue
        cat = ctx.cell(r, ctx.col["cat"])
        if not str(cat).strip():
            cat = "(blank)"
        cat = ci_key(cat, cat_cache)
        cat_period.setdefault(cat, [0] * period["n"])
        cat_period[cat][p_idx] += 1
        cat_tot[cat] = cat_tot.get(cat, 0) + 1
        class_period_tot[p_idx] += 1
        if sub_col is not None:
            sv = ctx.cell(r, sub_col)
            if not str(sv).strip():
                sv = "(blank)"
            sv = ci_key(sv, sub_caches.setdefault(cat, {}))
            sub_period.setdefault(cat, {})
            sub_period[cat].setdefault(sv, [0] * period["n"])
            sub_period[cat][sv][p_idx] += 1

    cat_order = [k for k, _ in sorted(cat_tot.items(), key=lambda kv: kv[1], reverse=True)]
    return {"cat_period": cat_period, "cat_order": cat_order, "sub_period": sub_period,
            "sub_dim_name": sub_dim_name, "class_period_tot": class_period_tot}


def build_class_period_narrative(cls, data, period, cur_idx):
    prev_idx = cur_idx - 1
    cur_label = period["label_fn"](cur_idx)
    prev_label = period["label_fn"](prev_idx)
    sales_cur = period["sales"][cur_idx]
    sales_prev = period["sales"][prev_idx]
    tot_cur = data["class_period_tot"][cur_idx]
    tot_prev = data["class_period_tot"][prev_idx]
    pct_cur = (tot_cur / sales_cur * 100) if sales_cur > 0 else 0
    pct_prev = (tot_prev / sales_prev * 100) if sales_prev > 0 else 0
    if pct_prev > 0:
        rel_change = abs(pct_cur - pct_prev) / pct_prev
    else:
        rel_change = 1 if pct_cur > 0 else 0

    bullets = []
    for cat in data["cat_order"]:
        cur_c = data["cat_period"][cat][cur_idx]
        prev_c = data["cat_period"][cat][prev_idx]
        if cur_c < 3:
            continue
        growth = (cur_c / prev_c) if prev_c > 0 else math.inf
        abs_delta = cur_c - prev_c
        qualifies = (prev_c == 0 and cur_c >= 3) or (prev_c > 0 and (growth >= 1.3 or abs_delta >= 10))
        if not qualifies:
            continue
        p_c = (cur_c / sales_cur * 100) if sales_cur > 0 else 0
        p_p = (prev_c / sales_prev * 100) if sales_prev > 0 else 0
        verb = change_verb(prev_c, cur_c)
        line = f"<b>{h_enc(cat)}</b>: Complaints {verb} from {n0(prev_c)} to {n0(cur_c)} ({pct_fmt(p_p)} &rarr; {pct_fmt(p_c)})."

        sub_lines = []
        if data["sub_dim_name"] and cat in data["sub_period"]:
            movers = []
            for sv, arr in data["sub_period"][cat].items():
                if sv == "(blank)":
                    continue
                sc, sp = arr[cur_idx], arr[prev_idx]
                d = sc - sp
                if d > 0 and sc >= 3:
                    movers.append({"name": sv, "cur": sc, "prev": sp, "delta": d})
            movers = sorted(movers, key=lambda m: m["delta"], reverse=True)[:2]
            for m in movers:
                if abs_delta > 0 and (m["delta"] / abs_delta) < 0.25:
                    continue
                mp = (m["cur"] / sales_cur * 100) if sales_cur > 0 else 0
                mpp = (m["prev"] / sales_prev * 100) if sales_prev > 0 else 0
                mverb = change_verb(m["prev"], m["cur"])
                sub_label = _SUB_LABEL[data["sub_dim_name"]]
                sub_lines.append(f"<li><b>{h_enc(m['name'])}</b> ({sub_label}): complaint rate {mverb} from {pct_fmt(mpp)} to {pct_fmt(mp)} ({n0(m['prev'])} &rarr; {n0(m['cur'])}).")
        if sub_lines:
            line += f"<ul class='ma-sub'>{''.join(sub_lines)}</ul>"
        bullets.append({"line": line, "sort_key": abs_delta})
    bullets = sorted(bullets, key=lambda b: b["sort_key"], reverse=True)

    if not bullets and rel_change < 0.1:
        return ""

    overall_verb = change_verb(pct_prev, pct_cur)
    parts = [f"<div class='ma-class'><h4>{h_enc(cls['label'])} Complaints</h4>"]
    parts.append(f"<p class='ma-overall'>Overall {h_enc(cls['label'].lower())} complaints {overall_verb} from {pct_fmt(pct_prev)} in {prev_label} to {pct_fmt(pct_cur)} in {cur_label}.</p>")
    if bullets:
        parts.append("<ul class='ma-list'>")
        for b in bullets:
            parts.append(f"<li>{b['line']}</li>")
        parts.append("</ul>")
    parts.append("</div>")
    return "".join(parts)


def build_monthly_analysis_panel(ctx):
    if ctx.n < 2:
        return ""
    n = ctx.n
    months = ctx.months

    # ---------- Monthly narrative ----------
    month_class_data = {c["key"]: build_class_period_data(ctx, c, ctx.ma_month_ctx) for c in ctx.b["classes"]}
    month_divs = []
    for mi in range(1, n):
        sections = []
        for c in ctx.b["classes"]:
            html = build_class_period_narrative(c, month_class_data[c["key"]], ctx.ma_month_ctx, mi)
            if html:
                sections.append(html)
        body = "".join(sections) if sections else f"<p class='note'>No notable month-on-month changes crossed the reporting threshold for {h_enc(pretty_month(months[mi]))}.</p>"
        disp = "" if mi == n - 1 else " style='display:none;'"
        month_divs.append(f"<div class='ma-period' id='ma-month-{mi}'{disp}>{body}</div>")
    month_opts = []
    for mi in range(1, n):
        sel = " selected" if mi == n - 1 else ""
        month_opts.append(f"<option value='{mi}'{sel}>{h_enc(pretty_month(months[mi]))} vs {h_enc(pretty_month(months[mi-1]))}</option>")

    # ---------- Weekly narrative ----------
    week_divs = []
    week_opts = []
    total_weeks = ctx.total_weeks
    if total_weeks >= 2:
        week_class_data = {c["key"]: build_class_period_data(ctx, c, ctx.ma_week_ctx) for c in ctx.b["classes"]}
        for wi in range(1, total_weeks):
            sections = []
            for c in ctx.b["classes"]:
                html = build_class_period_narrative(c, week_class_data[c["key"]], ctx.ma_week_ctx, wi)
                if html:
                    sections.append(html)
            body = "".join(sections) if sections else f"<p class='note'>No notable week-on-week changes crossed the reporting threshold for {h_enc(ctx.ma_pretty_week_full(wi))}.</p>"
            disp = "" if wi == total_weeks - 1 else " style='display:none;'"
            week_divs.append(f"<div class='ma-period' id='ma-week-{wi}'{disp}>{body}</div>")
        for wi in range(1, total_weeks):
            sel = " selected" if wi == total_weeks - 1 else ""
            week_opts.append(f"<option value='{wi}'{sel}>{h_enc(ctx.ma_pretty_week_full(wi))} vs {h_enc(ctx.ma_pretty_week_full(wi-1))}</option>")

    # ---------- Yearly narrative ----------
    year_divs = []
    year_opts = []
    n_years = len(ctx.distinct_years)
    if n_years >= 2:
        year_class_data = {c["key"]: build_class_period_data(ctx, c, ctx.ma_year_ctx) for c in ctx.b["classes"]}
        for yi in range(1, n_years):
            sections = []
            for c in ctx.b["classes"]:
                html = build_class_period_narrative(c, year_class_data[c["key"]], ctx.ma_year_ctx, yi)
                if html:
                    sections.append(html)
            body = "".join(sections) if sections else f"<p class='note'>No notable year-on-year changes crossed the reporting threshold for {h_enc(ctx.distinct_years[yi])}.</p>"
            disp = "" if yi == n_years - 1 else " style='display:none;'"
            year_divs.append(f"<div class='ma-period' id='ma-year-{yi}'{disp}>{body}</div>")
        for yi in range(1, n_years):
            sel = " selected" if yi == n_years - 1 else ""
            year_opts.append(f"<option value='{yi}'{sel}>{h_enc(ctx.distinct_years[yi])} vs {h_enc(ctx.distinct_years[yi-1])}</option>")

    js = """
<script>
(function(){
  window.onMonthlyAnalysisChange=function(v){
    document.querySelectorAll('#ma-monthly-wrap .ma-period').forEach(function(el){ el.style.display = (el.id==='ma-month-'+v) ? '' : 'none'; });
  };
  window.onWeeklyAnalysisChange=function(v){
    document.querySelectorAll('#ma-weekly-wrap .ma-period').forEach(function(el){ el.style.display = (el.id==='ma-week-'+v) ? '' : 'none'; });
  };
  window.onYearlyAnalysisChange=function(v){
    document.querySelectorAll('#ma-yearly-wrap .ma-period').forEach(function(el){ el.style.display = (el.id==='ma-year-'+v) ? '' : 'none'; });
  };
  window.setMaGranularity=function(g){
    document.querySelectorAll('.ma-gran-toggle .gran-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.magran===g); });
    var mw=document.getElementById('ma-monthly-wrap'), ww=document.getElementById('ma-weekly-wrap'), yw=document.getElementById('ma-yearly-wrap');
    if(mw){ mw.style.display = (g==='monthly') ? '' : 'none'; }
    if(ww){ ww.style.display = (g==='weekly') ? '' : 'none'; }
    if(yw){ yw.style.display = (g==='yearly') ? '' : 'none'; }
  };
})();
</script>
"""

    weekly_toggle_html = '<button type="button" class="gran-btn" data-magran="weekly" onclick="setMaGranularity(\'weekly\')">Weekly</button>' if total_weeks >= 2 else ""
    weekly_section_html = ""
    if total_weeks >= 2:
        weekly_section_html = (
            '    <div id="ma-weekly-wrap" style="display:none;">\n'
            '      <div style="margin-bottom:18px;"><label for="ma-week-select" style="font-size:12px;color:var(--text-muted);margin-right:8px;">Week</label>'
            f'<select id="ma-week-select" onchange="onWeeklyAnalysisChange(this.value)" style="font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;">{"".join(week_opts)}</select></div>\n'
            f'      {"".join(week_divs)}\n'
            '    </div>\n'
        )
    yearly_toggle_html = '<button type="button" class="gran-btn" data-magran="yearly" onclick="setMaGranularity(\'yearly\')">Yearly</button>' if n_years >= 2 else ""
    yearly_section_html = ""
    if n_years >= 2:
        yearly_section_html = (
            '    <div id="ma-yearly-wrap" style="display:none;">\n'
            '      <div style="margin-bottom:18px;"><label for="ma-year-select" style="font-size:12px;color:var(--text-muted);margin-right:8px;">Year</label>'
            f'<select id="ma-year-select" onchange="onYearlyAnalysisChange(this.value)" style="font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;">{"".join(year_opts)}</select></div>\n'
            f'      {"".join(year_divs)}\n'
            '    </div>\n'
        )

    return f"""<div class="tab-panel" id="panel-monthly">
  <section>
    <h2>Monthly Analysis</h2>
    <p class="desc">Auto-generated from ticket data &mdash; compares the selected period to the one before it. Figures are wrt that period's total sales; drill-downs show the courier/warehouse/product driving most of a category's change. Root-cause context (e.g. a specific coupon bug) isn't captured in the data and is not inferred here.</p>
    <div class="ma-gran-toggle">
      <button type="button" class="gran-btn active" data-magran="monthly" onclick="setMaGranularity('monthly')">Monthly</button>
      {weekly_toggle_html}
      {yearly_toggle_html}
    </div>
    <div id="ma-monthly-wrap">
      <div style="margin-bottom:18px;"><label for="ma-select" style="font-size:12px;color:var(--text-muted);margin-right:8px;">Month</label><select id="ma-select" onchange="onMonthlyAnalysisChange(this.value)" style="font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;">{"".join(month_opts)}</select></div>
      {"".join(month_divs)}
    </div>
{weekly_section_html}
{yearly_section_html}
  </section>
</div>
{js}"""
