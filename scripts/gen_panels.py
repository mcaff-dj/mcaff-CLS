"""Panel builders. Python port of gen-panels.ps1 (shares report_context.Ctx state, the
Python equivalent of PowerShell dot-sourcing into a shared script scope).

Generic bidirectional category <-> second-dimension cross-filter panel, used by every
class that has a meaningful second breakdown dimension (Delivery: partner, Technical:
platform, Warehouse: facility, Product/Suggestion: product name). Clicking a row in
EITHER table filters the OTHER table + chart to that selection; the clicked table itself
keeps showing its full breakdown so the user can pick again. Packaging & Operational has
no viable second dimension (its QA fields are <1% populated) so it stays on the plain
single-table build_class_panel below.

NOTE on templating: blocks below that embed literal JavaScript/CSS (containing `{`/`}`)
are built as plain strings with unique `__TOKEN__` placeholders replaced via .replace() -
deliberately NOT f-strings, since an f-string would require escaping every brace in the
embedded JS/CSS as `{{`/`}}` (high risk of a missed brace silently corrupting the script).
"""
from gen_geo_insights import build_delivery_geo_containers, build_geo_script
from gen_insights import build_insights_card, get_category_insight_items, get_delivery_partner_insight
from gen_weekly import build_weekly_class_block, build_weekly_delivery_block, get_week_num, is_partial_week, week_col_header
from gen_monthly import build_monthly_analysis_panel
from gen_raw_export import raw_download_link
from nps_source import _month_label as nps_month_label
from report_context import ci_key, fnum, h_enc, j_enc, n0, pretty_month, round1, sort_keys_by_last_period, year_of


