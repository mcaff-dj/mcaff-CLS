"""Per-brand aggregate facts for the cross-brand Org_KYC_Trends digest.

Emitted as a side output of each brand's normal generate_report.py run (which already
holds every ticket row in memory) rather than by a standalone script that would have to
re-query the CLS_KYC_* mirrors and re-read the sheet tail a second time - that pull costs
~12-25s per brand, and the digest needs no row the report doesn't already have.

The output is deliberately AGGREGATES ONLY - counts per (dimension, month) - never ticket
rows. That is what keeps data/trend_digest.json small enough to serve from cache to many
concurrent readers instead of streaming megabytes per page view; see build_trend_digest.py
and api/report/data/[key].js. Long-tail keys are dropped (MIN_KEY_TOTAL) and each dimension
is capped (TOP_*), so the file size is bounded by configuration rather than by how many
distinct SKUs/couriers happen to appear.
"""
import json
import re

# A key (courier, SKU, category...) needs at least this many tickets across the whole
# month axis to be carried at all. Below it, a "rate" computed against monthly order
# volume is noise - one or two tickets moving is a multi-hundred-percent swing.
MIN_KEY_TOTAL = 15
TOP_PARTNERS = 30
TOP_PRODUCTS = 90
TOP_CATEGORIES = 150
TOP_PARTNER_CATS = 300
TOP_PRODUCT_CATS = 300
TOP_BATCHES = 80

SEP = "||"

_MONTH_NUMS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
_LABEL_RE = re.compile(r"^(\d+)_([A-Za-z]{3})(?:'(\d{2}))?")


def parse_month_label(label):
    """"7_Jul'26" -> (2026, 7). Returns (None, num) when the label carries no year (the
    CSAT sheet tabs have rows like "12_Dec"), so callers can backfill it."""
    m = _LABEL_RE.match(str(label).strip())
    if not m:
        return (None, None)
    num = int(m.group(1))
    if not (1 <= num <= 12):
        num = _MONTH_NUMS.get(m.group(2).lower(), num)
    yr = int("20" + m.group(3)) if m.group(3) else None
    return (yr, num)


def series_by_month(rows, months):
    """The Agent/AI CSAT sheet tabs and the MySQL-sourced NPS series are all the same
    shape - header row, then [month_label, total_responses, value] - but their month
    labels are the sheet's own and don't always carry a year (see build_combo2's note in
    gen_panels.py). Maps them onto the brand's canonical ctx.months labels via (year,
    month-number), backfilling a missing year by walking backwards from the nearest later
    row that has one and decrementing across a month-number wraparound.

    Returns {canonical_month_label: {"n": int, "v": float}}.
    """
    parsed = []
    for r in rows[1:] if rows else []:
        if not isinstance(r, (list, tuple)) or len(r) < 3:
            continue
        try:
            n = int(float(str(r[1]).replace(",", "")))
            v = float(str(r[2]).replace(",", ""))
        except (ValueError, TypeError):
            # Sheet formula errors (#REF!/#N/A) leak into these columns when an upstream
            # reference breaks - skip the row rather than fail the whole digest.
            continue
        yr, num = parse_month_label(r[0])
        if num is None:
            continue
        parsed.append({"yr": yr, "num": num, "n": n, "v": v})

    carry = None
    for i in range(len(parsed) - 1, -1, -1):
        if parsed[i]["yr"]:
            carry = parsed[i]["yr"]
        elif carry and i < len(parsed) - 1 and parsed[i]["num"] > parsed[i + 1]["num"]:
            carry = carry - 1
        parsed[i]["yr"] = parsed[i]["yr"] or carry

    canon = {}
    for lbl in months:
        yr, num = parse_month_label(lbl)
        if yr and num:
            canon[(yr, num)] = lbl

    out = {}
    for p in parsed:
        lbl = canon.get((p["yr"], p["num"]))
        if lbl:
            out[lbl] = {"n": p["n"], "v": p["v"]}
    return out


