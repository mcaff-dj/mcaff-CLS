"""Builds data/trend_digest.json - the cross-brand Org_KYC_Trends digest behind the Org
Overview card, modelled on the hand-written "KYC Complaint Trends" deck.

Reads the per-brand aggregate files gen_digest_facts.py emits during each brand's normal
report run, so this step costs no extra Sheets/MySQL traffic. Both brands land in ONE
artifact because the digest's whole point is comparing them side by side, which a
per-brand report HTML structurally cannot do.

Every number here is computed, never hand-entered: complaint rates are tickets divided by
that month's order volume ("Total Sales M"), the same basis the brand reports' own pivots
use. Narrative sentences are generated from ranked rate deltas with volume floors, in the
same style as gen_monthly.py's build_class_period_narrative - so this regenerates on every
refresh with no monthly editing step.

Usage: python scripts/build_trend_digest.py [--window 4] [--baseline 3]
"""
import argparse
import json
from pathlib import Path

from gen_digest_facts import SEP, parse_month_label

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
OUT_PATH = REPO_ROOT / "data/trend_digest.json"

# A candidate trend must reach this many tickets in the window before it can be reported.
# Without it, a SKU going 1 -> 4 cases outranks a courier going 800 -> 2,400 on
# percentage terms, which is how auto-ranked narratives usually end up useless.
MIN_WINDOW_CASES = 40
MIN_WINDOW_CASES_SKU = 20
# Rate deltas below this are noise at this data's volumes - don't manufacture a finding.
MIN_RATE_DELTA_PP = 0.02
MAX_TRENDS_PER_DIMENSION = 6
TOP_COURIERS = 6
TOP_PACKAGING_SKUS = 12


def rate(count, sales):
    """None - not 0 - when there's no order volume for the period. A month with no sales
    figure yet (the current month before the sheet's Total Sales M is filled in) has an
    UNKNOWN complaint rate, and averaging a 0% into the window silently drags every
    headline number down. avg() skips None, and the UI renders it as a dash."""
    if not sales:
        return None
    return count / sales * 100.0


def avg(vals):
    vals = [v for v in vals if v is not None]
    return (sum(vals) / len(vals)) if vals else None


def month_sort_key(label):
    yr, num = parse_month_label(label)
    return (yr or 0, num or 0)


def shared_axis(brands, window_n, baseline_n):
    """The month axis for every side-by-side table: the most recent (baseline_n + window_n)
    months present in EVERY brand. Restricting to the intersection is what makes the
    comparison honest - mCaffeine's month list reaches further back than Hyphen's, and a
    baseline average computed over a different span per brand isn't comparable."""
    common = None
    for b in brands:
        keys = {month_sort_key(m) for m in b["months"] if month_sort_key(m) != (0, 0)}
        common = keys if common is None else (common & keys)
    ordered = sorted(common or [])
    need = window_n + baseline_n
    ordered = ordered[-need:]
    if len(ordered) < 2:
        raise SystemExit("Not enough shared months across brands to build a digest.")
    # Give back each brand's own label for those months - the labels are per-brand strings
    # and the fact dicts are keyed by them.
    axis = []
    for key in ordered:
        entry = {"key": list(key), "labels": {}}
        for b in brands:
            for m in b["months"]:
                if month_sort_key(m) == key:
                    entry["labels"][b["brand"]] = m
                    break
        axis.append(entry)
    return axis[:-window_n], axis[-window_n:]


def pretty(entry):
    _, num = entry["key"]
    names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    yr = entry["key"][0]
    return f"{names[num]} '{str(yr)[2:]}"


def counts_for(store, key, brand, axis):
    """Ticket counts for one dimension key across a month axis, as a list aligned to axis."""
    per_month = store.get(key) or {}
    out = []
    for e in axis:
        lbl = e["labels"].get(brand)
        out.append(per_month.get(lbl, 0) if lbl else 0)
    return out