def build_cross_filter_panel(ctx, cls, dim2_key, dim2_label, dim2_title, pct_mode, dim2_pct_label, dim2_cap, coverage_mode):
    months = ctx.months
    n = ctx.n
    subset = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == cls["key"]]
    pfx = cls["id"]
    dim2_col = ctx.col[dim2_key]

    # Months this class has zero tickets for (e.g. a query category introduced only
    # partway through the sheet's history) get their header/data cells skipped entirely
    # in sb1/sb2 below, rather than rendering an all-"-" column. The embedded JS (rct/rdt
    # in the script block further down) already no-ops via `if(ce)` when a cell id doesn't
    # exist, so simply not emitting these <th>/<td> elements is enough - no JS changes
    # needed, and MONTHS/tickets_json stay in the original full-month index space.
    month_has_data = [False] * n
    for r in subset:
        mo = ctx.cell(r, ctx.col["month"])
        if mo in months:
            month_has_data[months.index(mo)] = True

    # Shared caches so every pass below resolves the same raw value (e.g. "Product not
    # Sealed" vs "product NOT sealed") to the same first-seen-cased key - matching
    # PowerShell's case-insensitive @{} hashtables. Without sharing these across passes,
    # a later pass's cat_order.index(cat)/dim2_order.index(v) could throw on a
    # differently-cased occurrence of a value already seen (and canonicalized) earlier.
    cat_cache = {}
    dim2_cache = {}

    cat_tot = {}
    cat_month = {}
    for r in subset:
        c = ctx.cell(r, ctx.col["cat"])
        if not str(c).strip():
            c = "(blank)"
        c = ci_key(c, cat_cache)
        cat_tot[c] = cat_tot.get(c, 0) + 1
        mo = ctx.cell(r, ctx.col["month"])
        if mo in months:
            cat_month.setdefault(c, {})
            cat_month[c][mo] = cat_month[c].get(mo, 0) + 1
    cat_order = sort_keys_by_last_period(cat_month, cat_tot, months)

    dim2_tot_all = {}
    dim2_month = {}
    for r in subset:
        v = ctx.cell(r, dim2_col)
        if not str(v).strip():
            v = "(blank)"
        v = ci_key(v, dim2_cache)
        dim2_tot_all[v] = dim2_tot_all.get(v, 0) + 1
        mo = ctx.cell(r, ctx.col["month"])
        if mo in months:
            dim2_month.setdefault(v, {})
            dim2_month[v][mo] = dim2_month[v].get(mo, 0) + 1
    dim2_order_full = sort_keys_by_last_period(dim2_month, dim2_tot_all, months)
    dim2_capped = len(dim2_order_full) > dim2_cap
    if dim2_capped:
        top_vals = dim2_order_full[:dim2_cap - 1]
        dim2_order = top_vals + ["(other)"]
        dim2_top = set(top_vals)
    else:
        dim2_order = dim2_order_full
        dim2_top = set(dim2_order_full)
    other_idx = len(dim2_order) - 1

    dim2_non_blank = sum(v for k, v in dim2_tot_all.items() if k != "(blank)")
    dim2_coverage_pct = round1(dim2_non_blank / len(subset) * 100) if subset else 0
    first_covered_month = None
    if coverage_mode == "sinceFirst":
        for mo in months:
            has = any(ctx.cell(r, ctx.col["month"]) == mo and str(ctx.cell(r, dim2_col)).strip() for r in subset)
            if has:
                first_covered_month = mo
                break
    if coverage_mode == "sinceFirst":
        if first_covered_month:
            coverage_note = (f"<p class='desc'>{h_enc(dim2_label)} has only been captured since {h_enc(pretty_month(first_covered_month))} "
                              f"&mdash; {fnum(dim2_coverage_pct)}% of all {h_enc(cls['label'])} tickets have it filled in; earlier months show entirely as &quot;(blank)&quot;.</p>")
        else:
            coverage_note = f"<p class='desc'>{h_enc(dim2_label)} isn't populated on any {h_enc(cls['label'])} tickets yet.</p>"
    elif coverage_mode == "sparsePct":
        coverage_note = f"<p class='desc'>{h_enc(dim2_label)} is only tagged on {fnum(dim2_coverage_pct)}% of {h_enc(cls['label'])} tickets &mdash; directional only; the rest show as &quot;(blank)&quot;.</p>"
    else:
        coverage_note = ""
    capped_note = (f"<p class='desc'>Showing the top {dim2_cap-1} {h_enc(dim2_label)} values by ticket volume (of {len(dim2_order_full)} total); "
                   f"the rest are grouped into &quot;(other)&quot;.</p>") if dim2_capped else ""

    tk = []
    alloc_sum = {}
    alloc_cnt = {}
    for r in subset:
        mo = ctx.cell(r, ctx.col["month"])
        mi = months.index(mo) if mo in months else -1
        if mi < 0:
            continue
        cat = ctx.cell(r, ctx.col["cat"])
        if not str(cat).strip():
            cat = "(blank)"
        cat = ci_key(cat, cat_cache)
        ci = cat_order.index(cat)
        v = ctx.cell(r, dim2_col)
        if not str(v).strip():
            v = "(blank)"
        v = ci_key(v, dim2_cache)
        di = other_idx if (dim2_capped and v not in dim2_top) else dim2_order.index(v)
        tk.append(f"[{mi},{ci},{di}]")
        if pct_mode == "alloc":
            ar = ctx.cell(r, ctx.col["alloc"])
            try:
                av = float(str(ar).replace(",", ""))
            except (ValueError, TypeError):
                av = 0.0
            if av > 0:
                ak = f"{di}|{mi}"
                alloc_sum[ak] = alloc_sum.get(ak, 0) + av
                alloc_cnt[ak] = alloc_cnt.get(ak, 0) + 1

    tickets_json = "[" + ",".join(tk) + "]"
    cats_json = "[" + ",".join(f'"{j_enc(c)}"' for c in cat_order) + "]"
    dim2s_json = "[" + ",".join(f'"{j_enc(d)}"' for d in dim2_order) + "]"
    months_json = "[" + ",".join(f'"{j_enc(m)}"' for m in months) + "]"
    month_labels_json = "[" + ",".join(f'"{j_enc(pretty_month(m))}"' for m in months) + "]"
    sales_json = "[" + ",".join(str(v) for v in ctx.sales_arr) + "]"
    # Same empty-month set as sb1/sb2's skipped <th>/<td>s above, but for the "wrt Sales"
    # chart (drawn client-side, reactive to row-click filtering) - rch() below slices its
    # per-month arrays down to just these indices before handing them to renderPctChart,
    # so a month this class has zero tickets for doesn't render as a bar-less gap either.
    visible_month_idx_json = "[" + ",".join(str(mi) for mi in range(n) if month_has_data[mi]) + "]"
    alloc_json = "[]"
    if pct_mode == "alloc":
        rows = []
        for di in range(len(dim2_order)):
            cols = []
            for mi in range(n):
                ak = f"{di}|{mi}"
                avg = (alloc_sum[ak] / alloc_cnt[ak]) if alloc_cnt.get(ak, 0) > 0 else 0
                cols.append(str(avg))
            rows.append("[" + ",".join(cols) + "]")
        alloc_json = "[" + ",".join(rows) + "]"

    W, H, pad_l, pad_r, pad_t, pad_b = 1200, 380, 55, 55, 40, 55
    bar_color = cls["color"]
    line_color = "var(--s3)" if cls["color"] == "var(--s1)" else "var(--s1)"

    sb1 = [f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(cls['label'])} Complaints by Issue Category</div>"
           f"<div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>Query Category</th>"]
    for mi, mo in enumerate(months):
        if month_has_data[mi]:
            sb1.append(f"<th colspan='2' class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    sb1.append("</tr><tr>")
    for mi, mo in enumerate(months):
        if month_has_data[mi]:
            yr = year_of(mo)
            sb1.append(f"<th class='sub-hdr' data-yr='{yr}'>Complaints</th><th class='sub-hdr' data-yr='{yr}'>wrt sales</th>")
    sb1.append("</tr></thead><tbody>")
    for ci, cat in enumerate(cat_order):
        z = "zebra" if (ci + 1) % 2 == 1 else ""
        sb1.append(f"<tr class='{z} xf-row' id='xf-{pfx}-catrow-{ci}' onclick='onXfClick(\"{pfx}\",\"cat\",{ci})'><td class='rowlabel' title=\"{h_enc(cat)}\">{h_enc(cat)}</td>")
        for mi in range(n):
            if not month_has_data[mi]:
                continue
            yr = year_of(months[mi])
            sb1.append(f"<td class='num' id='xf-{pfx}-cat-{ci}-mo-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='xf-{pfx}-cat-{ci}-mo-{mi}-pct' data-yr='{yr}'>-</td>")
        sb1.append("</tr>")
    sb1.append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for mi in range(n):
        if not month_has_data[mi]:
            continue
        yr = year_of(months[mi])
        sb1.append(f"<td class='num' id='xf-{pfx}-cat-total-mo-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='xf-{pfx}-cat-total-mo-{mi}-pct' data-yr='{yr}'>-</td>")
    sb1.append("</tr></tbody></table></div></div>")

    sb2 = [f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(dim2_title)}</div>"
           f"<div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>{h_enc(dim2_label)}</th>"]
    for mi, mo in enumerate(months):
        if month_has_data[mi]:
            sb2.append(f"<th colspan='2' class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    sb2.append("</tr><tr>")
    for mi, mo in enumerate(months):
        if month_has_data[mi]:
            yr = year_of(mo)
            sb2.append(f"<th class='sub-hdr' data-yr='{yr}'>Complaints</th><th class='sub-hdr' data-yr='{yr}'>{h_enc(dim2_pct_label)}</th>")
    sb2.append("</tr></thead><tbody>")
    for di, dv in enumerate(dim2_order):
        z = "zebra" if (di + 1) % 2 == 1 else ""
        sb2.append(f"<tr class='{z} xf-row' id='xf-{pfx}-dimrow-{di}' onclick='onXfClick(\"{pfx}\",\"dim2\",{di})'><td class='rowlabel' title=\"{h_enc(dv)}\">{h_enc(dv)}</td>")
        for mi in range(n):
            if not month_has_data[mi]:
                continue
            yr = year_of(months[mi])
            sb2.append(f"<td class='num' id='xf-{pfx}-dim-{di}-mo-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='xf-{pfx}-dim-{di}-mo-{mi}-pct' data-yr='{yr}'>-</td>")
        sb2.append("</tr>")
    sb2.append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for mi in range(n):
        if not month_has_data[mi]:
            continue
        yr = year_of(months[mi])
        sb2.append(f"<td class='num' id='xf-{pfx}-dim-total-mo-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='xf-{pfx}-dim-total-mo-{mi}-pct' data-yr='{yr}'>-</td>")
    sb2.append("</tr></tbody></table></div></div>")

    sb3 = [f"<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>{h_enc(cls['label'])} Complaints wrt Sales</div>"
           f"<div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:{bar_color};'></span><span class='lname'>Complaints</span></div>"
           f"<div class='legend-item'><span class='swatch' style='background:{line_color};border-radius:50%;'></span><span class='lname'>wrt sales %</span></div></div>"]
    # Bars/line are drawn entirely client-side (renderPctChart in _shell_head.html), same
    # as _build_combo_chart - here that renderer is fed vals recomputed by filteredTotals()
    # (the existing cross-filter click logic) each time, so both the cross-filter click AND
    # the Year toggle can trigger a redraw that re-spaces bars and rescales both axes
    # instead of just hiding elements and leaving gaps.
    sb3.append(f"<svg id='xf-{pfx}-chart' viewBox='0 0 {W} {H}' width='100%' height='{H}' role='img'></svg></div>")

    filter_note = f"<div class='filter-row' style='display:flex;align-items:center;gap:10px;margin:0 0 4px;flex-wrap:wrap;'><span id='xf-{pfx}-filter-note' style='font-size:12px;color:var(--text-muted);'></span></div>"

    js = """
<script>
(function(){
  var DT=__TICKETS_JSON__, CATS=__CATS_JSON__, DIMS=__DIM2S_JSON__, MONTHS=__MONTHS_JSON__, MONTH_LABELS=__MONTHLABELS_JSON__, SALES=__SALES_JSON__, ALLOC=__ALLOC_JSON__, VIS_MONTH_IDX=__VISMONTHIDX_JSON__, N=MONTHS.length;
  var chartEl=document.getElementById('xf-__PFX__-chart'), pctMode='__PCTMODE__', filter=null;
  function fmt(n){return n.toLocaleString('en-IN');}
  function passOther(t, exceptAxis){ var mo=t[0],c=t[1],d=t[2]; if(mo<0||mo>=N||c<0||c>=CATS.length||d<0||d>=DIMS.length)return false;
    if(filter && filter.axis!==exceptAxis){ if(filter.axis==='cat'&&c!==filter.idx)return false; if(filter.axis==='dim2'&&d!==filter.idx)return false; }
    return true; }
  function catBreakdown(){ var cm=CATS.map(function(){return new Array(N).fill(0)});
    for(var i=0;i<DT.length;i++){ var t=DT[i]; if(!passOther(t,'cat'))continue; cm[t[1]][t[0]]++; } return cm; }
  function dimBreakdown(){ var dm=DIMS.map(function(){return new Array(N).fill(0)});
    for(var i=0;i<DT.length;i++){ var t=DT[i]; if(!passOther(t,'dim2'))continue; dm[t[2]][t[0]]++; } return dm; }
  function filteredTotals(){ var tot=new Array(N).fill(0),tc=0; for(var i=0;i<DT.length;i++){ var t=DT[i]; if(!passOther(t,null))continue; tot[t[0]]++; tc++; } return {tot:tot,tc:tc}; }
  function rct(){ var cm=catBreakdown(), tot=new Array(N).fill(0);
    for(var ci=0;ci<CATS.length;ci++){ for(var mi=0;mi<N;mi++){ var cnt=cm[ci][mi],sm=SALES[mi],p=sm>0?Math.round(cnt/sm*1000)/10:0; tot[mi]+=cnt;
      var ce=document.getElementById('xf-__PFX__-cat-'+ci+'-mo-'+mi+'-cnt'); if(ce)ce.textContent=cnt>0?fmt(cnt):'-';
      var pe=document.getElementById('xf-__PFX__-cat-'+ci+'-mo-'+mi+'-pct'); if(pe)pe.textContent=cnt>0?(p+'%'):'-'; } }
    for(var m=0;m<N;m++){ var sm2=SALES[m],p2=sm2>0?Math.round(tot[m]/sm2*1000)/10:0;
      var ce2=document.getElementById('xf-__PFX__-cat-total-mo-'+m+'-cnt'); if(ce2)ce2.textContent=fmt(tot[m]);
      var pe2=document.getElementById('xf-__PFX__-cat-total-mo-'+m+'-pct'); if(pe2)pe2.textContent=p2+'%'; } }
  function rdt(){ var dm=dimBreakdown(), tot=new Array(N).fill(0);
    for(var di=0;di<DIMS.length;di++){ for(var mi=0;mi<N;mi++){ var cnt=dm[di][mi]; tot[mi]+=cnt;
      var basis = (pctMode==='alloc') ? (ALLOC[di]?ALLOC[di][mi]:0) : SALES[mi];
      var p = basis>0?Math.round(cnt/basis*1000)/10:0;
      var ce=document.getElementById('xf-__PFX__-dim-'+di+'-mo-'+mi+'-cnt'); if(ce)ce.textContent=cnt>0?fmt(cnt):'-';
      var pe=document.getElementById('xf-__PFX__-dim-'+di+'-mo-'+mi+'-pct'); if(pe)pe.textContent=(cnt>0&&basis>0)?(p+'%'):'-'; } }
    for(var m=0;m<N;m++){
      var ce2=document.getElementById('xf-__PFX__-dim-total-mo-'+m+'-cnt'); if(ce2)ce2.textContent=fmt(tot[m]);
      var pe2=document.getElementById('xf-__PFX__-dim-total-mo-'+m+'-pct');
      if(pe2){ if(pctMode==='alloc'){ pe2.textContent='-'; } else { var sm3=SALES[m],p3=sm3>0?Math.round(tot[m]/sm3*1000)/10:0; pe2.textContent=p3+'%'; } } } }
  function rch(){ var r=filteredTotals();
    // Only chart the months this class actually has tickets in (VIS_MONTH_IDX, same set
    // sb1/sb2's skipped <th>/<td>s use) - otherwise a class whose category history starts
    // partway through the sheet would draw a long flat run of zero-height bars first.
    var visTot=[], visMonths=[], visLabels=[], visSales=[];
    for(var vi=0;vi<VIS_MONTH_IDX.length;vi++){ var mi=VIS_MONTH_IDX[vi];
      visTot.push(r.tot[mi]); visMonths.push(MONTHS[mi]); visLabels.push(MONTH_LABELS[mi]); visSales.push(SALES[mi]); }
    window.renderPctChart(chartEl, { vals:visTot, months:visMonths, monthLabels:visLabels, sales:visSales,
      barColor:'__BARCOLOR__', lineColor:'__LINECOLOR__', W:__W__, H:__H__, padL:__PADL__, padR:__PADR__, padT:__PADT__, padB:__PADB__ });
    return r; }
  function render(){ try{ rct(); rdt(); var r=rch();
      var note=document.getElementById('xf-__PFX__-filter-note');
      if(note){
        if(!filter){ note.textContent='Showing all __CLSLABEL__ tickets. Click a row in either table to cross-filter.'; }
        else if(filter.axis==='cat'){ note.textContent='Filtered to category "'+CATS[filter.idx]+'" ('+fmt(r.tc)+' tickets). Click the row again to clear.'; }
        else { note.textContent='Filtered to __DIM2LABEL__ "'+DIMS[filter.idx]+'" ('+fmt(r.tc)+' tickets). Click the row again to clear.'; }
      }
    }catch(e){ var n2=document.getElementById('xf-__PFX__-filter-note'); if(n2){n2.textContent='Filter error: '+e.message; n2.style.color='var(--s6)';} if(window.console)console.error('__PFX__ filter error',e); } }
  window._xfPanels = window._xfPanels || {};
  window._xfPanels['__PFX__'] = { onClick: function(axis, idx){
    filter = (filter && filter.axis===axis && filter.idx===idx) ? null : {axis:axis, idx:idx};
    document.querySelectorAll('#panel-__PFX__ .xf-row').forEach(function(row){ row.classList.remove('active-filter'); });
    if(filter){ var id = filter.axis==='cat' ? ('xf-__PFX__-catrow-'+filter.idx) : ('xf-__PFX__-dimrow-'+filter.idx); var el=document.getElementById(id); if(el)el.classList.add('active-filter'); }
    render();
  }};
  window.onXfClick = window.onXfClick || function(pfx, axis, idx){ if(window._xfPanels[pfx])window._xfPanels[pfx].onClick(axis, idx); };
  function init(){ window.registerYearChart(render); }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();
</script>
"""
    js = (js.replace("__TICKETS_JSON__", tickets_json).replace("__CATS_JSON__", cats_json)
            .replace("__DIM2S_JSON__", dim2s_json).replace("__MONTHS_JSON__", months_json)
            .replace("__MONTHLABELS_JSON__", month_labels_json)
            .replace("__SALES_JSON__", sales_json).replace("__ALLOC_JSON__", alloc_json)
            .replace("__VISMONTHIDX_JSON__", visible_month_idx_json)
            .replace("__W__", str(W)).replace("__H__", str(H))
            .replace("__PADL__", str(pad_l)).replace("__PADR__", str(pad_r)).replace("__PADT__", str(pad_t)).replace("__PADB__", str(pad_b))
            .replace("__BARCOLOR__", bar_color).replace("__LINECOLOR__", line_color)
            .replace("__PCTMODE__", pct_mode)
            .replace("__CLSLABEL__", h_enc(cls["label"])).replace("__DIM2LABEL__", h_enc(dim2_label))
            .replace("__PFX__", pfx))

    if cls["id"] == "delivery":
        insights_block = build_insights_card("Insights &mdash; Delivery",
                                              get_category_insight_items(ctx, subset) + [get_delivery_partner_insight(ctx, subset)])
        insights_block += build_delivery_geo_containers(ctx)
        weekly_block = build_weekly_delivery_block(ctx)
    else:
        insights_block = build_insights_card(f"Insights &mdash; {h_enc(cls['label'])}", get_category_insight_items(ctx, subset))
        weekly_block = build_weekly_class_block(ctx, cls)
    if cls["id"] == "suggestion":
        cat_desc = "Percent = complaints &divide; that month's total order volume (\"Total Sales M\")."
        dim2_section = ""
    else:
        cat_desc = "Percent = complaints &divide; that month's total order volume (\"Total Sales M\"). Click a row in either table below to cross-filter."
        dim2_section = f"<section><h2>{h_enc(dim2_title)}</h2>{coverage_note}{capped_note}{''.join(sb2)}</section>\n"

    return f"""{raw_download_link(ctx, pfx)}
<div class="gran-monthly">
{filter_note}
<section><h2>{h_enc(cls['label'])} Complaints by Issue Category</h2><p class="desc">{cat_desc}</p>{''.join(sb1)}</section>
{dim2_section}<section><h2>{h_enc(cls['label'])} Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line). Recomputes for the row selected above.</p>{''.join(sb3)}</section>
</div>
{weekly_block}
{insights_block}
{js}"""


def _build_category_pivot(ctx, subset, title):
    """Returns (html, month_totals) - port of Generate-Report.ps1's Build-CategoryPivot."""
    months = ctx.months
    n = ctx.n
    cat_month = {}
    cat_tot = {}
    cat_cache = {}
    for r in subset:
        cat = ctx.cell(r, ctx.col["cat"])
        if not str(cat).strip():
            cat = "(blank)"
        cat = ci_key(cat, cat_cache)
        mo = ctx.cell(r, ctx.col["month"])
        if not str(mo).strip():
            continue
        cat_month.setdefault(cat, {})
        cat_month[cat][mo] = cat_month[cat].get(mo, 0) + 1
        cat_tot[cat] = cat_tot.get(cat, 0) + 1
    cat_order = sort_keys_by_last_period(cat_month, cat_tot, months)
    parts = [f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(title)}</div><div class='pivot-scroll'>"
             f"<table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>Query Category</th>"]
    for mo in months:
        parts.append(f"<th colspan='2' class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    parts.append("</tr><tr>")
    for mo in months:
        yr = year_of(mo)
        parts.append(f"<th class='sub-hdr' data-yr='{yr}'>Complaints</th><th class='sub-hdr' data-yr='{yr}'>wrt sales</th>")
    parts.append("</tr></thead><tbody>")
    totals = {}
    for ri, cat in enumerate(cat_order, start=1):
        z = "zebra" if ri % 2 == 1 else ""
        parts.append(f"<tr class='{z}'><td class='rowlabel' title=\"{h_enc(cat)}\">{h_enc(cat)}</td>")
        for mo in months:
            cnt = cat_month[cat].get(mo, 0)
            totals[mo] = totals.get(mo, 0) + cnt
            sm = ctx.sales_m.get(mo, 0)
            pct = round1(cnt / sm * 100) if sm > 0 else 0
            cd = n0(cnt) if cnt > 0 else "-"
            pd = f"{fnum(pct)}%" if cnt > 0 else "-"
            yr = year_of(mo)
            parts.append(f"<td class='num' data-yr='{yr}'>{cd}</td><td class='pct' data-yr='{yr}'>{pd}</td>")
        parts.append("</tr>")
    parts.append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for mo in months:
        t = totals.get(mo, 0)
        sm = ctx.sales_m.get(mo, 0)
        pct = round1(t / sm * 100) if sm > 0 else 0
        yr = year_of(mo)
        parts.append(f"<td class='num' data-yr='{yr}'>{n0(t)}</td><td class='pct' data-yr='{yr}'>{fnum(pct)}%</td>")
    parts.append("</tr></tbody></table></div></div>")
    month_totals = [totals.get(mo, 0) for mo in months]
    return "".join(parts), month_totals


_chart_id_counter = [0]


def _next_chart_id(prefix):
    _chart_id_counter[0] += 1
    return f"{prefix}-{_chart_id_counter[0]}"


def _build_combo_chart(ctx, vals, title, bar_color, line_color):
    # Bars/line are drawn entirely client-side (renderPctChart in _shell_head.html) rather
    # than pre-rendered here, so the Year filter can redraw against only the active years
    # (re-spacing bars, rescaling both axes) instead of just hiding elements and leaving
    # gaps - see registerYearChart. Python's only job is to embed the raw per-month values.
    #
    # Months with zero tickets (e.g. a class whose category history starts partway
    # through the sheet) are dropped here too, same as _build_category_pivot's columns -
    # vals[i] already tells us whether that month has any data, no separate lookup needed.
    visible_idx = [i for i, v in enumerate(vals) if v > 0]
    months = [ctx.months[i] for i in visible_idx]
    vals = [vals[i] for i in visible_idx]
    sales_arr = [ctx.sales_arr[i] for i in visible_idx]
    W, H, pad_l, pad_r, pad_t, pad_b = 1200, 380, 55, 55, 40, 55
    chart_id = _next_chart_id("chart")
    vals_json = "[" + ",".join(str(v) for v in vals) + "]"
    months_json = "[" + ",".join(f'"{j_enc(m)}"' for m in months) + "]"
    month_labels_json = "[" + ",".join(f'"{j_enc(pretty_month(m))}"' for m in months) + "]"
    sales_json = "[" + ",".join(str(v) for v in sales_arr) + "]"
    parts = [f"<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>{h_enc(title)}</div>"
             f"<div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:{bar_color};'></span><span class='lname'>Complaints</span></div>"
             f"<div class='legend-item'><span class='swatch' style='background:{line_color};border-radius:50%;'></span><span class='lname'>wrt sales %</span></div></div>"]
    parts.append(f"<svg id='{chart_id}' viewBox='0 0 {W} {H}' width='100%' height='{H}' role='img'></svg></div>")
    parts.append(f"""<script>
(function(){{
  var svg = document.getElementById('{chart_id}');
  var opts = {{ vals:{vals_json}, months:{months_json}, monthLabels:{month_labels_json}, sales:{sales_json},
    barColor:'{bar_color}', lineColor:'{line_color}', W:{W}, H:{H}, padL:{pad_l}, padR:{pad_r}, padT:{pad_t}, padB:{pad_b}}};
  window.registerYearChart(function(){{ window.renderPctChart(svg, opts); }});
}})();
</script>""")
    return "".join(parts)


def build_class_panel(ctx, cls):
    subset = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == cls["key"]]
    pivot, month_totals = _build_category_pivot(ctx, subset, f"{cls['label']} Complaints")
    chart = _build_combo_chart(ctx, month_totals, f"{cls['label']} Complaints wrt Sales", cls["color"], "var(--s1)")
    insights = build_insights_card(f"Insights &mdash; {h_enc(cls['label'])}", get_category_insight_items(ctx, subset))
    weekly = build_weekly_class_block(ctx, cls)
    return f"""{raw_download_link(ctx, cls["id"])}
<div class="gran-monthly">
<section><h2>{h_enc(cls['label'])} Complaints by Issue Category</h2><p class="desc">Percent = complaints &divide; that month's total order volume ("Total Sales M").</p>{pivot}</section>
<section><h2>{h_enc(cls['label'])} Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line).</p>{chart}</section>
</div>
{weekly}
{insights}"""


