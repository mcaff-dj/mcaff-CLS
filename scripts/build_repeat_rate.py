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
DETRACTOR_SCORES = {0, 1, 2, 3, 4, 5, 6}
BATCH = 800
MAX_EXAMPLES = 40


def add_months(y, m, n):
    total = (y * 12 + (m - 1)) + n
    return total // 12, total % 12 + 1


def mask_phone(phone):
    return phone[:2] + "••••" + phone[-4:] if len(phone) >= 6 else phone


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
    examples = []
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
        hit_months = [(y0, m0)]
        for k in range(1, HORIZON_MONTHS + 1):
            yk, mk = add_months(y0, m0, k)
            if (yk, mk) in months:
                for bkey in brand_keys:
                    for akey in area_keys:
                        agg[(bkey, akey, r["score"])][k] += 1
                hit_months.append((yk, mk))
        if len(hit_months) >= 2 and len(examples) < MAX_EXAMPLES:
            examples.append({
                "phone": mask_phone(r["phone"]),
                "brand": r["brand"],
                "area": r["area"],
                "score": r["score"],
                "ym": f"{y0:04d}-{m0:02d}",
                "months": [f"{y:04d}-{m:02d}" for y, m in sorted(hit_months)],
            })

    def pct_m3(scores):
        m0 = sum(agg[("all", "all", s)][0] for s in scores)
        m3 = sum(agg[("all", "all", s)][3] for s in scores)
        return round(m3 / m0 * 100, 1) if m0 else None

    out = {
        "total_responses": len(nps_rows),
        "distinct_phones": len(phones),
        "phones_with_any_order": len(order_months),
        "m0_total": sum(agg[("all", "all", s)][0] for s in SCORES),
        "m0_m3_promoter_pct": pct_m3(PROMOTER_SCORES),
        "m0_m3_detractor_pct": pct_m3(DETRACTOR_SCORES),
        "brands": ["all", "mcaffeine", "hyphen"],
        "brand_labels": BRAND_LABEL,
        "areas": ["all", "delivery", "cs", "product", "website"],
        "area_labels": AREA_LABEL,
        "scores": SCORES,
        "totals": {f"{b}|{a}|{s}": count for (b, a, s), count in totals.items()},
        "agg": {f"{b}|{a}|{s}": counts for (b, a, s), counts in agg.items()},
        "examples": examples,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
