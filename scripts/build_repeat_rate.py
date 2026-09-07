"""Builds data/repeat_rate.json - the Repeat Rate analysis tab under Org Overview.

For every NPS response (PEP_CLS.nps_delivery, submitted_date > 2026-01-01), checks whether
that phone also placed a valid order (mcaff_prod.Item_level_data, Final_Status != 'CANCELLED')
in the SAME calendar month (M0), then in each of the next 12 months (M1..M12). Counts are
aggregated by (brand, top_rated_area, nps_score) so the UI can show a cohort-retention
heatmap filterable by brand and by which area the respondent rated highest.

Item_level_data is ~50M rows - the batched IN(...) lookup below only works because
Notification_Mobile is indexed (see idx_ild_grouping / idx_ild_channel_status_mobile); an
unfiltered scan of that table times out (see docs/CODEBASE_REFERENCE.md). This is why the
step only runs on the once-a-day NPS-refresh schedule (see refresh.py), not every run.

Usage: python scripts/build_repeat_rate.py
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import mysql_lib

OUT_PATH = REPO_ROOT / "data/repeat_rate.json"

AREA_CODE = {"1": "delivery", "2": "cs", "3": "product", "4": "website"}
AREA_LABEL = {
    "all": "All areas",
    "delivery": "Delivery experience",
    "cs": "Customer support",
    "product": "Product",
    "website": "Website / app experience",
}
BRANDS = {"mcaffeine", "hyphen"}  # normalized (lowercased) - nps_delivery.brand is 'Mcaffeine'/'Hyphen'
BRAND_LABEL = {"all": "All brands", "mcaffeine": "Mcaffeine", "hyphen": "Hyphen"}
SCORES = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
HORIZON_MONTHS = 12  # M0..M12
PROMOTER_SCORES = {9, 10}
PASSIVE_SCORES = {7, 8}
DETRACTOR_SCORES = {0, 1, 2, 3, 4, 5, 6}
BATCH = 800
# A brand/area cut needs at least this many cohort (M0) phones before its M3 retention % is
# stable enough to call out by name in an auto-generated insight - same reasoning as
# build_trend_digest.py's MIN_WINDOW_CASES: a 3-phone cohort swinging from 33% to 66% on one
# extra repeat order isn't a finding.
MIN_COHORT_FOR_INSIGHT = 150


def add_months(y, m, n):
    total = (y * 12 + (m - 1)) + n
    return total // 12, total % 12 + 1


def main():
    print("Pulling nps_delivery...", file=sys.stderr)
    nps_rows = mysql_lib.query(
        """
        SELECT customer_phone, brand, nps_score, top_rated_area, submitted_date
        FROM nps_delivery
        WHERE submitted_date > '2026-01-01' AND customer_phone IS NOT NULL AND customer_phone != ''
              AND nps_score IS NOT NULL AND nps_score != ''
        """,
        database="PEP_CLS",
    )
    if nps_rows is None:
        raise SystemExit("MYSQL_* credentials not configured - cannot build repeat_rate.json")
    print(f"  {len(nps_rows)} responses", file=sys.stderr)

    responses = []
    phones = set()
    for phone, brand, score, area, submitted in nps_rows:
        try:
            score_i = int(float(score))
        except (TypeError, ValueError):
            continue
        if score_i < 0 or score_i > 10:
            continue
        phone = (phone or "").strip()
        if not phone:
            continue
        d, m_, y = submitted.split("/")
        brand_key = (brand or "").strip().lower()
        responses.append({
            "phone": phone, "brand": brand, "score": score_i,
            "brand_key": brand_key if brand_key in BRANDS else None,
            "area": AREA_CODE.get(area), "ym": (int(y), int(m_)),
        })
        phones.add(phone)

    phones = sorted(phones)
    print(f"  {len(phones)} distinct phones", file=sys.stderr)

    print("Pulling Item_level_data order-months (batched)...", file=sys.stderr)
    order_months = defaultdict(set)
    for i in range(0, len(phones), BATCH):
        batch = phones[i:i + BATCH]
        placeholders = ",".join(["%s"] * len(batch))
        rows = mysql_lib.query(
            f"""
            SELECT DISTINCT Notification_Mobile, DATE_FORMAT(Order_Date, '%%Y-%%m')
            FROM Item_level_data
            WHERE Notification_Mobile IN ({placeholders}) AND Final_Status != 'CANCELLED'
            """,
            tuple(batch),
            database="mcaff_prod",
        )
        for phone, ym in rows:
            y, m_ = ym.split("-")
            order_months[phone].add((int(y), int(m_)))
        print(f"  batch {i // BATCH + 1}/{(len(phones) + BATCH - 1) // BATCH} done", file=sys.stderr)

    print("Aggregating cohorts...", file=sys.stderr)
    agg = defaultdict(lambda: [0] * (HORIZON_MONTHS + 1))
    # Every NPS response counts here regardless of whether the phone ever ordered - this is
    # "how many people gave this score", separate from agg's M0 ("...and also ordered that
    # same month"), which is a filtered subset, not the total. Keyed by (brand, area, score) -
    # "all" for brand/area means "not filtered on this dimension", so every response also
    # rolls up into the ("all","all",score) bucket in addition to its own brand/area buckets.
    totals = defaultdict(int)
    for r in responses:
        brand_keys = {"all"} | ({r["brand_key"]} if r["brand_key"] else set())
        area_keys = {"all"} | ({r["area"]} if r["area"] else set())
        for bkey in brand_keys:
            for akey in area_keys:
                totals[(bkey, akey, r["score"])] += 1

        months = order_months.get(r["phone"])
        if not months:
            continue
        y0, m0 = r["ym"]
        if (y0, m0) not in months:
            continue
        for bkey in brand_keys:
            for akey in area_keys:
                agg[(bkey, akey, r["score"])][0] += 1
        for k in range(1, HORIZON_MONTHS + 1):
            yk, mk = add_months(y0, m0, k)
            if (yk, mk) in months:
                for bkey in brand_keys:
                    for akey in area_keys:
                        agg[(bkey, akey, r["score"])][k] += 1

    def pct_m3(scores):
        m0 = sum(agg[("all", "all", s)][0] for s in scores)
        m3 = sum(agg[("all", "all", s)][3] for s in scores)
        return round(m3 / m0 * 100, 1) if m0 else None

    def m3_pct_and_cohort(brand, area, scores):
        """M3-retention % and its own cohort (M0) size for one (brand, area, score-group) cut -
        the cohort is what gates whether this cut is even worth naming in an insight."""
        m0 = sum(agg[(brand, area, s)][0] for s in scores)
        m3 = sum(agg[(brand, area, s)][3] for s in scores)
        return (round(m3 / m0 * 100, 1) if m0 else None), m0

    def build_insights():
        """Every insight here is recomputed from this run's own numbers - nothing hand-written
        to go stale. Volume-gated (MIN_COHORT_FOR_INSIGHT) so a small cut doesn't get called out
        on a couple of orders, same spirit as build_trend_digest.py's MIN_WINDOW_CASES floor.

        Framed for prioritization, not just description: where a plain "X% vs Y%" comparison
        would do, this instead sizes the customer-count opportunity of closing a gap and weighs
        retention against cohort volume - the two numbers that decide where a small team should
        actually spend its next fix, rather than just which cut looks worst on paper. M6/M12 are
        deliberately not used for a "does the gap persist" claim - most of this cohort responded
        Apr-Aug'26, so almost none have reached those horizons yet and the raw M6/M12 counts are
        overwhelmingly right-censored, not a real decay signal (see the UI's own caveat on this).
        """
        out_insights = []

        promoter_pct, promoter_n = m3_pct_and_cohort("all", "all", PROMOTER_SCORES)
        passive_pct, passive_n = m3_pct_and_cohort("all", "all", PASSIVE_SCORES)
        detractor_pct, detractor_n = m3_pct_and_cohort("all", "all", DETRACTOR_SCORES)
        if promoter_pct and detractor_pct:
            mult = round(promoter_pct / detractor_pct, 1)
            recoverable = 0
            if passive_pct is not None:
                recoverable += passive_n * max(0, promoter_pct - passive_pct) / 100
            recoverable += detractor_n * max(0, promoter_pct - detractor_pct) / 100
            out_insights.append(
                f"Promoters (9-10) repeat-purchase by M3 at {promoter_pct}% vs {detractor_pct}% for "
                f"detractors (0-6) - {mult}x more likely to still be ordering three months later. "
                f"If passives and detractors from this Jan'26+ cohort alone repeated at the promoter "
                f"rate, roughly {round(recoverable):,} more phones would have reordered by M3 - "
                f"that gap, not the NPS score itself, is the retention budget worth chasing."
            )

        brand_all = {b: m3_pct_and_cohort(b, "all", SCORES) for b in ("mcaffeine", "hyphen")}
        if all(n >= MIN_COHORT_FOR_INSIGHT for _, n in brand_all.values()):
            (hi_brand, (hi_pct, hi_n)), (lo_brand, (lo_pct, lo_n)) = sorted(
                brand_all.items(), key=lambda kv: -kv[1][0]
            )
            if hi_pct > lo_pct:
                brand_mult = round(hi_pct / lo_pct, 1) if lo_pct else None
                half_gap = round(lo_n * (hi_pct - lo_pct) / 100 / 2)
                out_insights.append(
                    f"{BRAND_LABEL[hi_brand]} customers repeat-purchase by M3 at {hi_pct}% overall "
                    f"vs {lo_pct}% for {BRAND_LABEL[lo_brand]}"
                    + (f" ({brand_mult}x)" if brand_mult else "")
                    + f" - on {lo_n:,} respondents, that's the single biggest lever in this data: "
                    f"closing even half the gap adds roughly {half_gap:,} more repeat customers "
                    f"from {BRAND_LABEL[lo_brand]} alone."
                )

        area_all = {a: m3_pct_and_cohort("all", a, SCORES) for a in ("delivery", "cs", "product", "website")}
        qualifying = {a: (pct, n) for a, (pct, n) in area_all.items()
                      if pct is not None and n >= MIN_COHORT_FOR_INSIGHT}
        if len(qualifying) >= 2:
            total_n = sum(n for _, n in qualifying.values())
            biggest_area = max(qualifying, key=lambda a: qualifying[a][1])
            weakest_area = min(qualifying, key=lambda a: qualifying[a][0])
            big_pct, big_n = qualifying[biggest_area]
            share = round(big_n / total_n * 100) if total_n else 0
            if biggest_area == weakest_area:
                out_insights.append(
                    f"{AREA_LABEL[biggest_area]} is both the largest top-rated-area cohort "
                    f"({big_n:,}, {share}% of the tracked cohort) and its weakest M3 retention "
                    f"({big_pct}%) - the single highest-leverage place to fix, since any improvement "
                    f"compounds across the most customers."
                )
            else:
                weak_pct, weak_n = qualifying[weakest_area]
                out_insights.append(
                    f"{AREA_LABEL[biggest_area]} draws the most respondents ({big_n:,}, {share}% of "
                    f"the tracked cohort) at {big_pct}% M3 retention - the highest-leverage area to "
                    f"improve, since even a small lift compounds across the most customers. "
                    f"{AREA_LABEL[weakest_area]} lags furthest behind at {weak_pct}%, but on a much "
                    f"smaller base ({weak_n:,}) - worth investigating, but a lower-priority fix today."
                )

        return out_insights

    out = {
        "total_responses": len(nps_rows),
        "distinct_phones": len(phones),
        "phones_with_any_order": len(order_months),
        "m0_total": sum(agg[("all", "all", s)][0] for s in SCORES),
        "m0_m3_promoter_pct": pct_m3(PROMOTER_SCORES),
        "m0_m3_detractor_pct": pct_m3(DETRACTOR_SCORES),
        "insights": build_insights(),
        "brands": ["all", "mcaffeine", "hyphen"],
        "brand_labels": BRAND_LABEL,
        "areas": ["all", "delivery", "cs", "product", "website"],
        "area_labels": AREA_LABEL,
        "scores": SCORES,
        "totals": {f"{b}|{a}|{s}": count for (b, a, s), count in totals.items()},
        "agg": {f"{b}|{a}|{s}": counts for (b, a, s), counts in agg.items()},
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