def build_combo2(rows, title, score_label, score_max):
    mos, vals, sc, yrs_raw, month_nums = [], [], [], [], []
    for i in range(1, len(rows)):
        r = rows[i]
        raw = r[0]
        # Sheet formula errors (#REF!, #N/A, #DIV/0!, etc.) sometimes leak into these
        # columns when an upstream reference breaks - skip the whole row rather than
        # crash the run (there's no sensible fallback value for a single data point,
        # unlike the mode-of-many-rows lookups elsewhere).
        try:
            v = float(str(r[1]).replace(",", ""))
            s = float(r[2])
        except (ValueError, TypeError):
            continue
        mos.append(pretty_month(raw))
        yrs_raw.append(year_of(raw))
        vals.append(v)
        sc.append(s)
        m = 0
        import re as _re
        mm = _re.match(r"^(\d+)_", raw)
        if mm:
            m = int(mm.group(1))
        month_nums.append(m)
    n = len(mos)
    if n == 0:
        return "<div class='card'><p class='note'>No data.</p></div>"
    # This sheet's month labels are inconsistently formatted (some carry no year at all,
    # e.g. "12_Dec" vs "2_Feb'26") - backfill missing years by walking backward from the
    # nearest row that does have one, decrementing across month-number wraparounds
    # (e.g. Dec(12) immediately before a known Jan(1)/2026 must be Dec 2025).
    yrs = [None] * n
    carry_year = None
    for i in range(n - 1, -1, -1):
        if yrs_raw[i]:
            carry_year = yrs_raw[i]
        elif carry_year and i < (n - 1) and month_nums[i] > 0 and month_nums[i + 1] > 0 and month_nums[i] > month_nums[i + 1]:
            carry_year = str(int(carry_year) - 1)
        yrs[i] = carry_year

    # Bars/line/grid are drawn entirely client-side (renderScoreChart in _shell_head.html)
    # so the Year filter can redraw against only the active years instead of just hiding
    # elements and leaving gaps - see registerYearChart. Python's only job is to embed the
    # raw per-row values (including the backfilled years computed above).
    W, H, pad_l, pad_r, pad_t, pad_b = 1120, 420, 55, 55, 40, 55
    chart_id = _next_chart_id("chart")
    vals_json = "[" + ",".join(str(v) for v in vals) + "]"
    sc_json = "[" + ",".join(str(v) for v in sc) + "]"
    labels_json = "[" + ",".join(f'"{j_enc(m)}"' for m in mos) + "]"
    years_json = "[" + ",".join(f'"{j_enc(y)}"' if y else "null" for y in yrs) + "]"
    parts = [f"<div class='card'><div class='pivot-title' style='margin-bottom:18px;'>{h_enc(title)}</div>"
             f"<div class='legend-row' style='justify-content:center;'><div class='legend-item'><span class='swatch' style='background:var(--s1);border-radius:50%;'></span><span class='lname'>{score_label}</span></div>"
             f"<div class='legend-item'><span class='swatch' style='background:var(--s2);'></span><span class='lname'>Total Responses</span></div></div>"]
    parts.append(f"<svg id='{chart_id}' viewBox='0 0 {W} {H}' width='100%' height='{H}' role='img'></svg></div>")
    parts.append(f"""<script>
(function(){{
  var svg = document.getElementById('{chart_id}');
  var opts = {{ vals:{vals_json}, sc:{sc_json}, labels:{labels_json}, years:{years_json}, scoreMax:{score_max},
    W:{W}, H:{H}, padL:{pad_l}, padR:{pad_r}, padT:{pad_t}, padB:{pad_b}}};
  window.registerYearChart(function(){{ window.renderScoreChart(svg, opts); }});
}})();
</script>""")
    return "".join(parts)


def build_nps_panel(ctx):
    o = build_combo2(ctx.mom, "NPS - Overall", "NPS%", 100)
    p = build_combo2(ctx.prodnps, "NPS - Product", "NPS", 100)
    from gen_insights import get_score_insight
    insights = build_insights_card("Insights &mdash; NPS", [get_score_insight(ctx.mom, "Overall NPS", 30, 0), get_score_insight(ctx.prodnps, "Product NPS", 30, 0)])
    return (f'<div class="tab-panel" id="panel-nps"><section><h2>Net Promoter Score</h2>'
            f'<p class="desc">Monthly survey responses (bars, right axis) against NPS (line, left axis).</p>{o}</section><section>{p}</section>{insights}</div>')


def build_csat_panel(ctx):
    a = build_combo2(ctx.agent, "Agent CSAT", "CSAT", 5)
    i = build_combo2(ctx.ai, "AI CSAT", "CSAT", 5)
    from gen_insights import get_score_insight
    insights = build_insights_card("Insights &mdash; CSAT", [get_score_insight(ctx.agent, "Agent CSAT", 4.3, 3.7), get_score_insight(ctx.ai, "AI CSAT", 4.3, 3.7)])
    return (f'<div class="tab-panel active" id="panel-csat"><section><h2>Customer Satisfaction (CSAT)</h2>'
            f'<p class="desc">Monthly survey responses (bars, right axis) against CSAT out of 5 (line, left axis).</p>{a}</section><section>{i}</section>{insights}</div>')


def _nps_month_label(ym):
    """'2026-07' -> "7_Jul'26" (nps_source._month_label's sheet-style shape) -> "Jul '26"
    (pretty_month's display shape), matching every other month label on the page."""
    yr, mo = int(ym[:4]), int(ym[5:7])
    return pretty_month(nps_month_label(yr, mo))


def _prodwise_sparkline(months, value_fn=None):
    """Inline SVG sparkline over sorted months + directional arrow.
    value_fn(month_dict) -> float|None; defaults to nps_pct.
    Returns (svg_html, spark_json_str): svg_html is the initial full-range render;
    spark_json_str is {"YYYY-MM": value_or_null} for a data-* attribute so the
    Year-filter JS can redraw filtered to active years only."""
    if value_fn is None:
        value_fn = lambda m: m["nps_pct"]
    pts = sorted(
        ((ym, value_fn(m)) for ym, m in months.items() if value_fn(m) is not None),
        key=lambda t: t[0],
    )
    json_parts = []
    for ym, m in sorted(months.items()):
        v = value_fn(m)
        json_parts.append(f'"{ym}":{v if v is not None else "null"}')
    spark_json = "{" + ",".join(json_parts) + "}"
    if len(pts) < 2:
        return ("", spark_json)
    vals = [v for _, v in pts]
    lo, hi = min(vals), max(vals)
    rng = hi - lo or 1.0
    W, H, PAD = 64, 22, 2
    n = len(pts)
    def px(i): return PAD + i * (W - 2 * PAD) / (n - 1)
    def py(v): return H - PAD - (v - lo) / rng * (H - 2 * PAD)
    coords = " ".join(f"{px(i):.1f},{py(v):.1f}" for i, (_, v) in enumerate(pts))
    delta = vals[-1] - vals[0]
    color = "var(--s2)" if delta > 2 else ("var(--s6)" if delta < -2 else "var(--s4)")
    arrow = "&#x25B2;" if delta > 2 else ("&#x25BC;" if delta < -2 else "&#x2192;")
    lx, ly = f"{px(n - 1):.1f}", f"{py(vals[-1]):.1f}"
    svg = (
        f"<svg width='{W}' height='{H}' viewBox='0 0 {W} {H}'"
        f" style='vertical-align:middle;overflow:visible;display:inline-block'>"
        f"<polyline points='{coords}' fill='none' stroke='{color}'"
        f" stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>"
        f"<circle cx='{lx}' cy='{ly}' r='2.5' fill='{color}'/></svg>"
        f"<span style='color:{color};font-size:9px;margin-left:3px;vertical-align:middle'>{arrow}</span>"
    )
    return (svg, spark_json)


def _prodwise_year_json(months, years):
    """months: ym ('YYYY-MM') -> per-month stats dict (see nps_source.fetch_product_wise_nps).
    Returns a compact {"<year>":[responses,sum_overall,cnt_overall,sum_packaging,cnt_packaging,
    promoters,passives,detractors]} JSON object (plain numbers only, safe unescaped inside a
    single-quoted HTML attribute) - the client-side recompute in build_product_wise_nps_panel's
    <script> re-sums these per the active Year chips so the summary table's averages stay exact
    weighted averages rather than an average-of-averages.

    `years` is ctx.distinct_years - derived from the ticket sheet's own month range, which may
    not span every year nps_product happens to have rows for (its docstring notes MySQL carries
    NPS history the sheet itself never had). Any month whose year isn't one of the toggleable
    Year chips falls into "_other" instead of being silently dropped - the JS below always
    includes "_other" unconditionally (there's no chip to filter it by anyway), so the
    default "every chip active" view still adds up to the exact same lifetime total this table
    showed before the Year filter was wired in here."""
    buckets = {yr: [0, 0.0, 0, 0.0, 0, 0, 0, 0] for yr in years}
    other = [0, 0.0, 0, 0.0, 0, 0, 0, 0]
    for ym, m in months.items():
        b = buckets.get(ym[:4], other)
        b[0] += m["responses"]; b[1] += m["sum_overall"]; b[2] += m["cnt_overall"]
        b[3] += m["sum_packaging"]; b[4] += m["cnt_packaging"]
        b[5] += m["promoters"]; b[6] += m["passives"]; b[7] += m["detractors"]
    parts = [f'"{yr}":[{v[0]},{round(v[1], 2)},{v[2]},{round(v[3], 2)},{v[4]},{v[5]},{v[6]},{v[7]}]' for yr, v in buckets.items()]
    if any(other):
        parts.append(f'"_other":[{other[0]},{round(other[1], 2)},{other[2]},{round(other[3], 2)},{other[4]},{other[5]},{other[6]},{other[7]}]')
    return "{" + ",".join(parts) + "}"


def _build_prodwise_heatmap(capped):
    """Product x month avg NPS score (1-10) heatmap. Color midpoint is 7.0 (NPS promoter
    threshold): below = red (--s6), above = aqua (--s2), normalized against the actual data
    spread (floor 1.0 so a flat dataset still shows some color contrast). Month columns carry
    data-yr so the Year-chip sweep hides out-of-range columns with no extra JS."""
    all_yms = sorted({ym for r in capped for ym in r["months"]})
    if not all_yms:
        return ""

    NPS_MID = 0  # standard NPS breakeven: positive above 0, negative below

    def _nps(m):
        return m["nps_pct"] if m else None

    all_vals = [_nps(m) for r in capped for m in r["months"].values() if m and m["nps_pct"] is not None]
    # ponytail: domain = max deviation from midpoint in the data (floor 1.0)
    domain = max(1.0, max((abs(v - NPS_MID) for v in all_vals if v is not None), default=0.0))

    def cell_style(avg):
        if avg is None:
            return ""
        t = max(-1.0, min(1.0, (avg - NPS_MID) / domain))
        slot = "--s2" if t >= 0 else "--s6"
        mix = round(abs(t) * 70)
        return f" style=\"background:color-mix(in oklab, var(--grid) {100 - mix}%, var({slot}) {mix}%)\""

    head_cells = "".join(f"<th class='month-hdr' data-yr='{ym[:4]}'>{h_enc(_nps_month_label(ym))}</th>" for ym in all_yms)

    body_rows = []
    for i, r in enumerate(capped):
        z = "zebra" if i % 2 == 1 else ""
        cells = []
        for ym in all_yms:
            m = r["months"].get(ym)
            avg = _nps(m)
            label = fnum(avg) if avg is not None else "&ndash;"
            title = f" title='{h_enc(r['product'])} &middot; {h_enc(_nps_month_label(ym))}: {n0(m['responses'])} responses'" if m else ""
            cells.append(f"<td class='num hm-cell' data-yr='{ym[:4]}'{cell_style(avg)}{title}>{label}</td>")
        spark_svg, spark_json = _prodwise_sparkline(r["months"])
        body_rows.append(
            f"<tr class='{z}' data-hm-spark='{spark_json}'>"
            f"<td class='rowlabel'>{h_enc(r['product'])}</td>{''.join(cells)}"
            f"<td class='num' style='min-width:80px'>{spark_svg}</td></tr>"
        )

    legend = (
        "<div class='legend-row' style='justify-content:center;gap:10px;'>"
        "<span class='lname'>Negative NPS</span>"
        "<span style='display:inline-block;width:140px;height:10px;border-radius:5px;"
        "background:linear-gradient(to right, var(--s6), var(--grid), var(--s2));'></span>"
        "<span class='lname'>Positive NPS</span></div>"
    )

    return (
        "<div class='pivot-wrap'><div class='pivot-title'>Product wise NPS &mdash; Monthly Heatmap</div>"
        "<p class='desc'>NPS% = (Promoters &minus; Detractors) &divide; Total &times; 100, per product per month. "
        "Color midpoint is 0 (NPS breakeven); blank cells had no survey responses that month.</p>"
        f"{legend}<div class='pivot-scroll'><table class='pivot-table'><thead><tr>"
        f"<th class='corner'>Product</th>{head_cells}<th>Trend</th></tr></thead><tbody>{''.join(body_rows)}</tbody></table></div></div>"
    )


