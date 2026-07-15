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
from gen_geo_insights import build_delivery_geo_block
from gen_insights import build_insights_card, get_category_insight_items, get_delivery_partner_insight
from gen_weekly import build_weekly_class_block, build_weekly_delivery_block
from gen_monthly import build_monthly_analysis_panel
from gen_raw_export import raw_download_link
from report_context import ci_key, fnum, h_enc, j_enc, n0, pretty_month, round1, year_of


def _batch_table(ctx, subset, title):
    pm = {}
    pt = {}
    prod_cache = {}
    for r in subset:
        b = ctx.cell(r, ctx.col["batch"])
        if not str(b).strip():
            continue
        prod = ctx.cell(r, ctx.col["prod"])
        if not str(prod).strip():
            prod = "(blank)"
        prod = ci_key(prod, prod_cache)
        mo = ctx.cell(r, ctx.col["month"])
        if not str(mo).strip():
            continue
        pm.setdefault(prod, {})
        pm[prod][mo] = pm[prod].get(mo, 0) + 1
        pt[prod] = pt.get(prod, 0) + 1
    order = [k for k, _ in sorted(pt.items(), key=lambda kv: kv[1], reverse=True)[:25]]
    if not order:
        return ""
    parts = [f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(title)} Batch Numberwise Complaints - Monthly</div>"
             f"<div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner'>Product Name</th>"]
    for mo in ctx.months:
        parts.append(f"<th class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    parts.append("</tr></thead><tbody>")
    for ri, prod in enumerate(order, start=1):
        z = "zebra" if ri % 2 == 1 else ""
        parts.append(f"<tr class='{z}'><td class='rowlabel' title=\"{h_enc(prod)}\">{h_enc(prod)}</td>")
        for mo in ctx.months:
            cnt = pm[prod].get(mo, 0)
            cd = n0(cnt) if cnt > 0 else "-"
            parts.append(f"<td class='num' data-yr='{year_of(mo)}'>{cd}</td>")
        parts.append("</tr>")
    parts.append("</tbody></table></div></div>")
    return (f"<section><h2>Batch Numberwise Complaints (Top 25 Products)</h2>"
            f"<p class=\"desc\">Count of {h_enc(title)} tickets that carry a Batch Number, by product and ticket month.</p>{''.join(parts)}</section>")


def build_cross_filter_panel(ctx, cls, dim2_key, dim2_label, dim2_title, pct_mode, dim2_pct_label, dim2_cap, coverage_mode):
    months = ctx.months
    n = ctx.n
    subset = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) == cls["key"]]
    pfx = cls["id"]
    dim2_col = ctx.col[dim2_key]

    # Shared caches so every pass below resolves the same raw value (e.g. "Product not
    # Sealed" vs "product NOT sealed") to the same first-seen-cased key - matching
    # PowerShell's case-insensitive @{} hashtables. Without sharing these across passes,
    # a later pass's cat_order.index(cat)/dim2_order.index(v) could throw on a
    # differently-cased occurrence of a value already seen (and canonicalized) earlier.
    cat_cache = {}
    dim2_cache = {}

    cat_tot = {}
    for r in subset:
        c = ctx.cell(r, ctx.col["cat"])
        if not str(c).strip():
            c = "(blank)"
        c = ci_key(c, cat_cache)
        cat_tot[c] = cat_tot.get(c, 0) + 1
    cat_order = [k for k, _ in sorted(cat_tot.items(), key=lambda kv: kv[1], reverse=True)]

    dim2_tot_all = {}
    for r in subset:
        v = ctx.cell(r, dim2_col)
        if not str(v).strip():
            v = "(blank)"
        v = ci_key(v, dim2_cache)
        dim2_tot_all[v] = dim2_tot_all.get(v, 0) + 1
    dim2_order_full = [k for k, _ in sorted(dim2_tot_all.items(), key=lambda kv: kv[1], reverse=True)]
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
    for mo in months:
        sb1.append(f"<th colspan='2' class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    sb1.append("</tr><tr>")
    for mo in months:
        yr = year_of(mo)
        sb1.append(f"<th class='sub-hdr' data-yr='{yr}'>Complaints</th><th class='sub-hdr' data-yr='{yr}'>wrt sales</th>")
    sb1.append("</tr></thead><tbody>")
    for ci, cat in enumerate(cat_order):
        z = "zebra" if (ci + 1) % 2 == 1 else ""
        sb1.append(f"<tr class='{z} xf-row' id='xf-{pfx}-catrow-{ci}' onclick='onXfClick(\"{pfx}\",\"cat\",{ci})'><td class='rowlabel'>{h_enc(cat)}</td>")
        for mi in range(n):
            yr = year_of(months[mi])
            sb1.append(f"<td class='num' id='xf-{pfx}-cat-{ci}-mo-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='xf-{pfx}-cat-{ci}-mo-{mi}-pct' data-yr='{yr}'>-</td>")
        sb1.append("</tr>")
    sb1.append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for mi in range(n):
        yr = year_of(months[mi])
        sb1.append(f"<td class='num' id='xf-{pfx}-cat-total-mo-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='xf-{pfx}-cat-total-mo-{mi}-pct' data-yr='{yr}'>-</td>")
    sb1.append("</tr></tbody></table></div></div>")

    sb2 = [f"<div class='pivot-wrap'><div class='pivot-title'>{h_enc(dim2_title)}</div>"
           f"<div class='pivot-scroll'><table class='pivot-table'><thead><tr><th class='corner' rowspan='2'>{h_enc(dim2_label)}</th>"]
    for mo in months:
        sb2.append(f"<th colspan='2' class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    sb2.append("</tr><tr>")
    for mo in months:
        yr = year_of(mo)
        sb2.append(f"<th class='sub-hdr' data-yr='{yr}'>Complaints</th><th class='sub-hdr' data-yr='{yr}'>{h_enc(dim2_pct_label)}</th>")
    sb2.append("</tr></thead><tbody>")
    for di, dv in enumerate(dim2_order):
        z = "zebra" if (di + 1) % 2 == 1 else ""
        sb2.append(f"<tr class='{z} xf-row' id='xf-{pfx}-dimrow-{di}' onclick='onXfClick(\"{pfx}\",\"dim2\",{di})'><td class='rowlabel'>{h_enc(dv)}</td>")
        for mi in range(n):
            yr = year_of(months[mi])
            sb2.append(f"<td class='num' id='xf-{pfx}-dim-{di}-mo-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='xf-{pfx}-dim-{di}-mo-{mi}-pct' data-yr='{yr}'>-</td>")
        sb2.append("</tr>")
    sb2.append("<tr class='total-row'><td class='rowlabel'>Grand Total</td>")
    for mi in range(n):
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
  var DT=__TICKETS_JSON__, CATS=__CATS_JSON__, DIMS=__DIM2S_JSON__, MONTHS=__MONTHS_JSON__, MONTH_LABELS=__MONTHLABELS_JSON__, SALES=__SALES_JSON__, ALLOC=__ALLOC_JSON__, N=MONTHS.length;
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
    window.renderPctChart(chartEl, { vals:r.tot, months:MONTHS, monthLabels:MONTH_LABELS, sales:SALES,
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
            .replace("__W__", str(W)).replace("__H__", str(H))
            .replace("__PADL__", str(pad_l)).replace("__PADR__", str(pad_r)).replace("__PADT__", str(pad_t)).replace("__PADB__", str(pad_b))
            .replace("__BARCOLOR__", bar_color).replace("__LINECOLOR__", line_color)
            .replace("__PCTMODE__", pct_mode)
            .replace("__CLSLABEL__", h_enc(cls["label"])).replace("__DIM2LABEL__", h_enc(dim2_label))
            .replace("__PFX__", pfx))

    if cls["id"] == "delivery":
        insights_block = build_insights_card("Insights &mdash; Delivery",
                                              get_category_insight_items(ctx, subset) + [get_delivery_partner_insight(ctx, subset)])
        insights_block += build_delivery_geo_block(ctx)
        weekly_block = build_weekly_delivery_block(ctx)
    else:
        insights_block = build_insights_card(f"Insights &mdash; {h_enc(cls['label'])}", get_category_insight_items(ctx, subset))
        weekly_block = build_weekly_class_block(ctx, cls)
    batch = ""
    if cls["key"] in ("Product", "Product Suggestion/Recommendation"):
        batch = _batch_table(ctx, subset, cls["label"])

    return f"""{raw_download_link(ctx, pfx)}
<div class="gran-monthly">
{filter_note}
<section><h2>{h_enc(cls['label'])} Complaints by Issue Category</h2><p class="desc">Percent = complaints &divide; that month's total order volume ("Total Sales M"). Click a row in either table below to cross-filter.</p>{''.join(sb1)}</section>
<section><h2>{h_enc(dim2_title)}</h2>{coverage_note}{capped_note}{''.join(sb2)}</section>
<section><h2>{h_enc(cls['label'])} Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line). Recomputes for the row selected above.</p>{''.join(sb3)}</section>
</div>
{weekly_block}
{batch}
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
    cat_order = [k for k, _ in sorted(cat_tot.items(), key=lambda kv: kv[1], reverse=True)]
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
        parts.append(f"<tr class='{z}'><td class='rowlabel'>{h_enc(cat)}</td>")
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
    months = ctx.months
    W, H, pad_l, pad_r, pad_t, pad_b = 1200, 380, 55, 55, 40, 55
    chart_id = _next_chart_id("chart")
    vals_json = "[" + ",".join(str(v) for v in vals) + "]"
    months_json = "[" + ",".join(f'"{j_enc(m)}"' for m in months) + "]"
    month_labels_json = "[" + ",".join(f'"{j_enc(pretty_month(m))}"' for m in months) + "]"
    sales_json = "[" + ",".join(str(v) for v in ctx.sales_arr) + "]"
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
    batch = _batch_table(ctx, subset, cls["label"])
    insights = build_insights_card(f"Insights &mdash; {h_enc(cls['label'])}", get_category_insight_items(ctx, subset))
    weekly = build_weekly_class_block(ctx, cls)
    return f"""{raw_download_link(ctx, cls["id"])}
<div class="gran-monthly">
<section><h2>{h_enc(cls['label'])} Complaints by Issue Category</h2><p class="desc">Percent = complaints &divide; that month's total order volume ("Total Sales M").</p>{pivot}</section>
<section><h2>{h_enc(cls['label'])} Complaints wrt Sales</h2><p class="desc">Monthly complaint volume (bars) against complaint rate as a share of sales (line).</p>{chart}</section>
</div>
{weekly}
{batch}
{insights}"""


def build_combo2(rows, title, score_label, score_max):
    mos, vals, sc, yrs_raw, month_nums = [], [], [], [], []
    for i in range(1, len(rows)):
        r = rows[i]
        raw = r[0]
        mos.append(pretty_month(raw))
        yrs_raw.append(year_of(raw))
        vals.append(float(str(r[1]).replace(",", "")))
        sc.append(float(r[2]))
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


def _norm(v):
    s = "" if v is None else str(v)
    return "(blank)" if not s.strip() else s


def build_prod_pkg_panel(ctx):
    months = ctx.months
    n = ctx.n
    ppsub = [r for r in ctx.unique if ctx.cell(r, ctx.col["cls"]) in ("Packaging and Operational", "Product")]
    # Shared caches (one per field, reused across both this pass and the combo-building pass
    # below) so a value's casing is resolved the same way everywhere - matching PowerShell's
    # case-insensitive @{}/[ordered]@{} hashtables, where e.g. "Product not Sealed" and
    # "product NOT sealed" collapse into a single bucket under whichever casing was seen first.
    sku_cache, prod_cache, cls_cache, cat_cache, batch_cache = {}, {}, {}, {}, {}
    sku_set, prod_set, cls_set, cat_set, batch_set = {}, {}, {}, {}, {}
    for r in ppsub:
        sku_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["sku"])), sku_cache), True)
        prod_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["prod"])), prod_cache), True)
        cls_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["cls"])), cls_cache), True)
        cat_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["cat"])), cat_cache), True)
        batch_set.setdefault(ci_key(_norm(ctx.cell(r, ctx.col["batch"])), batch_cache), True)
    SKUS, PRODS, CLASSES, CATS, BATCHES = list(sku_set), list(prod_set), list(cls_set), list(cat_set), list(batch_set)
    LM = n - 1
    lm_sales = ctx.sales_arr[LM]

    combo_tot, combo_mc, combo_k2i = {}, {}, {}
    combo_list = []
    tickets = []
    for r in ppsub:
        mo = ctx.cell(r, ctx.col["month"])
        mi = months.index(mo) if mo in months else -1
        if mi < 0:
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
        tickets.append(f"[{mi},{si},{pi},{li},{ci},{bi}]")
        ck = f"{si}|{pi}|{li}|{ci}|{bi}"
        if ck not in combo_tot:
            combo_tot[ck] = 0
            combo_mc[ck] = [0] * n
            combo_k2i[ck] = len(combo_list)
            combo_list.append({"sku": si, "prod": pi, "cls": li, "cat": ci, "batch": bi})
        combo_tot[ck] += 1
        combo_mc[ck][mi] += 1

    def lmk(arr):
        c = arr[LM]
        p = (c / lm_sales) if lm_sales > 0 else 0
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
    top_sku = sorted(sku_tree.keys(), key=lambda sk: (lmk(sku_tree[sk]["mc"])["cnt"], lmk(sku_tree[sk]["mc"])["pct"], SKUS[int(sk)]), reverse=True)[:MAX_P]
    parents_out, prod_groups, cls_groups, cat_groups, rows_out, row_cat_idx = [], [], [], [], [], []
    for sk in top_sku:
        sn = sku_tree[sk]
        pidx = len(parents_out)
        parents_out.append({"sku": sn["sku"]})
        tp = sorted(sn["products"].keys(), key=lambda pk: (lmk(sn["products"][pk]["mc"])["cnt"], lmk(sn["products"][pk]["mc"])["pct"], PRODS[int(pk)]), reverse=True)[:MAX_PROD]
        for pk in tp:
            pn = sn["products"][pk]
            pgi = len(prod_groups)
            prod_groups.append({"parentIdx": pidx, "prod": pn["prod"]})
            tc = sorted(pn["classes"].keys(), key=lambda lk: (lmk(pn["classes"][lk]["mc"])["cnt"], lmk(pn["classes"][lk]["mc"])["pct"], CLASSES[int(lk)]), reverse=True)[:MAX_CLS]
            for lk in tc:
                ln = pn["classes"][lk]
                cgi = len(cls_groups)
                cls_groups.append({"productGroupIdx": pgi, "cls": ln["cls"]})
                tcat = sorted(ln["cats"].keys(), key=lambda ck: (lmk(ln["cats"][ck]["mc"])["cnt"], lmk(ln["cats"][ck]["mc"])["pct"], CATS[int(ck)]), reverse=True)[:MAX_CAT]
                for catk in tcat:
                    cn = ln["cats"][catk]
                    catgi = len(cat_groups)
                    cat_groups.append({"classGroupIdx": cgi, "cat": cn["cat"]})
                    tb = sorted(cn["batches"], key=lambda b: (lmk(b["mc"])["cnt"], lmk(b["mc"])["pct"], BATCHES[b["combo"]["batch"]]), reverse=True)[:MAX_BAT]
                    for b in tb:
                        rows_out.append(b["combo"])
                        row_cat_idx.append(catgi)

    def aj(a):
        return "[" + ",".join(f'"{j_enc(x)}"' for x in a) + "]"

    tickets_json = "[" + ",".join(tickets) + "]"
    rows_json = "[" + ",".join(f"[{r['sku']},{r['prod']},{r['cls']},{r['cat']},{r['batch']}]" for r in rows_out) + "]"
    parents_json = "[" + ",".join(f"[{p['sku']}]" for p in parents_out) + "]"
    prod_g_json = "[" + ",".join(f"[{g['parentIdx']},{g['prod']}]" for g in prod_groups) + "]"
    cls_g_json = "[" + ",".join(f"[{g['productGroupIdx']},{g['cls']}]" for g in cls_groups) + "]"
    cat_g_json = "[" + ",".join(f"[{g['classGroupIdx']},{g['cat']}]" for g in cat_groups) + "]"
    row_cat_json = "[" + ",".join(str(x) for x in row_cat_idx) + "]"
    skus_json, prods_json, classes_json, cats_json, batches_json, months_json = aj(SKUS), aj(PRODS), aj(CLASSES), aj(CATS), aj(BATCHES), aj(months)
    sales_json = "[" + ",".join(str(v) for v in ctx.sales_arr) + "]"

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

    t = ["<div class='pivot-scroll ppk-scroll'><table class='pivot-table' id='ppk-pivot-table'><thead><tr>"
         "<th class='corner'>SKU</th><th class='corner'>Product Name</th><th class='corner'>Query Class</th>"
         "<th class='corner'>Query Category</th><th class='corner'>Batch Number</th>"]
    for mo in months:
        t.append(f"<th colspan='2' class='month-hdr' data-yr='{year_of(mo)}'>{h_enc(mo)}</th>")
    t.append("</tr><tr><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th><th class='corner'></th>")
    for mo in months:
        yr = year_of(mo)
        t.append(f"<th class='sub-hdr' data-yr='{yr}'>complain</th><th class='sub-hdr' data-yr='{yr}'>complain%</th>")
    t.append("</tr></thead><tbody>")
    for pi, p in enumerate(parents_out):
        z = "zebra" if (pi + 1) % 2 == 1 else ""
        t.append(f"<tr class='{z} ppk-lvl1' id='ppk-parent-{pi}' style='font-weight:700;'><td class='rowlabel'>"
                 f"<span id='ppk-icon-1-{pi}' class='ppk-toggle-icon' onclick='ppkToggle(1,{pi},event)' style='cursor:pointer;'>+</span>{h_enc(SKUS[p['sku']])}</td>"
                 f"<td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
        for mi in range(n):
            yr = year_of(months[mi])
            t.append(f"<td class='num' id='ppk-p-{pi}-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='ppk-p-{pi}-{mi}-pct' data-yr='{yr}'>-</td>")
        t.append("</tr>")
        for pgi in pg_by_p.get(pi, []):
            pg = prod_groups[pgi]
            t.append(f"<tr class='ppk-lvl2 ppk-child-of-p{pi}' id='ppk-pg-{pgi}' style='display:none;font-weight:600;background:var(--surface-1);'>"
                     f"<td class='rowlabel'></td><td class='rowlabel' title=\"{h_enc(PRODS[pg['prod']])}\">"
                     f"<span id='ppk-icon-2-{pgi}' class='ppk-toggle-icon' onclick='ppkToggle(2,{pgi},event)' style='cursor:pointer;'>+</span>{h_enc(PRODS[pg['prod']])}</td>"
                     f"<td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
            for mi in range(n):
                yr = year_of(months[mi])
                t.append(f"<td class='num' id='ppk-pg-{pgi}-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='ppk-pg-{pgi}-{mi}-pct' data-yr='{yr}'>-</td>")
            t.append("</tr>")
            for cgi in cg_by_pg.get(pgi, []):
                cg = cls_groups[cgi]
                t.append(f"<tr class='ppk-lvl3 ppk-child-of-pg{pgi}' id='ppk-cg-{cgi}' style='display:none;background:var(--pivot-zebra-bg);'>"
                         f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'>"
                         f"<span id='ppk-icon-3-{cgi}' class='ppk-toggle-icon' onclick='ppkToggle(3,{cgi},event)' style='cursor:pointer;'>+</span>{h_enc(CLASSES[cg['cls']])}</td>"
                         f"<td class='rowlabel'>&mdash;</td><td class='rowlabel'>&mdash;</td>")
                for mi in range(n):
                    yr = year_of(months[mi])
                    t.append(f"<td class='num' id='ppk-cg-{cgi}-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='ppk-cg-{cgi}-{mi}-pct' data-yr='{yr}'>-</td>")
                t.append("</tr>")
                for catgi in cat_by_cg.get(cgi, []):
                    catg = cat_groups[catgi]
                    t.append(f"<tr class='ppk-lvl4 ppk-child-of-cg{cgi}' id='ppk-catg-{catgi}' style='display:none;'>"
                             f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'>"
                             f"<span id='ppk-icon-4-{catgi}' class='ppk-toggle-icon' onclick='ppkToggle(4,{catgi},event)' style='cursor:pointer;'>+</span>{h_enc(CATS[catg['cat']])}</td>"
                             f"<td class='rowlabel'>&mdash;</td>")
                    for mi in range(n):
                        yr = year_of(months[mi])
                        t.append(f"<td class='num' id='ppk-catg-{catgi}-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='ppk-catg-{catgi}-{mi}-pct' data-yr='{yr}'>-</td>")
                    t.append("</tr>")
                    for ri in rows_by_cat.get(catgi, []):
                        c = rows_out[ri]
                        t.append(f"<tr class='ppk-lvl5 ppk-child-of-catg{catgi}' id='ppk-row-{ri}' style='display:none;background:var(--surface-card);'>"
                                 f"<td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td><td class='rowlabel'></td>"
                                 f"<td class='rowlabel'>{h_enc(BATCHES[c['batch']])}</td>")
                        for mi in range(n):
                            yr = year_of(months[mi])
                            t.append(f"<td class='num' id='ppk-{ri}-{mi}-cnt' data-yr='{yr}'>-</td><td class='pct' id='ppk-{ri}-{mi}-pct' data-yr='{yr}'>-</td>")
                        t.append("</tr>")
    t.append("</tbody></table></div>")

    ppk_css = ("<style>.ppk-scroll{max-height:640px;overflow-y:auto;}#ppk-pivot-table thead th{position:sticky;top:0;z-index:4;}"
               "#ppk-pivot-table thead tr:nth-child(2) th{top:28px;}.ppk-toggle-icon{display:inline-block;width:14px;font-weight:700;color:var(--s1);}"
               "#ppk-pivot-table td.rowlabel{position:sticky;z-index:3;background:var(--surface-card);}#ppk-pivot-table th.corner{z-index:6;}"
               "#ppk-pivot-table th.corner:nth-child(1),#ppk-pivot-table td.rowlabel:nth-child(1){left:0;width:90px;min-width:90px;max-width:90px;}"
               "#ppk-pivot-table th.corner:nth-child(2),#ppk-pivot-table td.rowlabel:nth-child(2){left:90px;width:190px;min-width:190px;max-width:190px;}"
               "#ppk-pivot-table th.corner:nth-child(3),#ppk-pivot-table td.rowlabel:nth-child(3){left:280px;width:130px;min-width:130px;max-width:130px;}"
               "#ppk-pivot-table th.corner:nth-child(4),#ppk-pivot-table td.rowlabel:nth-child(4){left:410px;width:170px;min-width:170px;max-width:170px;}"
               "#ppk-pivot-table th.corner:nth-child(5),#ppk-pivot-table td.rowlabel:nth-child(5){left:580px;width:110px;min-width:110px;max-width:110px;box-shadow:2px 0 4px -2px rgba(0,0,0,0.25);}</style>")

    js = """
<script>
(function(){
  var TICKETS=__TICKETS_JSON__,SKUS=__SKUS_JSON__,PRODS=__PRODS_JSON__,CLASSES=__CLASSES_JSON__,CATS=__CATS_JSON__,BATCHES=__BATCHES_JSON__,MONTHS=__MONTHS_JSON__,SALES=__SALES_JSON__;
  var ROWS=__ROWS_JSON__,ROW_CATGROUP=__ROW_CAT_JSON__,PARENTS=__PARENTS_JSON__,PRODUCT_GROUPS=__PROD_G_JSON__,CLASS_GROUPS=__CLS_G_JSON__,CATEGORY_GROUPS=__CAT_G_JSON__,N=MONTHS.length;
  var e1={},e2={},e3={},e4={},EB={1:e1,2:e2,3:e3,4:e4};
  function fmt(n){return n.toLocaleString('en-IN');}
  window.ppkToggle=function(lv,idx,ev){ if(ev)ev.stopPropagation(); var s=EB[lv]; s[idx]=!s[idx]; var ic=document.getElementById('ppk-icon-'+lv+'-'+idx); if(ic)ic.textContent=s[idx]?'−':'+'; render(); };
  function leafCounts(f){ var c=[]; for(var ri=0;ri<ROWS.length;ri++){c.push(new Array(N).fill(0));} var idx={}; for(var r2=0;r2<ROWS.length;r2++){idx[ROWS[r2].join('|')]=r2;}
    for(var i=0;i<TICKETS.length;i++){ var t=TICKETS[i],mo=t[0],sku=t[1],pr=t[2],cl=t[3],ca=t[4],ba=t[5];
      if(mo<0||mo>=N||sku<0||sku>=SKUS.length||pr<0||pr>=PRODS.length||cl<0||cl>=CLASSES.length||ca<0||ca>=CATS.length||ba<0||ba>=BATCHES.length)continue;
      if(f.month!==null&&mo!==f.month)continue; if(f.product!==null&&pr!==f.product)continue; if(f.sku!==null&&sku!==f.sku)continue; if(f.cls!==null&&cl!==f.cls)continue; if(f.category!==null&&ca!==f.category)continue;
      var k=sku+'|'+pr+'|'+cl+'|'+ca+'|'+ba; var ri=idx[k]; if(ri===undefined)continue; c[ri][mo]++; } return c; }
  function sm(a,b){var o=new Array(a.length);for(var i=0;i<a.length;i++){o[i]=a[i]+b[i];}return o;}
  function has(a){for(var i=0;i<a.length;i++){if(a[i]>0)return true;}return false;}
  function wc(pfx,idx,arr){ for(var mi=0;mi<N;mi++){ var v=arr[mi],s=SALES[mi],p=s>0?Math.round(v/s*100000)/1000:0; var cc=document.getElementById(pfx+'-'+idx+'-'+mi+'-cnt'),pc=document.getElementById(pfx+'-'+idx+'-'+mi+'-pct'); if(cc)cc.textContent=v>0?fmt(v):'-'; if(pc)pc.textContent=v>0?(p+'%'):'-'; } }
  var DIMS=['month','product','sku','cls','category'],SIDS={month:'ppk-filter-month',product:'ppk-filter-product',sku:'ppk-filter-sku',cls:'ppk-filter-class',category:'ppk-filter-category'},TP={month:0,sku:1,product:2,cls:3,category:4};
  function rf(){ var g=function(id){var e=document.getElementById(id);return e?e.value:'';}; return {month:g(SIDS.month)?MONTHS.indexOf(g(SIDS.month)):null,product:g(SIDS.product)?PRODS.indexOf(g(SIDS.product)):null,sku:g(SIDS.sku)?SKUS.indexOf(g(SIDS.sku)):null,cls:g(SIDS.cls)?CLASSES.indexOf(g(SIDS.cls)):null,category:g(SIDS.category)?CATS.indexOf(g(SIDS.category)):null}; }
  function tmatch(t,f,ex){ for(var d=0;d<DIMS.length;d++){var dim=DIMS[d]; if(dim===ex)continue; var w=f[dim]; if(w===null)continue; if(t[TP[dim]]!==w)return false;} return true; }
  function ssRefresh(input,list){ var q=(input.value||'').toLowerCase();
    list.querySelectorAll('.ss-opt').forEach(function(o){ var invalid=o.getAttribute('data-invalid')==='1'; var matches=q===''||o.textContent.toLowerCase().indexOf(q)!==-1; o.style.display=(matches&&!invalid)?'':'none'; }); }
  function upd(f){ DIMS.forEach(function(dim){ var valid={}; for(var i=0;i<TICKETS.length;i++){var t=TICKETS[i]; if(tmatch(t,f,dim)){valid[t[TP[dim]]]=true;}}
    var input=document.getElementById(SIDS[dim]); if(!input)return; var list=document.getElementById(SIDS[dim]+'-list'); if(!list)return;
    var curConfirmed=input.dataset.confirmed||''; var curStillValid=true;
    list.querySelectorAll('.ss-opt').forEach(function(o){ var ix=o.getAttribute('data-idx'),ok=(ix==='')?true:!!valid[parseInt(ix,10)]; o.setAttribute('data-invalid',ok?'0':'1'); if(curConfirmed!==''&&o.getAttribute('data-value')===curConfirmed&&!ok){curStillValid=false;} });
    if(!curStillValid){ input.value=''; input.dataset.confirmed=''; }
    ssRefresh(input,list);
  }); }
  function sk(a){var LM=N-1,c=a[LM],p=SALES[LM]>0?c/SALES[LM]:0;return {c:c,p:p};}
  function cmp(a,b){var ka=sk(a),kb=sk(b); if(kb.c!==ka.c)return kb.c-ka.c; return kb.p-ka.p;}
  function render(){ try{ var f=rf(); upd(f); f=rf(); var lc=leafCounts(f);
      var catgC=CATEGORY_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var ri=0;ri<ROWS.length;ri++){var ci=ROW_CATGROUP[ri]; if(ci!==undefined&&catgC[ci]){catgC[ci]=sm(catgC[ci],lc[ri]);} wc('ppk',ri,lc[ri]);}
      var clsC=CLASS_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var cg=0;cg<CATEGORY_GROUPS.length;cg++){var k=CATEGORY_GROUPS[cg][0]; if(clsC[k]){clsC[k]=sm(clsC[k],catgC[cg]);} wc('ppk-catg',cg,catgC[cg]);}
      var pgC=PRODUCT_GROUPS.map(function(){return new Array(N).fill(0);});
      for(var c2=0;c2<CLASS_GROUPS.length;c2++){var k2=CLASS_GROUPS[c2][0]; if(pgC[k2]){pgC[k2]=sm(pgC[k2],clsC[c2]);} wc('ppk-cg',c2,clsC[c2]);}
      var pC=PARENTS.map(function(){return new Array(N).fill(0);});
      for(var p2=0;p2<PRODUCT_GROUPS.length;p2++){var k3=PRODUCT_GROUPS[p2][0]; if(pC[k3]){pC[k3]=sm(pC[k3],pgC[p2]);} wc('ppk-pg',p2,pgC[p2]);}
      for(var pi=0;pi<PARENTS.length;pi++){wc('ppk-p',pi,pC[pi]);}
      var withData=0;
      for(var p3=0;p3<PARENTS.length;p3++){var hd=has(pC[p3]),el=document.getElementById('ppk-parent-'+p3); if(el)el.style.display=hd?'':'none'; if(hd)withData++;}
      for(var pg3=0;pg3<PRODUCT_GROUPS.length;pg3++){var hd2=has(pgC[pg3]),par=PRODUCT_GROUPS[pg3][0],el2=document.getElementById('ppk-pg-'+pg3); if(el2)el2.style.display=(!!e1[par]&&hd2)?'':'none';}
      for(var cg3=0;cg3<CLASS_GROUPS.length;cg3++){var hd3=has(clsC[cg3]),par2=CLASS_GROUPS[cg3][0],el3=document.getElementById('ppk-cg-'+cg3); if(el3)el3.style.display=(!!e2[par2]&&hd3)?'':'none';}
      for(var ca3=0;ca3<CATEGORY_GROUPS.length;ca3++){var hd4=has(catgC[ca3]),par3=CATEGORY_GROUPS[ca3][0],el4=document.getElementById('ppk-catg-'+ca3); if(el4)el4.style.display=(!!e3[par3]&&hd4)?'':'none';}
      for(var r4=0;r4<ROWS.length;r4++){var hd5=has(lc[r4]),par4=ROW_CATGROUP[r4],el5=document.getElementById('ppk-row-'+r4); if(el5)el5.style.display=(!!e4[par4]&&hd5)?'':'none';}
      var tb=document.querySelector('#ppk-pivot-table tbody');
      if(tb){ var po=PARENTS.map(function(_,i){return i;}); po.sort(function(a,b){return cmp(pC[a],pC[b]);});
        var pgBy={};PRODUCT_GROUPS.forEach(function(x,i){var k=x[0];(pgBy[k]=pgBy[k]||[]).push(i);});
        var cgBy={};CLASS_GROUPS.forEach(function(x,i){var k=x[0];(cgBy[k]=cgBy[k]||[]).push(i);});
        var caBy={};CATEGORY_GROUPS.forEach(function(x,i){var k=x[0];(caBy[k]=caBy[k]||[]).push(i);});
        var rBy={};ROWS.forEach(function(_,i){var k=ROW_CATGROUP[i];(rBy[k]=rBy[k]||[]).push(i);});
        po.forEach(function(pi){ var pe=document.getElementById('ppk-parent-'+pi); if(pe)tb.appendChild(pe);
          (pgBy[pi]||[]).slice().sort(function(a,b){return cmp(pgC[a],pgC[b]);}).forEach(function(pgi){ var pge=document.getElementById('ppk-pg-'+pgi); if(pge)tb.appendChild(pge);
            (cgBy[pgi]||[]).slice().sort(function(a,b){return cmp(clsC[a],clsC[b]);}).forEach(function(cgi){ var cge=document.getElementById('ppk-cg-'+cgi); if(cge)tb.appendChild(cge);
              (caBy[cgi]||[]).slice().sort(function(a,b){return cmp(catgC[a],catgC[b]);}).forEach(function(cai){ var cae=document.getElementById('ppk-catg-'+cai); if(cae)tb.appendChild(cae);
                (rBy[cai]||[]).slice().sort(function(a,b){return cmp(lc[a],lc[b]);}).forEach(function(ri){ var re=document.getElementById('ppk-row-'+ri); if(re)tb.appendChild(re); }); }); }); }); }); }
      var note=document.getElementById('ppk-filter-note'); if(note){note.textContent=withData+' of '+PARENTS.length+' SKUs have complaints for the selected filters, sorted by '+MONTHS[N-1]+' complaints. Expand SKU → Product → Query Class → Query Category to drill down.'; note.style.color='';}
    }catch(e){ var n2=document.getElementById('ppk-filter-note'); if(n2){n2.textContent='Filter error: '+e.message;n2.style.color='var(--s6)';} if(window.console)console.error('ProdPkg error',e); } }
  window.onProdPkgFilterChange=render;
  function ssCloseAll(except){ document.querySelectorAll('.ss-list').forEach(function(l){ if(l!==except) l.style.display='none'; }); }
  document.addEventListener('focusin', function(e){ if(e.target.classList && e.target.classList.contains('ss-input')){ var list=document.getElementById(e.target.id+'-list'); if(list){ ssCloseAll(list); list.style.display='block'; ssRefresh(e.target,list); } } });
  document.addEventListener('input', function(e){ if(e.target.classList && e.target.classList.contains('ss-input')){ var list=document.getElementById(e.target.id+'-list'); if(list){ list.style.display='block'; ssRefresh(e.target,list); } } });
  document.addEventListener('mousedown', function(e){
    var opt = e.target.closest ? e.target.closest('.ss-opt') : null;
    if(opt){ e.preventDefault(); var list=opt.closest('.ss-list'); var input=document.getElementById(list.id.replace(/-list$/,''));
      var val=opt.getAttribute('data-value'); input.value=val; input.dataset.confirmed=val; list.style.display='none';
      input.dispatchEvent(new Event('change',{bubbles:true})); return; }
    if(!(e.target.classList && e.target.classList.contains('ss-input'))){ ssCloseAll(null); }
  });
  document.addEventListener('focusout', function(e){ if(e.target.classList && e.target.classList.contains('ss-input')){ var input=e.target;
    setTimeout(function(){ var list=document.getElementById(input.id+'-list'); if(list)list.style.display='none';
      if(input.value!==(input.dataset.confirmed||'')){ input.value=input.dataset.confirmed||''; } },150); } });
  function init(){render();}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();
</script>
"""
    js = (js.replace("__TICKETS_JSON__", tickets_json).replace("__SKUS_JSON__", skus_json)
            .replace("__PRODS_JSON__", prods_json).replace("__CLASSES_JSON__", classes_json)
            .replace("__CATS_JSON__", cats_json).replace("__BATCHES_JSON__", batches_json)
            .replace("__MONTHS_JSON__", months_json).replace("__SALES_JSON__", sales_json)
            .replace("__ROWS_JSON__", rows_json).replace("__ROW_CAT_JSON__", row_cat_json)
            .replace("__PARENTS_JSON__", parents_json).replace("__PROD_G_JSON__", prod_g_json)
            .replace("__CLS_G_JSON__", cls_g_json).replace("__CAT_G_JSON__", cat_g_json))

    def dd(id_, lbl, opts):
        s = [f"<div style='display:flex;flex-direction:column;gap:4px;min-width:150px;position:relative;'>"
             f"<label for='{id_}' style='font-size:11px;color:var(--text-muted);'>{h_enc(lbl)}</label>"]
        s.append(f"<div style='position:relative;'><input type='text' id='{id_}' class='ss-input' data-confirmed='' placeholder='All' autocomplete='off' onchange='onProdPkgFilterChange()' "
                 f"style='font-size:12.5px;padding:7px 26px 7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface-card);color:var(--text-primary);font-family:inherit;max-width:220px;width:100%;box-sizing:border-box;'>"
                 f"<span style='position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-muted);font-size:10px;'>&#9662;</span></div>")
        s.append(f"<div class='ss-list' id='{id_}-list'><div class='ss-opt' data-value='' data-idx=''>All</div>")
        for oi, opt in enumerate(opts):
            s.append(f"<div class='ss-opt' data-value=\"{h_enc(opt)}\" data-idx='{oi}'>{h_enc(opt)}</div>")
        s.append("</div></div>")
        return "".join(s)

    filter_html = ("<div style='display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-end;'>"
                   + dd("ppk-filter-month", "Month", months) + dd("ppk-filter-product", "Product Name", PRODS)
                   + dd("ppk-filter-sku", "SKU", SKUS) + dd("ppk-filter-class", "Query Class", CLASSES)
                   + dd("ppk-filter-category", "Query Category", CATS)
                   + "</div><div id='ppk-filter-note' style='font-size:12px;color:var(--text-muted);margin-bottom:14px;'></div>")

    # ---- insights: sharpest single combo + top SKU overall, both by last month volume ----
    ppk_items = []
    top_key = None
    top_combo_val = -1
    for ck in combo_tot:
        cval = combo_mc[ck][LM]
        if cval > top_combo_val:
            top_combo_val, top_key = cval, ck
    if top_key and top_combo_val > 0:
        si, tpi, tli, tci, tbi = (int(x) for x in top_key.split("|"))
        pct = round1(top_combo_val / lm_sales * 100) if lm_sales > 0 else 0
        from gen_insights import insight_item
        ppk_items.append(insight_item("watch", f"Sharpest single pain point in {pretty_month(months[LM])}: <b>{h_enc(SKUS[si])}</b> / {h_enc(PRODS[tpi])} "
                                                 f"&mdash; {h_enc(CLASSES[tli])} &rarr; {h_enc(CATS[tci])} (batch {h_enc(BATCHES[tbi])}), {n0(top_combo_val)} tickets ({fnum(pct)}% of last month's sales)."))
    if top_sku:
        ts_idx = int(top_sku[0])
        ts_val = lmk(sku_tree[top_sku[0]]["mc"])["cnt"]
        if ts_val > 0:
            ts_pct = round1(ts_val / lm_sales * 100) if lm_sales > 0 else 0
            from gen_insights import insight_item
            ppk_items.append(insight_item("info", f"SKU with the most product/packaging complaints overall in {pretty_month(months[LM])}: "
                                                     f"<b>{h_enc(SKUS[ts_idx])}</b> &mdash; {n0(ts_val)} tickets ({fnum(ts_pct)}% of last month's sales)."))
    ppk_insights = build_insights_card("Insights &mdash; Product &amp; Packaging", ppk_items)

    return f"""  <div class="tab-panel" id="panel-prodpkg">
    <section>
      <h2>Product Packaging and Operational Complaints wrt Product Sales</h2>
      <p class="desc">Combines "Product" and "Packaging and Operational" tickets by SKU &rarr; Product &rarr; Query Class &rarr; Query Category &rarr; Batch. Click the + at each level to drill down; percent = complaints &divide; that month's total order volume.</p>
      {raw_download_link(ctx, "prodpkg")}
      {filter_html}
      <div class='pivot-wrap'><div class='pivot-title'>Product Packaging and Operational Complaints wrt Product Sales</div>{''.join(t)}</div>
    </section>
    {ppk_insights}
  </div>
{ppk_css}
{js}"""


def assemble_report(ctx, here_dir):
    with open(here_dir / "_shell_head.html", "r", encoding="utf-8") as f:
        head = f.read()
    nav = ('<button class="tab-btn active" data-tab="csat">CSAT</button>'
           '<button class="tab-btn" data-tab="nps">NPS</button>'
           '<button class="tab-btn" data-tab="overview">Overview</button>'
           '<button class="tab-btn" data-tab="monthly">Monthly Analysis</button>')
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
    tabjs = ("<script>document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){"
             "document.querySelectorAll('.tab-btn').forEach(function(x){x.classList.remove('active');});"
             "document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});"
             "b.classList.add('active');document.getElementById('panel-'+b.dataset.tab).classList.add('active');});});</script>")

    month_chips = []
    last_eligible = ctx.weekly_eligible_months[-1] if ctx.weekly_eligible_months else -1
    for mi in ctx.weekly_eligible_months:
        act = " active" if mi == last_eligible else ""
        month_chips.append(f'<button type="button" class="month-chip{act}" data-month="{mi}" data-yr="{year_of(ctx.months[mi])}" '
                            f'onclick="toggleWeekMonthChip({mi})">{h_enc(pretty_month(ctx.months[mi]))}</button>')
    gran_toolbar = f"""<div class="gran-toolbar">
  <div class="gran-toggle">
    <button type="button" class="gran-btn active" data-gran="monthly" onclick="setGranularity('monthly')">Monthly</button>
    <button type="button" class="gran-btn" data-gran="weekly" onclick="setGranularity('weekly')">Weekly</button>
  </div>
  <div class="gran-month-picker" id="gran-month-wrap" style="display:none;">
    <span class="gran-note" style="font-weight:600;">Month</span>
    {''.join(month_chips)}
  </div>
  <span class="gran-note">Weekly applies to Overview and every complaint-category tab, including the category breakdown on Delivery/Technical/Warehouse/Product/Suggestion &mdash; but their second-dimension breakdown (partner/platform/facility/product name) and click-to-cross-filter stay monthly-only. Not available on NPS/CSAT or the separate Product &amp; Packaging wrt Sales tab. Pick multiple months to stack their weekly tables; the Year filter below also narrows which months are offered here.</span>
</div>
<script>
(function(){{
  var curGran='monthly';
  var selectedWeekMonths = new Set([{last_eligible}]);
  window.setGranularity=function(g){{
    curGran=g;
    document.querySelectorAll('.gran-btn').forEach(function(b){{b.classList.toggle('active',b.dataset.gran===g);}});
    var mw=document.getElementById('gran-month-wrap'); if(mw){{mw.style.display=(g==='weekly')?'':'none';}}
    applyGranularity();
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
      selectedWeekMonths.forEach(function(mi){{
        document.querySelectorAll('.gran-weekly[data-month="'+mi+'"]').forEach(function(el){{el.style.display='';}});
      }});
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
  {gran_toolbar.rstrip()}
  {year_toolbar.rstrip()}
  {build_csat_panel(ctx)}
  {build_nps_panel(ctx)}
  {''.join(panels)}
  {build_prod_pkg_panel(ctx)}
  {foot}
</div>
{tabjs}"""