def sales_for(b, axis):
    return [b["sales"].get(e["labels"].get(b["brand"]), 0) for e in axis]


def _fmt_pct(v):
    if v is None:
        return None
    return round(v, 3)


def build_metric_table(brands, baseline, window):
    """CSAT & NPS: baseline average, each window month, window average, and the shift -
    the deck's first table. CSAT/NPS are scores, so the delta is in points, not a ratio."""
    metrics = [
        ("csat", "CSAT", 2),
        ("ai_csat", "AI CSAT", 2),
        ("nps_overall", "Overall NPS", 1),
        ("nps_product", "Product NPS", 1),
    ]
    out = []
    for b in brands:
        rows = []
        for key, label, nd in metrics:
            series = b.get(key) or {}

            def val(e):
                lbl = e["labels"].get(b["brand"])
                item = series.get(lbl) if lbl else None
                return item["v"] if item else None

            base = avg([val(e) for e in baseline])
            wins = [val(e) for e in window]
            wavg = avg(wins)
            rows.append({
                "metric": label,
                "baseline": round(base, nd) if base is not None else None,
                "months": [round(v, nd) if v is not None else None for v in wins],
                "window_avg": round(wavg, nd) if wavg is not None else None,
                "delta": round(wavg - base, nd) if (base is not None and wavg is not None) else None,
                "unit": "pts" if key.startswith("nps") else "",
            })
        out.append({"brand": b["brand"], "title": b["title"], "rows": rows})
    return out


def build_ratio_table(brands, baseline, window):
    """Order:Queries ratio - all tickets that month over that month's order volume - per
    brand plus a combined row. The combined row pools numerator and denominator across
    brands rather than averaging the two percentages, so it isn't skewed by the brands'
    very different order volumes."""
    rows = []
    for b in brands:
        def r(e):
            lbl = e["labels"].get(b["brand"])
            return rate(b["tickets"].get(lbl, 0), b["sales"].get(lbl, 0)) if lbl else 0.0
        base = avg([r(e) for e in baseline])
        wins = [r(e) for e in window]
        wavg = avg(wins)
        rows.append({
            "label": b["title"], "baseline": _fmt_pct(base),
            "months": [_fmt_pct(v) for v in wins], "window_avg": _fmt_pct(wavg),
            "delta": _fmt_pct((wavg or 0) - (base or 0)),
        })

    def pooled(e):
        t = sum(b["tickets"].get(e["labels"].get(b["brand"]), 0) for b in brands)
        s = sum(b["sales"].get(e["labels"].get(b["brand"]), 0) for b in brands)
        return rate(t, s)
    pbase = avg([pooled(e) for e in baseline])
    pwins = [pooled(e) for e in window]
    pwavg = avg(pwins)
    rows.append({
        "label": "Total Brand Average", "baseline": _fmt_pct(pbase),
        "months": [_fmt_pct(v) for v in pwins], "window_avg": _fmt_pct(pwavg),
        "delta": _fmt_pct((pwavg or 0) - (pbase or 0)), "combined": True,
    })
    return rows