def build_product_wise_nps_panel(ctx):
    """Product wise NPS: nps_product grouped by product name (ctx.prodwise_nps, see
    nps_source.fetch_product_wise_nps) - a plain read-through table like RTO-Conversion's,
    not derived from ticket rows. Capped to the top PRODWISE_NPS_CAP products by response
    volume (already sorted desc by the query) so a long tail of 1-response products doesn't
    turn this into an unusable wall of rows.

    The summary table's Responses/Avg NPS/.../Detractor% are lifetime-per-product aggregates,
    so unlike the category-pivot tables (which just hide month *columns*) there's no column to
    hide for the Year filter - each row's per-year sums are embedded instead (data-py, see
    _prodwise_year_json) and a small script re-derives every visible number from only the active
    years, registered via window.registerYearChart so it reacts to the same Year chips as every
    other table/chart on the page. Weekly stays out of scope here, same as NPS/CSAT above (no
    .gran-weekly wiring) - survey responses have no meaningful weekly bucket to show."""
    rows = ctx.prodwise_nps or []
    if not rows:
        return ('  <div class="tab-panel" id="panel-prodwisenps"><section><h2>Product wise NPS</h2>'
                '<p class="note">No product-wise NPS data found.</p></section></div>')

    PRODWISE_NPS_CAP = 50
    capped = rows[:PRODWISE_NPS_CAP]
    cap_note = (f"<p class='desc'>Showing the top {PRODWISE_NPS_CAP} products by NPS response volume "
                f"(of {len(rows)} total).</p>") if len(rows) > PRODWISE_NPS_CAP else ""

    def fmt_score(v):
        return fnum(v) if v is not None else "&ndash;"

    def fmt_pct(v):
        return f"{fnum(v)}%" if v is not None else "&ndash;"

    year_aware = len(ctx.distinct_years) > 1

    for r in capped:
        if 'nps_pct' not in r:
            r['nps_pct'] = round((r['promoters'] - r['detractors']) / r['responses'] * 100, 1) if r.get('responses') else None

    body_rows = []
    for i, r in enumerate(capped):
        z = "zebra" if i % 2 == 1 else ""
        py_attr = f" data-py='{_prodwise_year_json(r['months'], ctx.distinct_years)}'" if year_aware else ""
        spark_svg, spark_json = _prodwise_sparkline(r["months"])
        spark_attr = f" data-spark='{spark_json}'" if year_aware else ""
        body_rows.append(
            f"<tr class='{z}'{py_attr}{spark_attr}><td class='rowlabel'>{h_enc(r['product'])}</td>"
            f"<td class='num'>{n0(r['responses'])}</td><td class='num'>{fmt_score(r['nps_pct'])}</td>"
            f"<td class='num'>{fmt_score(r['avg_packaging_score'])}</td><td class='num'>{n0(r['promoters'])}</td>"
            f"<td class='num'>{n0(r['passives'])}</td><td class='num'>{n0(r['detractors'])}</td>"
            f"<td class='num'>{fmt_pct(r['detractor_rate_pct'])}</td>"
            f"<td class='num' style='min-width:80px'>{spark_svg}</td></tr>"
        )

    table = ("<div class='pivot-wrap'><div class='pivot-title'>Product wise NPS</div><div class='pivot-scroll'>"
             "<table class='pivot-table'><thead><tr><th class='corner'>Product</th><th>Responses</th>"
             "<th>NPS</th><th>Avg Packaging Score</th><th>Promoters</th><th>Passives</th><th>Detractors</th>"
             f"<th>Detractor %</th><th>Trend</th></tr></thead><tbody>{''.join(body_rows)}</tbody></table></div></div>")

    year_script = ""
    if year_aware:
        year_script = """<script>
(function(){
  function fmt1(v){ if(v==null) return '–'; v = Math.round(v*10)/10; return (v===Math.trunc(v)) ? String(v) : v.toFixed(1); }
  function drawSpark(td, pts) {
    if (pts.length < 2) { td.innerHTML = '–'; return; }
    var vals = pts.map(function(p){ return p[1]; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var rng = hi - lo || 1;
    var W=64, H=22, PAD=2, n=pts.length;
    function px(i){ return PAD + i*(W-2*PAD)/(n-1); }
    function py(v){ return H - PAD - (v-lo)/rng*(H-2*PAD); }
    var coords = pts.map(function(p,i){ return px(i).toFixed(1)+','+py(p[1]).toFixed(1); }).join(' ');
    var delta = vals[n-1] - vals[0];
    var col = delta > 2 ? 'var(--s2)' : (delta < -2 ? 'var(--s6)' : 'var(--s4)');
    var arrow = delta > 2 ? '&#x25B2;' : (delta < -2 ? '&#x25BC;' : '&#x2192;');
    var lx = px(n-1).toFixed(1), ly = py(vals[n-1]).toFixed(1);
    td.innerHTML = "<svg width='"+W+"' height='"+H+"' viewBox='0 0 "+W+" "+H+"'"
      +" style='vertical-align:middle;overflow:visible;display:inline-block'>"
      +"<polyline points='"+coords+"' fill='none' stroke='"+col+"'"
      +" stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>"
      +"<circle cx='"+lx+"' cy='"+ly+"' r='2.5' fill='"+col+"'/></svg>"
      +"<span style='color:"+col+";font-size:9px;margin-left:3px;vertical-align:middle'>"+arrow+"</span>";
  }
  window.registerYearChart(function(){
    var activeYears = window.REPORT_ACTIVE_YEARS; if(!activeYears) return;
    document.querySelectorAll('#panel-prodwisenps table.pivot-table > tbody > tr[data-py]').forEach(function(tr){
      var py = JSON.parse(tr.getAttribute('data-py'));
      var resp=0,sumP=0,cntP=0,prom=0,pas=0,det=0;
      Object.keys(py).forEach(function(yr){
        if(yr !== '_other' && !activeYears.has(yr)) return;
        var a = py[yr];
        resp+=a[0]; sumP+=a[3]; cntP+=a[4]; prom+=a[5]; pas+=a[6]; det+=a[7];
      });
      var c = tr.children;
      c[1].textContent = window.fmtN0(resp);
      c[2].textContent = resp ? fmt1((prom-det)/resp*100) : '–';
      c[3].textContent = cntP ? fmt1(sumP/cntP) : '–';
      c[4].textContent = window.fmtN0(prom);
      c[5].textContent = window.fmtN0(pas);
      c[6].textContent = window.fmtN0(det);
      c[7].textContent = resp ? (fmt1(det/resp*100)+'%') : '–';
      var sparkRaw = tr.getAttribute('data-spark');
      if (sparkRaw) {
        var sm = JSON.parse(sparkRaw);
        var pts = Object.keys(sm).filter(function(ym){ return sm[ym] !== null && activeYears.has(ym.slice(0,4)); })
          .sort().map(function(ym){ return [ym, sm[ym]]; });
        drawSpark(c[8], pts);
      }
    });
    document.querySelectorAll('#panel-prodwisenps tr[data-hm-spark]').forEach(function(tr){
      var sm = JSON.parse(tr.getAttribute('data-hm-spark'));
      var pts = Object.keys(sm).filter(function(ym){ return sm[ym] !== null && activeYears.has(ym.slice(0,4)); })
        .sort().map(function(ym){ return [ym, sm[ym]]; });
      drawSpark(tr.lastElementChild, pts);
    });
  });
})();
</script>"""

    heatmap = _build_prodwise_heatmap(capped)

    return f"""  <div class="tab-panel" id="panel-prodwisenps">
    <section>
      <h2>Product wise NPS</h2>
      <p class="desc">Per-product NPS breakdown from survey responses (nps_product), not tied to complaint tickets.{' Reacts to the Year filter above; not available in Weekly view (see note).' if year_aware else ''}</p>
      {cap_note}
      {table}
      {year_script}
    </section>
    <section>
      {heatmap}
    </section>
  </div>"""


def _norm(v):
    s = "" if v is None else str(v)
    return "(blank)" if not s.strip() else s