def _bump(store, key, month, by=1):
    d = store.setdefault(key, {})
    d[month] = d.get(month, 0) + by


def _prune(store, top_n, min_total=MIN_KEY_TOTAL):
    """Drop keys under min_total, then keep the top_n by total volume. Returns the pruned
    dict - the cap is what bounds the artifact's size regardless of source cardinality."""
    totals = {k: sum(v.values()) for k, v in store.items()}
    keep = [k for k, t in totals.items() if t >= min_total]
    keep.sort(key=lambda k: totals[k], reverse=True)
    return {k: store[k] for k in keep[:top_n]}


def build_facts(ctx):
    col = ctx.col
    months = list(ctx.months)
    month_set = set(months)

    tickets, tickets_all, classes, cats = {}, {}, {}, {}
    partners, partner_cats, product_cats, batches = {}, {}, {}, {}

    for r in ctx.data_rows:
        mo = ctx.cell(r, col["month"])
        if mo not in month_set:
            # Rows outside the configured month axis (stale sheet rows, or a month that
            # hasn't been added to brands.py yet) are ignored rather than silently
            # inflating a month that IS on the axis.
            continue
        tickets_all[mo] = tickets_all.get(mo, 0) + 1
        # Every rate in the digest counts UNIQUE tickets only, matching the source deck:
        # verified against it rather than assumed - mCaffeine Apr/May/Jun on the unique
        # basis give 2.66%/3.69%/5.14% against the deck's 2.70%/3.70%/5.10%, where all
        # rows would give 3.49%/5.85%/8.24%. One complaint raised over three contacts is
        # one complaint; counting duplicates makes every rate ~1.5x too high.
        if str(ctx.cell(r, col["uniq"])).strip() != "Unique":
            continue
        tickets[mo] = tickets.get(mo, 0) + 1

        cls = str(ctx.cell(r, col["cls"])).strip() or "(blank)"
        cat = str(ctx.cell(r, col["cat"])).strip() or "(none)"
        _bump(classes, cls, mo)
        _bump(cats, cls + SEP + cat, mo)

        partner = str(ctx.cell(r, col["partner"])).strip() or "(blank)"
        _bump(partners, partner, mo)
        _bump(partner_cats, partner + SEP + cat, mo)

        prod = str(ctx.cell(r, col["prod"])).strip()
        if prod:
            _bump(product_cats, prod + SEP + cat, mo)
            batch = str(ctx.cell(r, col["batch"])).strip()
            if batch and batch.lower() not in ("na", "n/a", "-"):
                _bump(batches, prod + SEP + batch, mo)

    return {
        "brand": ctx.b["brand"],
        "title": ctx.b["title"],
        "months": months,
        # Monthly order volume ("Total Sales M"), the denominator every complaint rate in
        # the digest is computed against - same basis the report's own pivots use.
        "sales": {mo: int(ctx.sales_m.get(mo, 0)) for mo in months},
        "tickets": tickets,
        # Kept alongside the unique count so the digest can show how much duplication sits
        # behind a month without needing a second pass over the rows.
        "tickets_all": tickets_all,
        "class_labels": {c["key"]: c["label"] for c in ctx.b["classes"]},
        "classes": classes,
        "cats": _prune(cats, TOP_CATEGORIES),
        "partners": _prune(partners, TOP_PARTNERS),
        "partner_cats": _prune(partner_cats, TOP_PARTNER_CATS),
        "product_cats": _prune(product_cats, TOP_PRODUCT_CATS),
        "batches": _prune(batches, TOP_BATCHES),
        "csat": series_by_month(ctx.agent, months),
        "ai_csat": series_by_month(ctx.ai, months),
        "nps_overall": series_by_month(ctx.mom, months),
        "nps_product": series_by_month(ctx.prodnps, months),
    }


def write_facts(ctx, out_path):
    facts = build_facts(ctx)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(facts, f, separators=(",", ":"), ensure_ascii=False)
    return facts