def build_class_tables(brands, baseline, window):
    """Per-query-class complaint rate by month, with the baseline multiplier the deck
    shows as "▲1.9x". Multiplier is omitted when the baseline is ~0, where a ratio is
    meaningless - the raw counts carry the story instead."""
    out = []
    for b in brands:
        bsales, wsales = sales_for(b, baseline), sales_for(b, window)
        rows = []
        for cls in sorted(b["classes"], key=lambda c: -sum(b["classes"][c].values())):
            bc = counts_for(b["classes"], cls, b["brand"], baseline)
            wc = counts_for(b["classes"], cls, b["brand"], window)
            if sum(bc) + sum(wc) < MIN_WINDOW_CASES:
                continue
            brates = [rate(c, s) for c, s in zip(bc, bsales)]
            wrates = [rate(c, s) for c, s in zip(wc, wsales)]
            base, wavg = avg(brates), avg(wrates)
            rows.append({
                "label": cls, "baseline": _fmt_pct(base),
                "months": [_fmt_pct(v) for v in wrates], "window_avg": _fmt_pct(wavg),
                "multiplier": round(wavg / base, 1) if (base and base > 0.005) else None,
                "baseline_cases": sum(bc), "window_cases": sum(wc),
            })
        tb = [b["tickets"].get(e["labels"].get(b["brand"]), 0) for e in baseline]
        tw = [b["tickets"].get(e["labels"].get(b["brand"]), 0) for e in window]
        tbase = avg([rate(c, s) for c, s in zip(tb, bsales)])
        twin = [rate(c, s) for c, s in zip(tw, wsales)]
        twavg = avg(twin)
        rows.append({
            "label": "Total", "baseline": _fmt_pct(tbase),
            "months": [_fmt_pct(v) for v in twin], "window_avg": _fmt_pct(twavg),
            "multiplier": round(twavg / tbase, 1) if (tbase and tbase > 0.005) else None,
            "total": True,
        })
        out.append({"brand": b["brand"], "title": b["title"], "rows": rows})
    return out


def _verb(delta):
    return "rose" if delta > 0 else "fell"


def _candidates(b, store, dimension, baseline, window, min_cases):
    bsales, wsales = sales_for(b, baseline), sales_for(b, window)
    sb, sw = sum(bsales), sum(wsales)
    found = []
    for key in store:
        bc = sum(counts_for(store, key, b["brand"], baseline))
        wc = sum(counts_for(store, key, b["brand"], window))
        if wc < min_cases:
            continue
        br, wr = rate(bc, sb), rate(wc, sw)
        delta = wr - br
        if abs(delta) < MIN_RATE_DELTA_PP:
            continue
        parts = key.split(SEP)
        found.append({
            "dimension": dimension,
            "key": key,
            "parts": parts,
            "baseline_rate": _fmt_pct(br),
            "window_rate": _fmt_pct(wr),
            "delta": _fmt_pct(delta),
            "baseline_cases": bc,
            "window_cases": wc,
            "multiplier": round(wr / br, 1) if br > 0.005 else None,
        })
    found.sort(key=lambda c: -abs(c["delta"]))
    return found[:MAX_TRENDS_PER_DIMENSION]


def _sentence(b, c, baseline_label, window_label):
    parts = c["parts"]
    if c["dimension"] == "class":
        subject = f"{parts[0]} complaints"
    elif c["dimension"] == "category":
        subject = f"{parts[1]} ({parts[0]})"
    elif c["dimension"] == "courier":
        subject = f"{parts[0]} - {parts[1]}"
    else:
        subject = f"{parts[0]} - {parts[1]}"
    mult = f", {c['multiplier']}x" if c.get("multiplier") else ""
    # No brand prefix here - the brand is now the group's own sub-heading (see
    # build_worst_trends), so repeating it on every line would be redundant.
    return (f"{subject} {_verb(c['delta'])} from {c['baseline_rate']}% of orders "
            f"({baseline_label}) to {c['window_rate']}% ({window_label}) - "
            f"{c['baseline_cases']:,} to {c['window_cases']:,} cases{mult}.")