def _build_ppk_core(ctx, subset, period_list, period_index_fn, period_header_fn, prefix, filter_label, year_fn=None):
    """Shared SKU -> Product -> Query Class -> Query Category -> Batch drill-down engine,
    used by both the monthly Product & Packaging panel (prefix='ppk') and each month's
    weekly variant (prefix='ppkw{month index}', one instance per weekly-eligible month -
    see build_weekly_prod_pkg_block). Every element id and JS entry point is namespaced by
    `prefix` so many instances can coexist on one page. `period_list`/`period_index_fn`/
    `period_header_fn` abstract over "months" vs "weeks within one month"; `year_fn`
    controls whether cells get a data-yr attribute (only the monthly view responds to the
    page-wide Year filter - weekly tables never have, matching every other weekly table in
    this report).

    Returns None if the given subset has no data for this period_list (nothing to render).
    """
    n = len(period_list)
    LP = n - 1  # last period index (last month, or last week-of-this-month)

    # Shared caches (one per field, reused across both this pass and the combo-building pass
    # below) so a value's casing is resolved the same way everywhere - matching PowerShell's
    # case-insensitive @{}/[ordered]@{} hashtables, where e.g. "Product not Sealed" and
    # "product NOT sealed" collapse into a single bucket under whichever casing was seen first.
    sku_cache, prod_cache, cls_cache, cat_cache, batch_cache = {}, {}, {}, {}, {}
    sku_set, prod_set, cls_set, cat_set, batch_set = {}, {}, {}, {}, {}
    for r in subset:
        sku_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["sku"])), sku_cache), True)
        prod_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["prod"])), prod_cache), True)
        cls_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["cls"])), cls_cache), True)
        cat_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["cat"])), cat_cache), True)
        batch_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["batch"])), batch_cache), True)
    SKUS, PRODS, CLASSES, CATS, BATCHES = list(sku_set), list(prod_set), list(cls_set), list(cat_set), list(batch_set)

    # "Pro Sales" (raw sheet column, never named/read anywhere else in the pipeline) is a
    # per-SKU-per-MONTH sales figure - unlike "Total Sales M" (company-wide, one value per
    # month), this varies by SKU, but it has no weekly equivalent in the sheet. For the
    # weekly case this naturally still works: every row in a single month's subset carries
    # the same Pro Sales value regardless of which week it falls in, so the majority-vote
    # keyed by (sku, period_index) below just reproduces that month's constant across all
    # its weeks - no special-casing needed.
    prosales_counts = {}

    combo_tot, combo_mc, combo_k2i = {}, {}, {}
    combo_list = []
    tickets = []
    for r in subset:
        pidx = period_index_fn(r)
        if pidx < 0 or pidx >= n:
            continue
        sku = ci_key(_norm(ctx.cell(r, ctx.col["sku"])), sku_cache)
        si = SKUS.index(sku)
        prod = ci_key(_norm(ctx.cell(r, ctx.col["prod"])), prod_cache)
        pi = PRODS.index(prod)
        cls_ = ci_key(_norm(ctx.cell(r, ctx.col["cls"])), cls_cache)
        li = CLASSES.index(cls_)
        cat = ci_key(_norm(ctx.cell(r, ctx.col["cat"])), cat_cache)
        ci = CATS.index(cat)
        bat = ci_key(_norm(ctx.cell(r, ctx.col["batch"])), batch_cache)
        bi = BATCHES.index(bat)
        tickets.append(f"[{pidx},{si},{pi},{li},{ci},{bi}]")
        ck = f"{si}|{pi}|{li}|{ci}|{bi}"
        if ck not in combo_tot:
            combo_tot[ck] = 0
            combo_mc[ck] = [0] * n
            combo_k2i[ck] = len(combo_list)
            combo_list.append({"sku": si, "prod": pi, "cls": li, "cat": ci, "batch": bi})
        combo_tot[ck] += 1
        combo_mc[ck][pidx] += 1
        ps = str(ctx.cell(r, ctx.col["prosales"])).strip()
        if ps:
            pk_ = (si, pidx)
            prosales_counts.setdefault(pk_, {})
            prosales_counts[pk_][ps] = prosales_counts[pk_].get(ps, 0) + 1

    if not combo_tot:
        return None

    PROSALES = [[0.0] * n for _ in range(len(SKUS))]
    for (si, pidx), counts in prosales_counts.items():
        # Sheet formula errors (#REF!, #N/A, #DIV/0!, etc.) sometimes leak into this
        # column when an upstream reference breaks - skip those candidates rather
        # than crash the whole run; if literally every candidate is unparseable,
        # PROSALES[si][pidx] just keeps its 0.0 initializer above.
        for val, _ in sorted(counts.items(), key=lambda kv: kv[1], reverse=True):
            try:
                PROSALES[si][pidx] = float(str(val).replace(",", ""))
                break
            except ValueError:
                continue

    def lmk(arr, sku_idx):
        c = arr[LP]
        lp_ps = PROSALES[sku_idx][LP]
        p = (c / lp_ps) if lp_ps > 0 else 0
        return {"cnt": c, "pct": p}

    MAX_P, MAX_PROD, MAX_CLS, MAX_CAT, MAX_BAT = 60, 10, 5, 15, 20
    sku_tree = {}
    for ck in combo_tot:
        c = combo_list[combo_k2i[ck]]
        sk = str(c["sku"])
        sku_tree.setdefault(sk, {"sku": c["sku"], "mc": [0] * n, "products": {}})
        sn = sku_tree[sk]
        for m in range(n):
            sn["mc"][m] += combo_mc[ck][m]
        pk = str(c["prod"])
        sn["products"].setdefault(pk, {"prod": c["prod"], "mc": [0] * n, "classes": {}})
        pn = sn["products"][pk]
        for m in range(n):
            pn["mc"][m] += combo_mc[ck][m]
        lk = str(c["cls"])
        pn["classes"].setdefault(lk, {"cls": c["cls"], "mc": [0] * n, "cats": {}})
        ln = pn["classes"][lk]
        for m in range(n):
            ln["mc"][m] += combo_mc[ck][m]
        catk = str(c["cat"])
        ln["cats"].setdefault(catk, {"cat": c["cat"], "mc": [0] * n, "batches": []})
        cn = ln["cats"][catk]
        for m in range(n):
            cn["mc"][m] += combo_mc[ck][m]
        cn["batches"].append({"combo": c, "mc": combo_mc[ck]})

    # Third sort key (the item's own real string value, looked up from SKUS/PRODS/CLASSES/
    # CATS/BATCHES - NOT the raw dict-key index) is a deterministic tie-breaker matching
    # gen-panels.ps1's Build-ProdPkgPanel. The lookup matters: the raw index alone is only
    # meaningful within this run's own SKUS/PRODS/etc list, built by first-encounter order
    # while scanning rows - the actual name string is the only value guaranteed to mean the
    # same real-world thing in both this port and the PowerShell original.
    top_sku = sorted(sku_tree.keys(), key=lambda sk: (lmk(sku_tree[sk]["mc"], int(sk))["cnt"], lmk(sku_tree[sk]["mc"], int(sk))["pct"], SKUS[int(sk)]), reverse=True)[:MAX_P]
    parents_out, prod_groups, cls_groups, cat_groups, rows_out, row_cat_idx = [], [], [], [], [], []
    for sk in top_sku:
        sn = sku_tree[sk]
        sk_idx = int(sk)
        pidx = len(parents_out)
        parents_out.append({"sku": sn["sku"]})
        tp = sorted(sn["products"].keys(), key=lambda pk: (lmk(sn["products"][pk]["mc"], sk_idx)["cnt"], lmk(sn["products"][pk]["mc"], sk_idx)["pct"], PRODS[int(pk)]), reverse=True)[:MAX_PROD]
        for pk in tp:
            pn = sn["products"][pk]
            pgi = len(prod_groups)
            prod_groups.append({"parentIdx": pidx, "prod": pn["prod"], "sku": sk_idx})
            tc = sorted(pn["classes"].keys(), key=lambda lk: (lmk(pn["classes"][lk]["mc"], sk_idx)["cnt"], lmk(pn["classes"][lk]["mc"], sk_idx)["pct"], CLASSES[int(lk)]), reverse=True)[:MAX_CLS]
            for lk in tc:
                ln = pn["classes"][lk]
                cgi = len(cls_groups)
                cls_groups.append({"productGroupIdx": pgi, "cls": ln["cls"], "sku": sk_idx})
                tcat = sorted(ln["cats"].keys(), key=lambda ck: (lmk(ln["cats"][ck]["mc"], sk_idx)["cnt"], lmk(ln["cats"][ck]["mc"], sk_idx)["pct"], CATS[int(ck)]), reverse=True)[:MAX_CAT]
                for catk in tcat:
                    cn = ln["cats"][catk]
                    catgi = len(cat_groups)
                    cat_groups.append({"classGroupIdx": cgi, "cat": cn["cat"], "sku": sk_idx})
                    tb = sorted(cn["batches"], key=lambda b: (lmk(b["mc"], sk_idx)["cnt"], lmk(b["mc"], sk_idx)["pct"], BATCHES[b["combo"]["batch"]]), reverse=True)[:MAX_BAT]
                    for b in tb:
                        rows_out.append(b["combo"])
                        row_cat_idx.append(catgi)

    def aj(a):
        return "[" + ",".join(f'"{j_enc(x)}"' for x in a) + "]"

    period_labels = [period_header_fn(p) for p in period_list]
    period_years = [year_fn(p) if year_fn else None for p in period_list]
    yr_attrs = [f" data-yr='{y}'" if y else "" for y in period_years]

    tickets_json = "[" + ",".join(tickets) + "]"
    rows_json = "[" + ",".join(f"[{r['sku']},{r['prod']},{r['cls']},{r['cat']},{r['batch']}]" for r in rows_out) + "]"
    parents_json = "[" + ",".join(f"[{p['sku']}]" for p in parents_out) + "]"
    prod_g_json = "[" + ",".join(f"[{g['parentIdx']},{g['prod']},{g['sku']}]" for g in prod_groups) + "]"
    cls_g_json = "[" + ",".join(f"[{g['productGroupIdx']},{g['cls']},{g['sku']}]" for g in cls_groups) + "]"
    cat_g_json = "[" + ",".join(f"[{g['classGroupIdx']},{g['cat']},{g['sku']}]" for g in cat_groups) + "]"
    row_cat_json = "[" + ",".join(str(x) for x in row_cat_idx) + "]"
    skus_json, prods_json, classes_json, cats_json, batches_json = aj(SKUS), aj(PRODS), aj(CLASSES), aj(CATS), aj(BATCHES)
    periods_json = aj(period_labels)
    prosales_json = "[" + ",".join("[" + ",".join(str(v) for v in row) + "]" for row in PROSALES) + "]"

    pg_by_p = {}
    for i, g in enumerate(prod_groups):
        pg_by_p.setdefault(g["parentIdx"], []).append(i)
    cg_by_pg = {}
    for i, g in enumerate(cls_groups):
        cg_by_pg.setdefault(g["productGroupIdx"], []).append(i)
    cat_by_cg = {}
    for i, g in enumerate(cat_groups):
        cat_by_cg.setdefault(g["classGroupIdx"], []).append(i)
    rows_by_cat = {}
    for i, k in enumerate(row_cat_idx):
        rows_by_cat.setdefault(k, []).append(i)

    t = [f"<div class='pivot-scroll ppk-scroll'><table class='pivot-table ppk-pivot-table' id='{prefix}-pivot-table'><thead><tr>"
         "<th class='corner'>SKU</th><th class='corner'>Product Name</th><th class='corner'>Query Class</th>"
         "<th class='corner'>Query Category</th><th class='corner'>Batch Number</th>"]
    for i, lbl in enumerate(period_labels):
        t.append(f"<th colspan='2' class='month-hdr'{yr_attrs[i]}>{h_enc(lbl)}</th>")
    t.append("</tr><tr><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th>")
    for i in range(n):
        t.append(f"<th class='sub-hdr'{yr_attrs[i]}>complain</th><th class='sub-hdr'{yr_attrs[i]}>complain%</th>")
    t.append("</tr></thead><tbody>")
    for pi, p in enumerate(parents_out):
        z = "zebra" if (pi + 1) % 2 == 1 else ""
        t.append(f"<tr class='{z} ppk-lvl1' id='{prefix}-parent-{pi}' style='font-weight:700;'><td class='rowlabel' title=\"{h_enc(SKUS[p['sku']])}\">"
                 f"<span id='{prefix}-icon-1-{pi}' class='ppk-toggle-icon' onclick=\"ppkToggle('{prefix}',1,{pi},event)\" style='cursor:pointer;'>+</span>{h_enc(SKUS[p['sku']])}</td>"
                 f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td>")
        for mi in range(n):
            t.append(f"<td class='num' id='{prefix}-p-{pi}-{mi}-cnt'{yr_attrs[mi]}>-</td><td class='pct' id='{prefix}-p-{pi}-{mi}-pct'{yr_attrs[mi]}>-</td>")
        t.append("</tr>")
        for pgi in pg_by_p.get(pi, []):
            pg = prod_groups[pgi]
            t.append(f"<tr class='ppk-lvl2 {prefix}-child-of-p{pi}' id='{prefix}-pg-{pgi}' style='display:none;font-weight:600;background:var(--surface-1);'>"
                     f"<td class='rowlabel'></td><td class='rowlabel' title=\"{h_enc(PRODS[pg['prod']])}\">"
                     f"<span id='{prefix}-icon-2-{pgi}' class='ppk-toggle-icon' onclick=\"ppkToggle('{prefix}',2,{pgi},event)\" style='cursor:pointer;'>+</span>{h_enc(PRODS[pg['prod']])}</td>"
                     f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td>")
            for mi in range(n):
                t.append(f"<td class='num' id='{prefix}-pg-{pgi}-{mi}-cnt'{yr_attrs[mi]}>-</td><td class='pct' id='{prefix}-pg-{pgi}-{mi}-pct'{yr_attrs[mi]}>-</td>")
            t.append("</tr>")
            for cgi in cg_by_pg.get(pgi, []):
                cg = cls_groups[cgi]
                t.append(f"<tr class='ppk-lvl3 {prefix}-child-of-pg{pgi}' id='{prefix}-cg-{cgi}' style='display:none;background:var(--pivot-zebra-bg);'>"
                         f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel' title=\"{h_enc(CLASSES[cg['cls']])}\">"
                         f"<span id='{prefix}-icon-3-{cgi}' class='ppk-toggle-icon' onclick=\"ppkToggle('{prefix}',3,{cgi},event)\" style='cursor:pointer;'>+</span>{h_enc(CLASSES[cg['cls']])}</td>"
                         f"<td class='rowlabel'></td><td class='rowlabel'></td>")
                for mi in range(n):
                    t.append(f"<td class='num' id='{prefix}-cg-{cgi}-{mi}-cnt'{yr_attrs[mi]}>-</td><td class='pct' id='{prefix}-cg-{cgi}-{mi}-pct'{yr_attrs[mi]}>-</td>")
                t.append("</tr>")
                for catgi in cat_by_cg.get(cgi, []):
                    catg = cat_groups[catgi]
                    t.append(f"<tr class='ppk-lvl4 {prefix}-child-of-cg{cgi}' id='{prefix}-catg-{catgi}' style='display:none;'>"
                             f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel' title=\"{h_enc(CATS[catg['cat']])}\">"
                             f"<span id='{prefix}-icon-4-{catgi}' class='ppk-toggle-icon' onclick=\"ppkToggle('{prefix}',4,{catgi},event)\" style='cursor:pointer;'>+</span>{h_enc(CATS[catg['cat']])}</td>"
                             f"<td class='rowlabel'></td>")
                    for mi in range(n):
                        t.append(f"<td class='num' id='{prefix}-catg-{catgi}-{mi}-cnt'{yr_attrs[mi]}>-</td><td class='pct' id='{prefix}-catg-{catgi}-{mi}-pct'{yr_attrs[mi]}>-</td>")
                    t.append("</tr>")
                    for ri in rows_by_cat.get(catgi, []):
                        c = rows_out[ri]
                        t.append(f"<tr class='ppk-lvl5 {prefix}-child-of-catg{catgi}' id='{prefix}-row-{ri}' style='display:none;background:var(--surface-card);'>"
                                 f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td>"
                                 f"<td class='rowlabel' title=\"{h_enc(BATCHES[c['batch']])}\">{h_enc(BATCHES[c['batch']])}</td>")
                        for mi in range(n):
                            t.append(f"<td class='num' id='{prefix}-row-{ri}-{mi}-cnt'{yr_attrs[mi]}>-</td><td class='pct' id='{prefix}-row-{ri}-{mi}-pct'{yr_attrs[mi]}>-</td>")
                        t.append("</tr>")
    t.append("</tbody></table></div>")

    js = """
<script>
(function(){
  var PFX='__PFX__';
  var TICKETS=__TICKETS_JSON__,SKUS=__SKUS_JSON__,PRODS=__PRODS_JSON__,CLASSES=__CLASSES_JSON__,CATS=__CATS_JSON__,BATCHES=__BATCHES_JSON__,PERIODS=__PERIODS_JSON__,PROSALES=__PROSALES_JSON__;
  var ROWS=__ROWS_JSON__,ROW_CATGROUP=__ROW_CAT_JSON__,PARENTS=__PARENTS_JSON__,PRODUCT_GROUPS=__PROD_G_JSON__,CLASS_GROUPS=__CLS_G_JSON__,CATEGORY_GROUPS=__CAT_G_JSON__,N=PERIODS.length;
  var e1={},e2={},e3={},e4={},EB={1:e1,2:e2,3:e3,4:e4};
  function eid(s){return PFX+s;}
  function fmt(n){return n.toLocaleString('en-IN');}
  function leafCounts(f){ var c=[]; for(var ri=0;ri<ROWS.length;ri++){c.push(new Array(N).fill(0));} var idx={}; for(var r2=0;r2<ROWS.length;r2++){idx[ROWS[r2].join('|')]=r2;}
    for(var i=0;i<TICKETS.length;i++){ var t=TICKETS[i],mo=t[0],sku=t[1],pr=t[2],cl=t[3],ca=t[4],ba=t[5];
      if(mo<0||mo>=N||sku<0||sku>=SKUS.length||pr<0||pr>=PRODS.length||cl<0||cl>=CLASSES.length||ca<0||ca>=CATS.length||ba<0||ba>=BATCHES.length)continue;
      if(f.month!==null&&mo!==f.month)continue; if(f.product!==null&&pr!==f.product)continue; if(f.sku!==null&&sku!==f.sku)continue; if(f.cls!==null&&cl!==f.cls)continue; if(f.category!==null&&ca!==f.category)continue;
      var k=sku+'|'+pr+'|'+cl+'|'+ca+'|'+ba; var ri=idx[k]; if(ri===undefined)continue; c[ri][mo]++; } return c; }
  function sm(a,b){var o=new Array(a.length);for(var i=0;i<a.length;i++){o[i]=a[i]+b[i];}return o;}
  function has(a){for(var i=0;i<a.length;i++){if(a[i]>0)return true;}return false;}
  function wc(sub,idx,arr,skuIdx){ var psRow=(skuIdx!=null&&PROSALES[skuIdx])?PROSALES[skuIdx]:null; for(var mi=0;mi<N;mi++){ var v=arr[mi],s=psRow?psRow[mi]:0,p=s>0?Math.round(v/s*100000)/1000:0; var cc=document.getElementById(eid(sub+'-'+idx+'-'+mi+'-cnt')),pc=document.getElementById(eid(sub+'-'+idx+'-'+mi+'-pct')); if(cc)cc.textContent=v>0?fmt(v):'-'; if(pc)pc.textContent=v>0?(p+'%'):'-'; } }
  var DIMS=['month','product','sku','cls','category'],SIDS={month:eid('-filter-month'),product:eid('-filter-product'),sku:eid('-filter-sku'),cls:eid('-filter-class'),category:eid('-filter-category')},TP={month:0,sku:1,product:2,cls:3,category:4};
  function rf(){ var g=function(fid){var e=document.getElementById(fid);return e?e.value:'';}; return {month:g(SIDS.month)?PERIODS.indexOf(g(SIDS.month)):null,product:g(SIDS.product)?PRODS.indexOf(g(SIDS.product)):null,sku:g(SIDS.sku)?SKUS.indexOf(g(SIDS.sku)):null,cls:g(SIDS.cls)?CLASSES.indexOf(g(SIDS.cls)):null,category:g(SIDS.category)?CATS.indexOf(g(SIDS.category)):null}; }
  function tmatch(t,f,ex){ for(var d=0;d<DIMS.length;d++){var dim=DIMS[d]; if(dim===ex)continue; var w=f[dim]; if(w===null)continue; if(t[TP[dim]]!==w)return false;} return true; }
  function upd(f){ DIMS.forEach(function(dim){ var valid={}; for(var i=0;i<TICKETS.length;i++){var t=TICKETS[i]; if(tmatch(t,f,dim)){valid[t[TP[dim]]]=true;}}
    var input=document.getElementById(SIDS[dim]); if(!input)return; var list=document.getElementById(SIDS[dim]+'-list'); if(!list)return;
    var curConfirmed=input.dataset.confirmed||''; var curStillValid=true;
    list.querySelectorAll('.ss-opt').forEach(function(o){ var ix=o.getAttribute('data-idx'),ok=(ix==='')?true:!!valid[parseInt(ix,10)]; o.setAttribute('data-invalid',ok?'0':'1'); if(curConfirmed!==''&&o.getAttribute('data-value')===curConfirmed&&!ok){curStillValid=false;} });
    if(!curStillValid){ input.value=''; input.dataset.confirmed=''; }
    window.ssRefresh(input,list);
  }); }
  function sk_(a,skuIdx){var LP=N-1,c=a[LP],ps=(skuIdx!=null&&PROSALES[skuIdx])?PROSALES[skuIdx][LP]:0,p=ps>0?c/ps:0;return {c:c,p:p};}
  function cmp(a,b,skuA,skuB){var ka=sk_(a,skuA),kb=sk_(b,skuB); if(kb.c!==ka.c)return kb.c-ka.c; return kb.p-ka.p;}
  function render(){ try{ var f=rf(); upd(f); f=rf(); var lc=leafCounts(f);
      var catgC=CATEGORY_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var ri=0;ri<ROWS.length;ri++){var ci=ROW_CATGROUP[ri]; if(ci!==undefined&&catgC[ci]){catgC[ci]=sm(catgC[ci],lc[ri]);} wc('-row',ri,lc[ri],ROWS[ri][0]);}
      var clsC=CLASS_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var cg=0;cg<CATEGORY_GROUPS.length;cg++){var k=CATEGORY_GROUPS[cg][0]; if(clsC[k]){clsC[k]=sm(clsC[k],catgC[cg]);} wc('-catg',cg,catgC[cg],CATEGORY_GROUPS[cg][2]);}
      var pgC=PRODUCT_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var c2=0;c2<CLASS_GROUPS.length;c2++){var k2=CLASS_GROUPS[c2][0]; if(pgC[k2]){pgC[k2]=sm(pgC[k2],clsC[c2]);} wc('-cg',c2,clsC[c2],CLASS_GROUPS[c2][2]);}
      var pC=PARENTS.map(function(){return new Array(N).fill(0);});
      for(var p2=0;p2<PRODUCT_GROUPS.length;p2++){var k3=PRODUCT_GROUPS[p2][0]; if(pC[k3]){pC[k3]=sm(pC[k3],pgC[p2]);} wc('-pg',p2,pgC[p2],PRODUCT_GROUPS[p2][2]);}
      for(var pi=0;pi<PARENTS.length;pi++){wc('-p',pi,pC[pi],PARENTS[pi][0]);}
      var withData=0;
      for(var p3=0;p3<PARENTS.length;p3++){var hd=has(pC[p3]),el=document.getElementById(eid('-parent-'+p3)); if(el)el.style.display=hd?'':'none'; if(hd)withData++;}
      for(var pg3=0;pg3<PRODUCT_GROUPS.length;pg3++){var hd2=has(pgC[pg3]),par=PRODUCT_GROUPS[pg3][0],el2=document.getElementById(eid('-pg-'+pg3)); if(el2)el2.style.display=(!!e1[par]&&hd2)?'':'none';}
      for(var cg3=0;cg3<CLASS_GROUPS.length;cg3++){var hd3=has(clsC[cg3]),par2=CLASS_GROUPS[cg3][0],el3=document.getElementById(eid('-cg-'+cg3)); if(el3)el3.style.display=(!!e2[par2]&&hd3)?'':'none';}
      for(var ca3=0;ca3<CATEGORY_GROUPS.length;ca3++){var hd4=has(catgC[ca3]),par3=CATEGORY_GROUPS[ca3][0],el4=document.getElementById(eid('-catg-'+ca3)); if(el4)el4.style.display=(!!e3[par3]&&hd4)?'':'none';}
      for(var r4=0;r4<ROWS.length;r4++){var hd5=has(lc[r4]),par4=ROW_CATGROUP[r4],el5=document.getElementById(eid('-row-'+r4)); if(el5)el5.style.display=(!!e4[par4]&&hd5)?'':'none';}
      var tb=document.querySelector('#'+eid('-pivot-table')+' tbody');
      if(tb){ var po=PARENTS.map(function(_,i){return i;}); po.sort(function(a,b){return cmp(pC[a],pC[b],PARENTS[a][0],PARENTS[b][0]);});
        var pgBy={};PRODUCT_GROUPS.forEach(function(x,i){var k=x[0];(pgBy[k]=pgBy[k]||[]).push(i);});
        var cgBy={};CLASS_GROUPS.forEach(function(x,i){var k=x[0];(cgBy[k]=cgBy[k]||[]).push(i);});
        var caBy={};CATEGORY_GROUPS.forEach(function(x,i){var k=x[0];(caBy[k]=caBy[k]||[]).push(i);});
        var rBy={};ROWS.forEach(function(_,i){var k=ROW_CATGROUP[i];(rBy[k]=rBy[k]||[]).push(i);});
        po.forEach(function(pi){ var pe=document.getElementById(eid('-parent-'+pi)); if(pe)tb.appendChild(pe); var pSku=PARENTS[pi][0];
          (pgBy[pi]||[]).slice().sort(function(a,b){return cmp(pgC[a],pgC[b],pSku,pSku);}).forEach(function(pgi){ var pge=document.getElementById(eid('-pg-'+pgi)); if(pge)tb.appendChild(pge); var pgSku=PRODUCT_GROUPS[pgi][2];
            (cgBy[pgi]||[]).slice().sort(function(a,b){return cmp(clsC[a],clsC[b],pgSku,pgSku);}).forEach(function(cgi){ var cge=document.getElementById(eid('-cg-'+cgi)); if(cge)tb.appendChild(cge); var cgSku=CLASS_GROUPS[cgi][2];
              (caBy[cgi]||[]).slice().sort(function(a,b){return cmp(catgC[a],catgC[b],cgSku,cgSku);}).forEach(function(cai){ var cae=document.getElementById(eid('-catg-'+cai)); if(cae)tb.appendChild(cae); var caSku=CATEGORY_GROUPS[cai][2];
                (rBy[cai]||[]).slice().sort(function(a,b){return cmp(lc[a],lc[b],caSku,caSku);}).forEach(function(ri){ var re=document.getElementById(eid('-row-'+ri)); if(re)tb.appendChild(re); }); }); }); }); }); }
      var note=document.getElementById(eid('-filter-note')); if(note){note.textContent=withData+' of '+PARENTS.length+' SKUs have complaints for the selected filters, sorted by '+PERIODS[N-1]+' complaints. Expand SKU → Product → Query Class → Query Category to drill down.'; note.style.color='';}
    }catch(e){ var n2=document.getElementById(eid('-filter-note')); if(n2){n2.textContent='Filter error: '+e.message;n2.style.color='var(--s6)';} if(window.console)console.error('ProdPkg error ('+PFX+')',e); } }
  window.PPK_INSTANCES = window.PPK_INSTANCES || {};
  window.PPK_INSTANCES[PFX] = { render: render, toggle: function(lv,idx,ev){ if(ev)ev.stopPropagation(); var s=EB[lv]; s[idx]=!s[idx]; var ic=document.getElementById(eid('-icon-'+lv+'-'+idx)); if(ic)ic.textContent=s[idx]?'−':'+'; render(); } };
  function init(){render();}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();
</script>
"""
    js = (js.replace("__PFX__", prefix)
            .replace("__TICKETS_JSON__", tickets_json).replace("__SKUS_JSON__", skus_json)
            .replace("__PRODS_JSON__", prods_json).replace("__CLASSES_JSON__", classes_json)
            .replace("__CATS_JSON__", cats_json).replace("__BATCHES_JSON__", batches_json)
            .replace("__PERIODS_JSON__", periods_json).replace("__PROSALES_JSON__", prosales_json)
            .replace("__ROWS_JSON__", rows_json).replace("__ROW_CAT_JSON__", row_cat_json)
            .replace("__PARENTS_JSON__", parents_json).replace("__PROD_G_JSON__", prod_g_json)
            .replace("__CLS_G_JSON__", cls_g_json).replace("__CAT_G_JSON__", cat_g_json))

    def dd(id_, lbl, opts):
        s = [f"<div style='display:flex;flex-direction:column;gap:4px;min-width:150px;position:relative;'>"
             f"<label for='{id_}' style='font-size:11px;color:var(--text-muted);'>{h_enc(lbl)}</label>"]
        # oninput/onfocus open the dropdown (and live-filter it as you type); onblur reverts
        # any uncommitted text back to the last confirmed value (deferred via
        # window.ssBlurCheck so a same-click .ss-opt selection - which updates
        # value/data-confirmed together - lands first, making the revert a no-op); onchange
        # covers manually typing an exact match and tabbing/clicking away without using the
        # dropdown, syncing data-confirmed the same way window.ssPick does.
        s.append(f"<div style='position:relative;'><input type='text' id='{id_}' class='ss-input' data-confirmed='' placeholder='All' autocomplete='off' "
                 f"oninput=\"window.ssOpen(this)\" onfocus=\"window.ssOpen(this)\" onblur=\"window.ssBlurCheck(this)\" "
                 f"onchange=\"this.dataset.confirmed=this.value; onProdPkgFilterChange('{prefix}')\" "
                 f"style='font-size:12.5px;padding:7px 26px 7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;max-width:220px;width:100%;box-sizing:border-box;'>"
                 f"<span style='position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-muted);font-size:10px;'>&#9662;</span></div>")
        s.append(f"<div class='ss-list' id='{id_}-list'><div class='ss-opt' data-value='' data-idx='' onclick=\"window.ssPick('{prefix}','{id_}',this)\">All</div>")
        for oi, opt in enumerate(opts):
            s.append(f"<div class='ss-opt' data-value=\"{h_enc(opt)}\" data-idx='{oi}' onclick=\"window.ssPick('{prefix}','{id_}',this)\">{h_enc(opt)}</div>")
        s.append("</div></div>")
        return "".join(s)

    filter_html = ("<div style='display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-end;'>"
                   + dd(f"{prefix}-filter-month", filter_label, period_labels) + dd(f"{prefix}-filter-product", "Product Name", PRODS)
                   + dd(f"{prefix}-filter-sku", "SKU", SKUS) + dd(f"{prefix}-filter-class", "Query Class", CLASSES)
                   + dd(f"{prefix}-filter-category", "Query Category", CATS)
                   + f"</div><div id='{prefix}-filter-note' style='font-size:12px;color:var(--text-muted);margin-bottom:14px;'></div>")

    return {
        "table_html": "".join(t), "filter_html": filter_html, "js": js,
        "combo_tot": combo_tot, "combo_mc": combo_mc, "LP": LP,
        "SKUS": SKUS, "PRODS": PRODS, "CLASSES": CLASSES, "CATS": CATS, "BATCHES": BATCHES,
        "sku_tree": sku_tree, "top_sku": top_sku, "PROSALES": PROSALES, "lmk": lmk,
    }


_PPK_DISPATCH_JS = """<script>
window.ppkToggle=function(prefix,lv,idx,ev){ var inst=window.PPK_INSTANCES&&window.PPK_INSTANCES[prefix]; if(inst)inst.toggle(lv,idx,ev); };
window.onProdPkgFilterChange=function(prefix){ var inst=window.PPK_INSTANCES&&window.PPK_INSTANCES[prefix]; if(inst)inst.render(); };

// Searchable-combobox interactivity for every ProdPkg filter (.ss-input/.ss-list/.ss-opt) -
// shared once across every instance (monthly + one per weekly-eligible month) rather than
// duplicated per instance, since none of this depends on which prefix's data is involved.
window.ssRefresh=function(input,list){
  var q=(input.value||'').toLowerCase();
  list.querySelectorAll('.ss-opt').forEach(function(o){
    var invalid=o.getAttribute('data-invalid')==='1';
    var matches=q===''||o.textContent.toLowerCase().indexOf(q)!==-1;
    o.style.display=(matches&&!invalid)?'':'none';
  });
};
window.ssOpen=function(input){
  var list=document.getElementById(input.id+'-list'); if(!list) return;
  window.ssRefresh(input,list);
  list.style.display='block';
};
window.ssPick=function(prefix,inputId,opt){
  var input=document.getElementById(inputId); if(!input) return;
  var val=opt.getAttribute('data-value')||'';
  input.value=val; input.dataset.confirmed=val;
  var list=document.getElementById(inputId+'-list'); if(list) list.style.display='none';
  window.onProdPkgFilterChange(prefix);
};
window.ssBlurCheck=function(input){
  // Deferred (not synchronous) so a same-click selection on a .ss-opt - whose onclick
  // updates .value/.dataset.confirmed together - finishes first; this then becomes a
  // harmless no-op reset to the value that selection just set. Without the defer, blur
  // (which fires before the option's click) would revert the input before the click's
  // own handler ever runs.
  setTimeout(function(){ input.value = input.dataset.confirmed || ''; }, 0);
};
document.addEventListener('click', function(ev){
  document.querySelectorAll('.ss-list').forEach(function(list){
    var wrap = list.parentElement;
    if (wrap && !wrap.contains(ev.target)) list.style.display='none';
  });
});
</script>"""

_PPK_CSS = ("<style>.ppk-scroll{max-height:640px;overflow-y:auto;}.ppk-pivot-table thead th{position:sticky;top:0;z-index:4;}"
            ".ppk-pivot-table thead tr:nth-child(2) th{top:28px;}.ppk-toggle-icon{display:inline-block;width:14px;font-weight:700;color:var(--s1);}"
            ".ppk-pivot-table td.rowlabel{position:sticky;z-index:3;background:var(--surface-card);}.ppk-pivot-table th.corner{z-index:6;}"
            ".ppk-pivot-table th.corner:nth-child(1),.ppk-pivot-table td.rowlabel:nth-child(1){left:0;width:90px;min-width:90px;max-width:90px;}"
            ".ppk-pivot-table th.corner:nth-child(2),.ppk-pivot-table td.rowlabel:nth-child(2){left:90px;width:190px;min-width:190px;max-width:190px;}"
            ".ppk-pivot-table th.corner:nth-child(3),.ppk-pivot-table td.rowlabel:nth-child(3){left:280px;width:130px;min-width:130px;max-width:130px;}"
            ".ppk-pivot-table th.corner:nth-child(4),.ppk-pivot-table td.rowlabel:nth-child(4){left:410px;width:170px;min-width:170px;max-width:170px;}"
            ".ppk-pivot-table th.corner:nth-child(5),.ppk-pivot-table td.rowlabel:nth-child(5){left:580px;width:110px;min-width:110px;max-width:110px;box-shadow:2px 0 4px -2px rgba(0,0,0,0.25);}</style>")


def build_prod_pkg_panel(ctx):
    months = ctx.months
    ppsub = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) in ("Packaging and Operational", "Product")]

    def month_index_fn(r):
        mo = ctx.cell(r, ctx.col["month"])
        return months.index(mo) if mo in months else -1

    core = _build_ppk_core(ctx, ppsub, months, month_index_fn, lambda mo: mo, "ppk", "Month", year_fn=year_of)

    weekly_block = build_weekly_prod_pkg_block(ctx)

    if core is None:
        return (f'  <div class="tab-panel" id="panel-prodpkg"><section><h2>Product Packaging and Operational Complaints wrt Product Sales</h2>'
                f'<p class="note">No Product/Packaging tickets found.</p></section></div>')

    LP = core["LP"]
    combo_tot, combo_mc, PROSALES = core["combo_tot"], core["combo_mc"], core["PROSALES"]
    SKUS, PRODS, CLASSES, CATS, BATCHES = core["SKUS"], core["PRODS"], core["CLASSES"], core["CATS"], core["BATCHES"]
    sku_tree, top_sku, lmk = core["sku_tree"], core["top_sku"], core["lmk"]

    # ---- insights: sharpest single combo + top SKU overall, both by last month volume ----
    ppk_items = []
    top_key = None
    top_combo_val = -1
    for ck in combo_tot:
        cval = combo_mc[ck][LP]
        if cval > top_combo_val:
            top_combo_val, top_key = cval, ck
    if top_key and top_combo_val > 0:
        si, tpi, tli, tci, tbi = (int(x) for x in top_key.split("|"))
        combo_lm_ps = PROSALES[si][LP]
        pct = round1(top_combo_val / combo_lm_ps * 100) if combo_lm_ps > 0 else 0
        from gen_insights import insight_item
        ppk_items.append(insight_item("watch", f"Sharpest single pain point in {pretty_month(months[LP])}: <b>{h_enc(SKUS[si])}</b> / {h_enc(PRODS[tpi])} "
                                                 f"&mdash; {h_enc(CLASSES[tli])} &rarr; {h_enc(CATS[tci])} (batch {h_enc(BATCHES[tbi])}), {n0(top_combo_val)} tickets ({fnum(pct)}% of that SKU's sales last month)."))
    if top_sku:
        ts_idx = int(top_sku[0])
        ts_val = lmk(sku_tree[top_sku[0]]["mc"], ts_idx)["cnt"]
        if ts_val > 0:
            ts_lm_ps = PROSALES[ts_idx][LP]
            ts_pct = round1(ts_val / ts_lm_ps * 100) if ts_lm_ps > 0 else 0
            from gen_insights import insight_item
            ppk_items.append(insight_item("info", f"SKU with the most product/packaging complaints overall in {pretty_month(months[LP])}: "
                                                     f"<b>{h_enc(SKUS[ts_idx])}</b> &mdash; {n0(ts_val)} tickets ({fnum(ts_pct)}% of that SKU's sales last month)."))
    ppk_insights = build_insights_card("Insights &mdash; Product &amp; Packaging", ppk_items)

    return f"""  <div class="tab-panel" id="panel-prodpkg">
    <section>
      <h2>Product Packaging and Operational Complaints wrt Product Sales</h2>
      <p class="desc">Combines "Product" and "Packaging and Operational" tickets by SKU &rarr; Product &rarr; Query Class &rarr; Query Category &rarr; Batch. Click the + at each level to drill down; percent = complaints &divide; that SKU's own product sales that period (not the company-wide sales figure used elsewhere in this report). Weekly follows the Monthly/Weekly toggle and month picker above.</p>
      {raw_download_link(ctx, "prodpkg")}
      <div class="gran-monthly">
        {core["filter_html"]}
        <div class='pivot-wrap'><div class='pivot-title'>Product Packaging and Operational Complaints wrt Product Sales</div>{core["table_html"]}</div>
      </div>
      {weekly_block}
    </section>
    {ppk_insights}
  </div>
{_PPK_CSS}
{_PPK_DISPATCH_JS}
{core["js"]}"""


