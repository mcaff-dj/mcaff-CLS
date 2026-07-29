"""Insight-card builders. Python port of gen-insights.ps1.
Each build_*_insights function inspects the same data used to build a tab's panel and
returns a small HTML card of colour-coded callouts (severity = conditional formatting):
  crit  = red   (sharp negative swing / bad score)
  watch = amber (notable but not alarming)
  good  = green (improvement)
  info  = blue  (neutral fact, e.g. "top issue this month")
"""
from report_context import ci_key, fnum, h_enc, pretty_month, round1, n0

_LABELS = {"crit": "Pain Point", "watch": "Watch", "good": "Improving"}


def insight_item(tag, html):
    label = _LABELS.get(tag, "Info")
    return f"<div class='insight-item'><span class='insight-dot {tag}'></span><span>{html} <span class='tag {tag}'>{label}</span></span></div>"


def build_insights_card(title, items):
    items = [i for i in items if i]
    if not items:
        return ""
    return f"<div class='insights'><h3>{title}</h3><div class='insight-list'>{chr(10).join(items)}</div></div>"


def get_category_insight_items(ctx, subset):
    n = ctx.n
    lm, pm = n - 1, n - 2
    months = ctx.months
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
    if not cat_order:
        return []

    items = []
    top = None
    top_val = -1
    for cat in cat_order:
        v = cat_month[cat].get(months[lm], 0)
        if v > top_val:
            top_val = v
            top = cat
    tot_lm = sum(cat_month[cat].get(months[lm], 0) for cat in cat_order)
    if top and top_val > 0:
        sh = round1(top_val / tot_lm * 100) if tot_lm > 0 else 0
        sm = ctx.sales_m.get(months[lm], 0)
        wrt = round1(top_val / sm * 100) if sm > 0 else 0
        items.append(insight_item("info", f"Top issue in {pretty_month(months[lm])}: <b>{h_enc(top)}</b> &mdash; {n0(top_val)} tickets ({fnum(sh)}% of this tab's volume, {fnum(wrt)}% of sales)."))

    if pm >= 0:
        riser = None
        riser_pct = -999999
        riser_lm = riser_pm = 0
        faller = None
        faller_pct = 999999
        faller_lm = faller_pm = 0
        for cat in cat_order:
            v_lm = cat_month[cat].get(months[lm], 0)
            v_pm = cat_month[cat].get(months[pm], 0)
            if v_pm >= 3:
                chg = round1(((v_lm - v_pm) / v_pm) * 100)
                if chg > riser_pct:
                    riser_pct, riser, riser_lm, riser_pm = chg, cat, v_lm, v_pm
                if chg < faller_pct:
                    faller_pct, faller, faller_lm, faller_pm = chg, cat, v_lm, v_pm
        if riser and riser_pct > 30:
            items.append(insight_item("crit", f"<b>{h_enc(riser)}</b> spiked {fnum(riser_pct)}% vs {pretty_month(months[pm])} ({n0(riser_pm)} &rarr; {n0(riser_lm)} tickets)."))
        elif riser and riser_pct > 12:
            items.append(insight_item("watch", f"<b>{h_enc(riser)}</b> rose {fnum(riser_pct)}% vs {pretty_month(months[pm])} ({n0(riser_pm)} &rarr; {n0(riser_lm)} tickets)."))
        if faller and faller_pct < -25 and faller != riser:
            items.append(insight_item("good", f"<b>{h_enc(faller)}</b> improved, down {fnum(abs(faller_pct))}% vs {pretty_month(months[pm])} ({n0(faller_pm)} &rarr; {n0(faller_lm)} tickets)."))
    return items