def build_worst_trends(brands, baseline, window):
    """The deck's "Five Worst Trends", derived rather than written: rank every dimension's
    keys by change in complaint rate between the baseline and the window, apply volume
    floors, and keep the largest movers. Grouped by dimension so one noisy dimension can't
    crowd out the others, then by brand within each dimension - interleaving mCaffeine and
    Hyphen lines by raw delta reads as a shuffled list; a reader wants one brand's picture
    at a time, ranked within itself."""
    baseline_label = f"{pretty(baseline[0])}-{pretty(baseline[-1])}" if len(baseline) > 1 else pretty(baseline[0])
    window_label = f"{pretty(window[0])}-{pretty(window[-1])}" if len(window) > 1 else pretty(window[0])
    groups = []
    specs = [
        ("class", "classes", "Query class", MIN_WINDOW_CASES),
        ("category", "cats", "Complaint category", MIN_WINDOW_CASES),
        ("courier", "partner_cats", "Courier x issue", MIN_WINDOW_CASES),
        ("sku", "product_cats", "SKU x issue", MIN_WINDOW_CASES_SKU),
    ]
    for dim, store_key, title, floor in specs:
        by_brand = []
        for b in brands:
            items = []
            for c in _candidates(b, b.get(store_key) or {}, dim, baseline, window, floor):
                c = dict(c)
                c["brand"] = b["brand"]
                c["brand_title"] = b["title"]
                c["sentence"] = _sentence(b, c, baseline_label, window_label)
                items.append(c)
            items.sort(key=lambda c: -abs(c["delta"]))
            if items:
                by_brand.append({"brand": b["brand"], "title": b["title"], "items": items})
        if by_brand:
            groups.append({"dimension": dim, "title": title, "by_brand": by_brand})
    return {"baseline_label": baseline_label, "window_label": window_label, "groups": groups}


def build_packaging(brands, baseline, window):
    """Packaging deep dive: SKU-level rates within each brand's own packaging query class,
    driven off the class label rather than a hardcoded list of defect names, plus the
    batch-level concentrations the deck flags by hand."""
    out = []
    for b in brands:
        pack_classes = [c for c in b["classes"] if "packaging" in c.lower()]
        skus = {}
        for key, per_month in (b.get("product_cats") or {}).items():
            prod, cat = key.split(SEP, 1)
            # product_cats is keyed by category, not class - match the defect vocabulary
            # the packaging class actually uses in this data.
            if not any(w in cat.lower() for w in
                       ("spill", "broken", "seal", "damage", "leak", "packaging", "tamper")):
                continue
            d = skus.setdefault(prod, {})
            for mo, n in per_month.items():
                d[mo] = d.get(mo, 0) + n
        bsales, wsales = sum(sales_for(b, baseline)), sum(sales_for(b, window))
        rows = []
        for prod, per_month in skus.items():
            bc = sum(per_month.get(e["labels"].get(b["brand"]), 0) for e in baseline)
            wc = sum(per_month.get(e["labels"].get(b["brand"]), 0) for e in window)
            if wc < MIN_WINDOW_CASES_SKU:
                continue
            br, wr = rate(bc, bsales), rate(wc, wsales)
            rows.append({
                "product": prod, "baseline_rate": _fmt_pct(br), "window_rate": _fmt_pct(wr),
                "delta": _fmt_pct(wr - br), "baseline_cases": bc, "window_cases": wc,
                "months": [per_month.get(e["labels"].get(b["brand"]), 0) for e in window],
            })
        rows.sort(key=lambda r: -(r["delta"] or 0))

        batch_rows = []
        for key, per_month in (b.get("batches") or {}).items():
            prod, batch = key.split(SEP, 1)
            wc = sum(per_month.get(e["labels"].get(b["brand"]), 0) for e in window)
            if wc < MIN_WINDOW_CASES_SKU:
                continue
            batch_rows.append({"product": prod, "batch": batch, "window_cases": wc,
                               "months": [per_month.get(e["labels"].get(b["brand"]), 0) for e in window]})
        batch_rows.sort(key=lambda r: -r["window_cases"])
        out.append({"brand": b["brand"], "title": b["title"],
                    "packaging_classes": pack_classes,
                    "skus": rows[:TOP_PACKAGING_SKUS], "batches": batch_rows[:10]})
    return out