def build_weekly_prod_pkg_block(ctx):
    """One full drill-down instance per weekly-eligible month, shown/hidden by the existing
    page-wide gran_toolbar's Weekly mode + month-chip picker (same '.gran-weekly
    data-month=...' mechanism every other weekly table already uses) - no new toggle JS
    needed here, just correctly-tagged HTML per month."""
    if not ctx.weekly_eligible_months:
        return ""
    ppsub_all = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) in ("Packaging and Operational", "Product")]
    parts = []
    for mi in ctx.weekly_eligible_months:
        week_list = ctx.weeks_by_month_idx[mi]
        month_label = ctx.months[mi]
        if not week_list:
            continue
        subset = [r for r in ppsub_all if ctx.cell(r, ctx.col["month"]) == month_label]
        prefix = f"ppkw{mi}"

        def week_index_fn(r, week_list=week_list):
            wk = ctx.cell(r, ctx.col["week"])
            if not str(wk).strip() or wk == "#N/A":
                return -1
            return week_list.index(wk) if wk in week_list else -1

        def week_header_fn(wk, mi=mi):
            return week_col_header(ctx, wk, mi)

        core = _build_ppk_core(ctx, subset, week_list, week_index_fn, week_header_fn, prefix, "Week")
        if core is None:
            parts.append(f"<div class='gran-weekly' data-month='{mi}' style='display:none;'>"
                         f"<p class='note'>No Product/Packaging tickets in {h_enc(pretty_month(month_label))}.</p></div>")
            continue
        parts.append(f"<div class='gran-weekly' data-month='{mi}' style='display:none;'>"
                     f"<p class='note'>Weekly view for {h_enc(pretty_month(month_label))}.</p>"
                     f"{core['filter_html']}"
                     f"<div class='pivot-wrap'><div class='pivot-title'>Product Packaging and Operational Complaints wrt Product Sales (Weekly)</div>{core['table_html']}</div>"
                     f"</div>{core['js']}")
    return "".join(parts)