def get_delivery_partner_insight(ctx, delivery):
    n = ctx.n
    lm = n - 1
    months = ctx.months
    pm = {}
    a_sum = {}
    a_cnt = {}
    p_cache = {}
    for r in delivery:
        p = ctx.cell(r, ctx.col["partner"])
        if not str(p).strip():
            p = "(blank)"
        p = ci_key(p, p_cache)
        mo = ctx.cell(r, ctx.col["month"])
        if not str(mo).strip():
            continue
        pm.setdefault(p, {})
        pm[p][mo] = pm[p].get(mo, 0) + 1
        ar = ctx.cell(r, ctx.col["alloc"])
        try:
            av = float(str(ar).replace(",", ""))
        except (ValueError, TypeError):
            av = 0.0
        if av > 0:
            ak = f"{p}|{mo}"
            a_sum[ak] = a_sum.get(ak, 0) + av
            a_cnt[ak] = a_cnt.get(ak, 0) + 1

    worst = None
    worst_rate = -1
    worst_cnt = 0
    for p in pm:
        cnt = pm[p].get(months[lm], 0)
        if cnt < 5:
            continue
        ak = f"{p}|{months[lm]}"
        avg = (a_sum[ak] / a_cnt[ak]) if a_cnt.get(ak, 0) > 0 else 0
        if avg > 0:
            rate = round1(cnt / avg * 100)
            if rate > worst_rate:
                worst_rate, worst, worst_cnt = rate, p, cnt
    if not worst:
        return None
    tag = "crit" if worst_rate > 8 else ("watch" if worst_rate > 4 else "good")
    return insight_item(tag, f"<b>{h_enc(worst)}</b> had the highest complaint rate wrt allocation in {pretty_month(months[lm])}: {fnum(worst_rate)}% ({n0(worst_cnt)} tickets).")


def get_overview_insight_items(ctx, class_month):
    n = ctx.n
    lm, pm = n - 1, n - 2
    months = ctx.months
    items = []
    top = None
    top_val = -1
    riser = None
    riser_pct = -999999
    riser_lm = riser_pm = 0
    tot_lm = 0
    for c in ctx.b["classes"]:
        cm = class_month.get(c["key"])
        v_lm = cm.get(months[lm], 0) if cm else 0
        tot_lm += v_lm
        if v_lm > top_val:
            top_val, top = v_lm, c
        if pm >= 0:
            v_pm = cm.get(months[pm], 0) if cm else 0
            if v_pm >= 5:
                chg = round1(((v_lm - v_pm) / v_pm) * 100)
                if chg > riser_pct:
                    riser_pct, riser, riser_lm, riser_pm = chg, c, v_lm, v_pm
    if top and top_val > 0:
        sh = round1(top_val / tot_lm * 100) if tot_lm > 0 else 0
        items.append(insight_item("info", f"<b>{h_enc(top['label'])}</b> was the top complaint driver in {pretty_month(months[lm])} with {n0(top_val)} tickets ({fnum(sh)}% of that month's volume)."))
    if riser and riser_pct > 25:
        items.append(insight_item("crit", f"<b>{h_enc(riser['label'])}</b> complaints jumped {fnum(riser_pct)}% month-on-month ({n0(riser_pm)} &rarr; {n0(riser_lm)})."))
    elif riser and riser_pct > 10:
        items.append(insight_item("watch", f"<b>{h_enc(riser['label'])}</b> complaints rose {fnum(riser_pct)}% month-on-month ({n0(riser_pm)} &rarr; {n0(riser_lm)})."))
    return items


def get_score_insight(rows, label, score_good, score_watch):
    if not rows or len(rows) < 2:
        return None
    last = rows[-1]
    # A sheet formula error (#REF!, #N/A, etc.) in the latest row leaves nothing
    # sensible to show - skip this insight rather than crash the whole run.
    try:
        last_score = float(last[2])
    except (ValueError, TypeError):
        return None
    last_month = pretty_month(last[0])
    chg = None
    if len(rows) >= 3:
        prev = rows[-2]
        # Same error, but in the prior row only - still show the insight, just
        # without a month-on-month trend comparison.
        try:
            chg = round1(last_score - float(prev[2]))
        except (ValueError, TypeError):
            chg = None
    tag = "good" if last_score >= score_good else ("watch" if last_score >= score_watch else "crit")
    trend = ""
    if chg is not None:
        if chg > 0:
            trend = f" (up {fnum(chg)} vs prior month)"
        elif chg < 0:
            trend = f" (down {fnum(abs(chg))} vs prior month)"
        else:
            trend = " (flat vs prior month)"
    return insight_item(tag, f"<b>{h_enc(label)}</b> is at <b>{fnum(last_score)}</b> in {last_month}{trend}.")