def build_repeat_offenders(brands, baseline, window):
    """Couriers that stay bad across the window, and the SKUs that recur - the deck's
    final two tables. A courier is included on window volume, then shown month by month
    with its single worst issue category, which is what makes the pattern legible."""
    couriers = []
    for b in brands:
        wsales = sum(sales_for(b, window))
        ranked = []
        for partner, per_month in (b.get("partners") or {}).items():
            if partner == "(blank)":
                continue
            wc = sum(per_month.get(e["labels"].get(b["brand"]), 0) for e in window)
            if wc < MIN_WINDOW_CASES:
                continue
            top_cat, top_n = None, 0
            for key, pm in (b.get("partner_cats") or {}).items():
                p, cat = key.split(SEP, 1)
                if p != partner:
                    continue
                n = sum(pm.get(e["labels"].get(b["brand"]), 0) for e in window)
                if n > top_n:
                    top_cat, top_n = cat, n
            ranked.append({
                "courier": partner, "window_cases": wc, "window_rate": _fmt_pct(rate(wc, wsales)),
                "months": [per_month.get(e["labels"].get(b["brand"]), 0) for e in window],
                "top_issue": top_cat, "top_issue_cases": top_n,
            })
        ranked.sort(key=lambda r: -(r["window_rate"] or 0))
        couriers.append({"brand": b["brand"], "title": b["title"], "rows": ranked[:TOP_COURIERS]})

    skus = []
    for b in brands:
        wsales = sum(sales_for(b, window))
        agg = {}
        for key, pm in (b.get("product_cats") or {}).items():
            prod, cat = key.split(SEP, 1)
            months_present = sum(1 for e in window if pm.get(e["labels"].get(b["brand"]), 0) > 0)
            wc = sum(pm.get(e["labels"].get(b["brand"]), 0) for e in window)
            if wc < MIN_WINDOW_CASES_SKU:
                continue
            d = agg.setdefault(prod, {"issues": [], "window_cases": 0, "recur": 0})
            d["issues"].append({"issue": cat, "cases": wc, "months_present": months_present})
            d["window_cases"] += wc
            d["recur"] = max(d["recur"], months_present)
        rows = []
        for prod, d in agg.items():
            d["issues"].sort(key=lambda i: -i["cases"])
            rows.append({
                "product": prod, "window_cases": d["window_cases"],
                "window_rate": _fmt_pct(rate(d["window_cases"], wsales)),
                "months_recurring": d["recur"], "issues": d["issues"][:4],
            })
        # Recurrence first, then volume: the deck's point about these SKUs is that they
        # come back every month, not that they're the single biggest in one month.
        rows.sort(key=lambda r: (-r["months_recurring"], -r["window_cases"]))
        skus.append({"brand": b["brand"], "title": b["title"], "rows": rows[:12]})
    return {"couriers": couriers, "skus": skus}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=4, help="Months in the reporting window.")
    ap.add_argument("--baseline", type=int, default=3, help="Months of baseline before the window.")
    args = ap.parse_args()

    brands = []
    for name in ("mcaffeine", "hyphen"):
        p = REPO_ROOT / f"data/{name}_digest_facts.json"
        if not p.exists():
            raise SystemExit(f"Missing {p} - run generate_report.py for both brands first.")
        with open(p, "r", encoding="utf-8-sig") as f:
            brands.append(json.load(f))

    baseline, window = shared_axis(brands, args.window, args.baseline)
    digest = {
        "window_months": [pretty(e) for e in window],
        "baseline_months": [pretty(e) for e in baseline],
        "brands": [{"brand": b["brand"], "title": b["title"]} for b in brands],
        "metrics": build_metric_table(brands, baseline, window),
        "ratio": build_ratio_table(brands, baseline, window),
        "class_tables": build_class_tables(brands, baseline, window),
        "worst_trends": build_worst_trends(brands, baseline, window),
        "packaging": build_packaging(brands, baseline, window),
        "repeat_offenders": build_repeat_offenders(brands, baseline, window),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(digest, f, separators=(",", ":"), ensure_ascii=False)
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.0f} KB) - "
          f"baseline {digest['baseline_months']}, window {digest['window_months']}")


if __name__ == "__main__":
    main()