def _backfill_years(raw_labels):
    """Years for a run of sheet month labels, filling in the ones that carry none.
    Same problem (and same walk-backward-decrementing-on-wraparound fix) as build_combo2's
    inline version: these sheets label some months without a year at all ("12_Dec" vs
    "2_Feb'26"), and a chart that leaves those blank silently ignores the Year filter."""
    import re as _re
    n = len(raw_labels)
    raw_years = [year_of(m) for m in raw_labels]
    month_nums = []
    for m in raw_labels:
        mm = _re.match(r"^(\d+)_", str(m))
        month_nums.append(int(mm.group(1)) if mm else 0)
    out = [None] * n
    carry = None
    for i in range(n - 1, -1, -1):
        if raw_years[i]:
            carry = raw_years[i]
        elif carry and i < (n - 1) and month_nums[i] > 0 and month_nums[i + 1] > 0 and month_nums[i] > month_nums[i + 1]:
            carry = str(int(carry) - 1)
        out[i] = carry
    return out


def build_rto_funnel_chart(series):
    """Grouped Punched/Delivered bars plus a Tentative Revenue line, drawn client-side by
    renderRtoFunnelChart (see _shell_head.html) so the Year filter can redraw it - same
    contract as build_combo2's charts. `series` is a list of
    (raw_month_label, rto, punched, delivered, conv, revenue); the raw label is kept because
    pretty_month/year_of are applied here, matching how every other chart labels its x-axis.
    Conversion% and Total RTO aren't plotted but ride along for the hover tooltip."""
    if not series:
        return ""
    labels = [pretty_month(s[0]) for s in series]
    years = _backfill_years([s[0] for s in series])
    W, H, pad_l, pad_r, pad_t, pad_b = 1120, 420, 62, 88, 40, 55
    cid = _next_chart_id("rtofunnel")

    def arr(i):
        return "[" + ",".join(str(s[i]) for s in series) + "]"

    legend = (
        f"<div class='legend-row' id='{cid}-legend' style='justify-content:center;'>"
        f"<div class='legend-item' data-series='punched'><span class='swatch' style='background:var(--s1);'></span><span class='lname'>Total Punched</span></div>"
        f"<div class='legend-item' data-series='delivered'><span class='swatch' style='background:var(--s2);'></span><span class='lname'>Total Delivered</span></div>"
        f"<div class='legend-item' data-series='revenue'><span class='swatch' style='background:var(--s6);border-radius:50%;'></span><span class='lname'>Tentative Revenue</span></div>"
        f"</div>"
    )
    labels_json = "[" + ",".join(f'"{j_enc(m)}"' for m in labels) + "]"
    years_json = "[" + ",".join(f'"{j_enc(y)}"' if y else "null" for y in years) + "]"
    return (
        f"<div class='card chart-wrap'>"
        f"<div class='pivot-title' style='margin-bottom:18px;'>RTO Funnel &mdash; Punched vs Delivered vs Revenue</div>"
        f"{legend}"
        f"<svg id='{cid}' viewBox='0 0 {W} {H}' width='100%' height='{H}' role='img'></svg>"
        f"<div class='chart-tip' id='{cid}-tip'></div></div>"
        f"""<script>
(function(){{
  var svg = document.getElementById('{cid}');
  var tip = document.getElementById('{cid}-tip');
  var legend = document.getElementById('{cid}-legend');
  var opts = {{ labels:{labels_json}, years:{years_json}, rto:{arr(1)}, punched:{arr(2)},
    delivered:{arr(3)}, conv:{arr(4)}, revenue:{arr(5)},
    W:{W}, H:{H}, padL:{pad_l}, padR:{pad_r}, padT:{pad_t}, padB:{pad_b} }};
  var hidden = {{}};
  function draw(){{ window.renderRtoFunnelChart(svg, tip, opts, hidden); }}
  legend.addEventListener('click', function(ev){{
    var it = ev.target.closest('.legend-item[data-series]');
    if (!it) return;
    var k = it.getAttribute('data-series');
    hidden[k] = !hidden[k];
    it.classList.toggle('legend-off', !!hidden[k]);
    draw();
  }});
  window.registerYearChart(draw);
}})();
</script>"""
    )


def build_rto_conversion_panel(ctx):
    """RTO (Return to Origin) volume vs. how many of that month's RTOs were re-punched
    and ultimately re-delivered, pulled straight from the brand's own "Sales per month"
    sheet tab (see brands.py's rto_conv_range) - a plain read-through table, not derived
    from ticket rows like every other tab here."""
    rows = ctx.rto_conv_rows or []
    if len(rows) < 2:
        return ('  <div class="tab-panel" id="panel-rtoconv"><section><h2>RTO Conversion</h2>'
                '<p class="note">No RTO-Conversion data found.</p></section></div>')

    header, data = rows[0], rows[1:]
    idx = {str(name).strip(): i for i, name in enumerate(header)}

    def cell(r, name):
        i = idx.get(name)
        return r[i] if i is not None and i < len(r) else ""

    def num(v):
        try:
            return float(str(v).replace(",", "").replace("%", "").strip())
        except (ValueError, AttributeError):
            return 0.0

    body_rows = []
    # Feeds build_rto_funnel_chart below, which keeps the RAW month label (it does its own
    # pretty_month/year_of parsing) alongside already-numeric values.
    chart_series = []
    zebra_i = 0
    for r in data:
        mo = cell(r, "Month")
        if not str(mo).strip():
            continue
        rto, punched, delivered, conv, rev = (
            num(cell(r, k)) for k in ("Total RTO", "Total Punched", "Total Delivered", "Conversion%", "Tentative Revenue")
        )
        chart_series.append((mo, rto, punched, delivered, round(conv, 2), rev))
        z = "zebra" if zebra_i % 2 == 1 else ""
        zebra_i += 1
        body_rows.append(
            f"<tr class='{z}'><td class='rowlabel'>{h_enc(pretty_month(mo))}</td>"
            f"<td class='num'>{n0(rto)}</td><td class='num'>{n0(punched)}</td><td class='num'>{n0(delivered)}</td>"
            f"<td class='num'>{fnum(round(conv, 2))}%</td><td class='num'>{n0(rev)}</td></tr>"
        )

    last_data_row = next((r for r in reversed(data) if str(cell(r, "Month")).strip()), None)
    kpi = ""
    if last_data_row is not None:
        conv = num(cell(last_data_row, "Conversion%"))
        rev = num(cell(last_data_row, "Tentative Revenue"))
        rto = num(cell(last_data_row, "Total RTO"))
        kpi = (f'<div class="kpi-row"><div class="kpi"><div class="label">Latest Month</div><div class="value">{h_enc(pretty_month(cell(last_data_row, "Month")))}</div></div>'
               f'<div class="kpi"><div class="label">Total RTO</div><div class="value">{n0(rto)}</div></div>'
               f'<div class="kpi"><div class="label">Conversion%</div><div class="value">{fnum(round(conv, 2))}%</div></div>'
               f'<div class="kpi"><div class="label">Tentative Revenue</div><div class="value">{n0(rev)}</div></div></div>')

    table = ("<div class='pivot-wrap'><div class='pivot-title'>RTO Conversion by Month</div><div class='pivot-scroll'>"
             "<table class='pivot-table'><thead><tr><th class='corner'>Month</th><th>Total RTO</th><th>Total Punched</th>"
             f"<th>Total Delivered</th><th>Conversion%</th><th>Tentative Revenue</th></tr></thead><tbody>{''.join(body_rows)}</tbody></table></div></div>")

    chart = build_rto_funnel_chart(chart_series)

    return f"""  <div class="tab-panel" id="panel-rtoconv">
    <section>
      <h2>RTO Conversion</h2>
      <p class="desc">Monthly RTO (Return to Origin) volume against how many were re-punched and ultimately delivered, from the "Sales per month" sheet tab.</p>
      {kpi}
      {table}
      {chart}
    </section>
  </div>"""


def assemble_report(ctx, here_dir):
    with open(here_dir / "_shell_head.html", "r", encoding="utf-8") as f:
        head = f.read()
    nav = ('<button class="tab-btn active" data-tab="csat">CSAT</button>'
           '<button class="tab-btn" data-tab="nps">NPS</button>'
           '<button class="tab-btn" data-tab="prodwisenps">Product wise NPS</button>'
           '<button class="tab-btn" data-tab="overview">Overview</button>'
           '<button class="tab-btn" data-tab="monthly">Monthly Analysis</button>'
           '<button class="tab-btn" data-tab="rtoconv">RTO-Conversion</button>')
    for c in ctx.b["classes"]:
        nav += f'<button class="tab-btn" data-tab="{c["id"]}">{h_enc(c["label"])}</button>'
    nav += '<button class="tab-btn" data-tab="prodpkg">Product &amp; Packaging wrt Sales</button>'

    panels = [f'<div class="tab-panel" id="panel-overview">{ctx.overview_html}</div>']
    panels.append(build_monthly_analysis_panel(ctx))
    for c in ctx.b["classes"]:
        kpi = ctx.kpi_row(c, [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == c["key"]])
        if c["id"] == "delivery":
            detail = build_cross_filter_panel(ctx, c, "partner", "Delivery Partner Name", f"{h_enc(c['label'])} Complaints wrt Delivery Partners", "alloc", "wrt allocation", 9999, "none")
        elif c["id"] == "technical":
            detail = build_cross_filter_panel(ctx, c, "platform", "Platform", f"{h_enc(c['label'])} Complaints by Platform", "sales", "wrt sales", 9999, "sinceFirst")
        elif c["id"] == "warehouse":
            detail = build_cross_filter_panel(ctx, c, "wh", "Warehouse Facility", f"{h_enc(c['label'])} Complaints by Warehouse Facility", "sales", "wrt sales", 9999, "none")
        elif c["id"] == "product":
            detail = build_cross_filter_panel(ctx, c, "prod", "Product Name", f"{h_enc(c['label'])} Complaints by Product", "sales", "wrt sales", 25, "none")
        elif c["id"] == "suggestion":
            detail = build_cross_filter_panel(ctx, c, "prod", "Product Name", f"{h_enc(c['label'])} Complaints by Product", "sales", "wrt sales", 25, "sparsePct")
        else:
            detail = build_class_panel(ctx, c)
        panels.append(f'<div class="tab-panel" id="panel-{c["id"]}">{kpi}\n{detail}</div>')

    now_str = ctx.now_ist.strftime("%d %b %Y, %H:%M") + " IST"
    foot = (f'<footer><p><strong>Methodology:</strong> Aggregated from the raw "{ctx.b["sheet_name"]}" tab. '
            f'Rows flagged "Duplicate" are excluded from per-class drill-downs (Overview shows both). '
            f'Percentages use the sheet\'s own "Total Sales M" / "Partner Allocation" figures.</p>'
            f'<p>Auto-refreshed daily at 2 PM IST. Last updated {now_str}. No customer PII (name, phone, email, etc.) is ever stored or exposed &mdash; '
            f'the tables/charts above are aggregated segment counts, and the optional "Download Raw Data" export on each tab is limited to non-PII ticket fields '
            f'(dates, category, product/SKU/batch, partner, month/week, sales figure, unique flag).</p></footer>')
    # When this report is embedded in the dashboard's iframe, its own tab row is
    # redundant with the sidebar's mirrored "Report Views" list (see index.html's
    # populateReportNav) - hide it there, but leave it visible when the report is
    # opened directly (e.g. /mcaffeine.html), since that's the only nav available then.
    tabjs = ("<script>document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){"
             "document.querySelectorAll('.tab-btn').forEach(function(x){x.classList.remove('active');});"
             "document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});"
             "b.classList.add('active');document.getElementById('panel-'+b.dataset.tab).classList.add('active');"
             "var t=document.getElementById('active-tab-title'); if(t)t.textContent=b.textContent;});});"
             "if(window.top!==window.self){var tn=document.querySelector('.tab-nav'); if(tn)tn.style.display='none';}"
             "</script>")

    month_chips = []
    last_eligible = ctx.weekly_eligible_months[-1] if ctx.weekly_eligible_months else -1
    for mi in ctx.weekly_eligible_months:
        act = " active" if mi == last_eligible else ""
        month_chips.append(f'<button type="button" class="month-chip{act}" data-month="{mi}" data-yr="{year_of(ctx.months[mi])}" '
                            f'onclick="toggleWeekMonthChip({mi})">{h_enc(pretty_month(ctx.months[mi]))}</button>')

    # Shared cross-table weekly data/helpers - every dynamic weekly table (Overview,
    # each class's category pivot+chart, Delivery's category/chart/partner tables; NOT
    # ProdPkg's wrt-Sales tab, which stays on its own per-month '.gran-weekly[data-month]'
    # mechanism, unaffected by any of this) reads these same arrays rather than each
    # building its own month/week bookkeeping.
    wk_month_of_json = "[" + ",".join(str(mi) for mi in ctx.week_month_of) + "]"
    wk_num_json = "[" + ",".join(str(get_week_num(wk)) for wk in ctx.all_weeks) + "]"
    wk_partial_json = "[" + ",".join(
        "true" if is_partial_week(ctx, ctx.all_weeks[gi], ctx.week_month_of[gi]) else "false"
        for gi in range(ctx.total_weeks)
    ) + "]"
    month_abbr_json = "[" + ",".join(f'"{j_enc(pretty_month(mo))}"' for mo in ctx.months) + "]"
    eligible_months_json = "[" + ",".join(str(mi) for mi in ctx.weekly_eligible_months) + "]"
    wk_sales_json = "[" + ",".join(str(v) for v in ctx.week_sales_arr) + "]"

    gran_toolbar = f"""<div class="gran-toolbar">
  <div class="gran-toggle">
    <button type="button" class="gran-btn active" data-gran="monthly" onclick="setGranularity('monthly')">Monthly</button>
    <button type="button" class="gran-btn" data-gran="weekly" onclick="setGranularity('weekly')">Weekly</button>
  </div>
  <div class="gran-month-picker" id="gran-month-wrap" style="display:none;">
    <span class="gran-note" style="font-weight:600;">Month</span>
    {''.join(month_chips)}
  </div>
  <span class="gran-note">Weekly applies to Overview and every complaint-category tab, including the category breakdown on Delivery/Technical/Warehouse/Product/Suggestion &mdash; but their second-dimension breakdown (partner/platform/facility/product name) and click-to-cross-filter stay monthly-only. Not available on NPS/CSAT, Product wise NPS, or the separate Product &amp; Packaging wrt Sales tab. Pick multiple months to see them side by side, split out by week (e.g. Jun W1, Jul W1, Jun W2, Jul W2, ...); the Year filter below also narrows which months are offered here.</span>
</div>
<script>
(function(){{
  var curGran='monthly';
  window.selectedWeekMonths = new Set([{last_eligible}]);
  var selectedWeekMonths = window.selectedWeekMonths;
  window.WK_MONTH_OF={wk_month_of_json}; window.WK_NUM={wk_num_json}; window.WK_PARTIAL={wk_partial_json};
  window.MONTH_ABBR={month_abbr_json}; window.ELIGIBLE_MONTHS={eligible_months_json}; window.WK_SALES={wk_sales_json};

  // Every weekly table registers a zero-arg render callback here (see gen_weekly.py's
  // block builders) instead of being pre-rendered once per month server-side - this way
  // a multi-month selection can lay out (month, week) columns week-major (Jun W1, Jul W1,
  // Jun W2, Jul W2, ...) instead of needing one full stacked table per selected month.
  window._weeklyRenderers = window._weeklyRenderers || [];
  window.registerWeeklyRenderer = function(fn){{ window._weeklyRenderers.push(fn); fn(); }};
  window.renderAllWeeklyTables = function(){{ window._weeklyRenderers.forEach(function(fn){{ fn(); }}); }};

  // Ordered global-week-indices to show for the current selection: every week-number
  // that any selected month has, in week-number order, cycling through the selected
  // months (in chronological order) within each week number - the interleaving the
  // multi-month case needs, since data is bucketed once per (month, week) pair, not
  // duplicated per possible selection.
  window.computeVisibleGlobalWeeks = function(){{
    var selected = window.ELIGIBLE_MONTHS.filter(function(mi){{ return selectedWeekMonths.has(mi); }});
    var maxWn = 0;
    for(var gi=0; gi<window.WK_MONTH_OF.length; gi++){{
      if(selected.indexOf(window.WK_MONTH_OF[gi])!==-1) maxWn=Math.max(maxWn, window.WK_NUM[gi]);
    }}
    var out=[];
    for(var wn=1; wn<=maxWn; wn++){{
      selected.forEach(function(mi){{
        for(var gi=0; gi<window.WK_MONTH_OF.length; gi++){{
          if(window.WK_MONTH_OF[gi]===mi && window.WK_NUM[gi]===wn){{ out.push(gi); }}
        }}
      }});
    }}
    return out;
  }};
  window.weeklyColumnLabel = function(gi, isMulti){{
    var lbl = 'W'+window.WK_NUM[gi]+(window.WK_PARTIAL[gi]?' (partial)':'');
    return isMulti ? (window.MONTH_ABBR[window.WK_MONTH_OF[gi]]+' '+lbl) : lbl;
  }};
  window.setWeeklyNote = function(elId){{
    var el=document.getElementById(elId); if(!el) return;
    var names = window.ELIGIBLE_MONTHS.filter(function(mi){{ return selectedWeekMonths.has(mi); }})
      .map(function(mi){{ return window.MONTH_ABBR[mi]; }});
    el.textContent = 'Weekly view for ' + names.join(' + ') + '.';
  }};
  function basisAt(basis, ri, gi){{ return Array.isArray(basis[0]) ? (basis[ri][gi]||0) : (basis[gi]||0); }}
  // Generic pivot table: rowLabels (array of strings) x counts (rowLabels.length dense
  // arrays, one entry per GLOBAL week index, 0 where absent) x basis (either one flat
  // array shared by every row - e.g. sales - or a matrix shaped like counts - e.g.
  // per-partner allocation, which differs row to row).
  window.renderMultiWeekPivot = function(containerId, rowLabels, counts, basis, cornerLabel, title, pctSuffix){{
    var el=document.getElementById(containerId); if(!el) return;
    var visGi = window.computeVisibleGlobalWeeks();
    if(!visGi.length){{ el.innerHTML=''; return; }}
    var isMulti = (new Set(visGi.map(function(gi){{return window.WK_MONTH_OF[gi];}}))).size>1;
    var h=["<div class='pivot-wrap'><div class='pivot-title'>"+window.escXml(title)+"</div><div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>"+window.escXml(cornerLabel)+"</th>"];
    visGi.forEach(function(gi){{ h.push("<th colspan='2' class='month-hdr'>"+window.escXml(window.weeklyColumnLabel(gi,isMulti))+"</th>"); }});
    h.push("</tr><tr>");
    visGi.forEach(function(){{ h.push("<th class='sub-hdr'>Count</th><th class='sub-hdr'>"+window.escXml(pctSuffix)+"</th>"); }});
    h.push("</tr></thead><tbody>");
    var totals = visGi.map(function(){{ return 0; }});
    rowLabels.forEach(function(lbl, ri){{
      h.push("<tr class='"+((ri%2===0)?'zebra':'')+"'><td class='rowlabel' title='"+window.escXml(lbl).replace(/'/g,'&#39;')+"'>"+window.escXml(lbl)+"</td>");
      visGi.forEach(function(gi, vi){{
        var cnt = counts[ri][gi]||0; totals[vi]+=cnt;
        var sm = basisAt(basis, ri, gi);
        var pct = sm>0 ? Math.round(cnt/sm*1000)/10 : 0;
        h.push("<td class='num'>"+(cnt>0?window.fmtN0(cnt):'-')+"</td><td class='pct'>"+(cnt>0&&sm>0?(pct+'%'):'-')+"</td>");
      }});
      h.push("</tr>");
    }});
    h.push("<tr class='total-row'><td class='rowlabel'>Total</td>");
    visGi.forEach(function(gi, vi){{
      var sm = Array.isArray(basis[0]) ? 0 : (basis[gi]||0);
      var pct = sm>0 ? Math.round(totals[vi]/sm*1000)/10 : 0;
      h.push("<td class='num'>"+window.fmtN0(totals[vi])+"</td><td class='pct'>"+(sm>0?(pct+'%'):'-')+"</td>");
    }});
    h.push("</tr></tbody></table></div></div>");
    el.innerHTML = h.join('');
  }};
  // Reuses the existing renderPctChart (bar+line SVG) verbatim by pre-computing the
  // interleaved vals/sales/labels for the currently-visible global weeks - REPORT_ACTIVE_
  // YEARS (the Year filter) never applies to weekly view, so passing '' for every
  // opts.months entry is safe (that field is only read for year-filtering).
  window.renderMultiWeekChart = function(svgId, totalsByGi, barColor, lineColor){{
    var svg=document.getElementById(svgId); if(!svg) return;
    var visGi = window.computeVisibleGlobalWeeks();
    var isMulti = (new Set(visGi.map(function(gi){{return window.WK_MONTH_OF[gi];}}))).size>1;
    var vals = visGi.map(function(gi){{ return totalsByGi[gi]||0; }});
    var sales = visGi.map(function(gi){{ return window.WK_SALES[gi]||0; }});
    var labels = visGi.map(function(gi){{ return window.weeklyColumnLabel(gi,isMulti); }});
    window.renderPctChart(svg, {{ vals:vals, months:vals.map(function(){{return '';}}), monthLabels:labels, sales:sales,
      barColor:barColor, lineColor:lineColor, W:1200, H:380, padL:55, padR:55, padT:40, padB:55 }});
  }};

  window.setGranularity=function(g){{
    curGran=g;
    document.querySelectorAll('.gran-btn').forEach(function(b){{b.classList.toggle('active',b.dataset.gran===g);}});
    var mw=document.getElementById('gran-month-wrap'); if(mw){{mw.style.display=(g==='weekly')?'':'none';}}
    applyGranularity();
    if(window.renderGeoForDeliveryTab) window.renderGeoForDeliveryTab();
  }};
  window.toggleWeekMonthChip=function(mi){{
    if(selectedWeekMonths.has(mi)){{ if(selectedWeekMonths.size>1){{selectedWeekMonths.delete(mi);}} }}
    else {{ selectedWeekMonths.add(mi); }}
    document.querySelectorAll('#gran-month-wrap .month-chip').forEach(function(b){{ b.classList.toggle('active', selectedWeekMonths.has(parseInt(b.dataset.month,10))); }});
    applyGranularity();
  }};
  window.applyGranularity=function(){{
    document.querySelectorAll('.gran-monthly').forEach(function(el){{el.style.display=(curGran==='monthly')?'':'none';}});
    document.querySelectorAll('.gran-weekly').forEach(function(el){{el.style.display='none';}});
    if(curGran==='weekly'){{
      document.querySelectorAll('.gran-weekly-dynamic').forEach(function(el){{el.style.display='';}});
      selectedWeekMonths.forEach(function(mi){{
        document.querySelectorAll('.gran-weekly[data-month="'+mi+'"]').forEach(function(el){{el.style.display='';}});
      }});
      window.renderAllWeeklyTables();
    }}
  }};
}})();
</script>
"""

    year_toolbar = ""
    if len(ctx.distinct_years) > 1:
        year_chips = "".join(f'<button type="button" class="year-chip active" data-yr="{y}" onclick="toggleYearChip(\'{y}\')">{y}</button>' for y in ctx.distinct_years)
        year_set_js = ",".join(f"'{y}'" for y in ctx.distinct_years)
        year_toolbar = f"""<div class="gran-toolbar">
  <span class="gran-note" style="font-weight:600;">Year</span>
  {year_chips}
  <span class="gran-note">Narrows which month columns/bars show in every table and chart on the page (weekly view and Monthly Analysis are unaffected).</span>
</div>
<script>
(function(){{
  var activeYears = new Set([{year_set_js}]);
  window.REPORT_ACTIVE_YEARS = activeYears;
  window.toggleYearChip=function(yr){{
    if(activeYears.has(yr)){{ if(activeYears.size>1){{ activeYears.delete(yr); }} }}
    else {{ activeYears.add(yr); }}
    document.querySelectorAll('.year-chip').forEach(function(b){{ b.classList.toggle('active', activeYears.has(b.dataset.yr)); }});
    document.querySelectorAll('[data-yr]:not(.year-chip)').forEach(function(el){{ el.style.display = activeYears.has(el.getAttribute('data-yr')) ? '' : 'none'; }});
    (window.REPORT_CHARTS||[]).forEach(function(fn){{ fn(); }});
  }};
}})();
</script>
"""

    return f"""<title>{h_enc(ctx.b['title'])} Customer Query &mdash; Segment Report</title>
<script>window.REPORT_CARD = '{j_enc(ctx.b['brand'])}';</script>
{head}
<div class="wrap">
  <header class="hero">
    <a class="home-link" href="/">&larr; Home</a>
    <div>
      <span class="badge">Customer Experience</span>
      <span class="badge">{h_enc(ctx.b['title'])}</span>
      <span class="badge">Updated {now_str}</span>
    </div>
    <h1>Customer Query Segment Report &mdash; {h_enc(ctx.b['title'])}</h1>
    <p>Source: "{h_enc(ctx.b['sheet_name'])}" tab &middot; {n0(ctx.total_rows)} raw ticket rows, deduplicated to {n0(ctx.total_unique)} unique tickets</p>
  </header>
  <nav class="tab-nav">{nav}</nav>
  <h2 id="active-tab-title" style="text-align:center;font-size:19px;margin:22px 0 4px;">CSAT</h2>
  {gran_toolbar.rstrip()}
  {year_toolbar.rstrip()}
  {build_csat_panel(ctx)}
  {build_nps_panel(ctx)}
  {build_product_wise_nps_panel(ctx)}
  {''.join(panels)}
  {build_prod_pkg_panel(ctx)}
  {build_rto_conversion_panel(ctx)}
  {foot}
</div>
{tabjs}
{build_geo_script(ctx)}"""
