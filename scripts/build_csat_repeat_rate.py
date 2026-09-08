"""Builds data/csat_repeat_rate.json - CSAT Repeat Rate analysis tab under Org Overview.

Same method as build_repeat_rate.py, sourced from CSAT tickets instead of NPS surveys:
for every ticket with a csat_rating (PEP_CLS.hyphen_tickets / PEP_CLS.mcaff_tickets, one
query per brand since the two live in separate tables), checks whether that phone also
placed a valid order (mcaff_prod.Item_level_data, Final_Status != 'CANCELLED') in the SAME
calendar month (M0), then in each of the next 12 months (M1..M12).

csat_rating is 1-5, not NPS's 0-10 - grouped Satisfied (4-5) / Neutral (3) / Dissatisfied (1-2).

Two data-quality landmines here, found by direct inspection rather than assumed:

- customer_phone in both ticket tables is 12-digit with a '91' country-code prefix
  (e.g. "919528341859"), while Item_level_data.Notification_Mobile is bare 10-digit. An
  exact-match IN() lookup without stripping that prefix matches almost nothing (caught by a
  first run coming back with 61 matched phones out of 67,695 - nps_delivery.customer_phone,
  by contrast, is already bare 10-digit, which is why build_repeat_rate.py never hit this).

- `category` is not a clean dimension by itself - it's a comma-joined path
  ("Neutral/calm, Requests & Enquiries, Estimated time of delivery, Resolved- ...": sentiment,
  then the real L1 category, then subcategory/resolution detail). Substring-matching a label
  like "Product" against the whole string false-positives on "Product Missing" under an
  unrelated L1 category like Warehouse. The real L1 category is reliably the 2nd comma
  segment - verified directly (SUBSTRING_INDEX(SUBSTRING_INDEX(category,',',2),',',-1)) against
  both tables before writing this: the 7 CATEGORY_LABELS below cover ~89% of rated tickets that
  way, with the rest (sentiment-only or malformed strings, e.g. "Happy/Satisfied" alone) as "other".

Usage: python scripts/build_csat_repeat_rate.py
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import mysql_lib

OUT_PATH = REPO_ROOT / "data/csat_repeat_rate.json"

# The ticket's real L1 category (2nd comma-segment of the `category` column - see module
# docstring). Fixed list, not re-derived per run, so a category doesn't silently reshuffle a
# saved filter selection between refreshes.
CATEGORY_LABELS = [
    "Technical",
    "Delivery",
    "Warehouse",
    "Packaging and Operational",
    "Product",
    "Product Suggestion/Recommendation",
    "Requests & Enquiries",
]
CATEGORY_KEY = {name: f"c{i}" for i, name in enumerate(CATEGORY_LABELS)}
CATEGORY_LABEL = {f"c{i}": name for i, name in enumerate(CATEGORY_LABELS)}
CATEGORY_LABEL["other"] = "Other"

BRAND_LABEL = {"all": "All brands", "mcaffeine": "Mcaffeine", "hyphen": "Hyphen"}
BRAND_TABLE = {"mcaffeine": "mcaff_tickets", "hyphen": "hyphen_tickets"}

RATINGS = [5, 4, 3, 2, 1]
HORIZON_MONTHS = 12  # M0..M12
SATISFIED_RATINGS = {4, 5}
DISSATISFIED_RATINGS = {1, 2}
BATCH = 800


def add_months(y, m, n):
    total = (y * 12 + (m - 1)) + n
    return total // 12, total % 12 + 1


def normalize_phone(raw):
    """91XXXXXXXXXX (ticket tables) -> XXXXXXXXXX (Item_level_data.Notification_Mobile's own
    format). Anything that isn't a clean 10 or 91+10 digit number is dropped rather than
    guessed at - a wrong match here would silently misattribute someone else's orders."""
    digits = "".join(ch for ch in (raw or "") if ch.isdigit())
    if len(digits) == 12 and digits.startswith("91"):
        return digits[2:]
    if len(digits) == 10:
        return digits
    return None


def category_bucket(raw):
    if not raw:
        return None
    parts = raw.split(",")
    if len(parts) < 2:
        return None
    l1 = parts[1].strip()
    return CATEGORY_KEY.get(l1)


def main():
    responses = []
    phones = set()
    total_rows = 0
    for brand_key, table in BRAND_TABLE.items():
        print(f"Pulling {table}...", file=sys.stderr)
        rows = mysql_lib.query(
            f"""
            SELECT csat_submitted_at, csat_rating, customer_phone, category
            FROM {table}
            WHERE csat_rating IS NOT NULL AND csat_submitted_at > '2026-01-01'
                  AND customer_phone IS NOT NULL AND customer_phone != ''
            """,
            database="PEP_CLS",
        )
        if rows is None:
            raise SystemExit("MYSQL_* credentials not configured - cannot build csat_repeat_rate.json")
        print(f"  {len(rows)} rated tickets", file=sys.stderr)
        total_rows += len(rows)
        for submitted_at, rating, raw_phone, category in rows:
            try:
                rating_i = int(rating)
            except (TypeError, ValueError):
                continue
            if rating_i < 1 or rating_i > 5:
                continue
            phone = normalize_phone(raw_phone)
            if not phone:
                continue
            cat_key = category_bucket(category)  # None (-> "other") for anything unrecognized
            responses.append({
                "phone": phone, "brand_key": brand_key, "rating": rating_i,
                "cat": cat_key, "ym": (submitted_at.year, submitted_at.month),
            })
            phones.add(phone)

    phones = sorted(phones)
    print(f"{len(phones)} distinct phones across both brands", file=sys.stderr)

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
    totals = defaultdict(int)
    for r in responses:
        brand_keys = {"all", r["brand_key"]}
        cat_keys = {"all"} | ({r["cat"]} if r["cat"] else {"other"})
        for bkey in brand_keys:
            for ckey in cat_keys:
                totals[(bkey, ckey, r["rating"])] += 1

        months = order_months.get(r["phone"])
        if not months:
            continue
        y0, m0 = r["ym"]
        if (y0, m0) not in months:
            continue
        for bkey in brand_keys:
            for ckey in cat_keys:
                agg[(bkey, ckey, r["rating"])][0] += 1
        for k in range(1, HORIZON_MONTHS + 1):
            yk, mk = add_months(y0, m0, k)
            if (yk, mk) in months:
                for bkey in brand_keys:
                    for ckey in cat_keys:
                        agg[(bkey, ckey, r["rating"])][k] += 1

    def pct_m3(ratings):
        m0 = sum(agg[("all", "all", s)][0] for s in ratings)
        m3 = sum(agg[("all", "all", s)][3] for s in ratings)
        return round(m3 / m0 * 100, 1) if m0 else None

    out = {
        "total_responses": total_rows,
        "distinct_phones": len(phones),
        "phones_with_any_order": len(order_months),
        "m0_total": sum(agg[("all", "all", s)][0] for s in RATINGS),
        "m0_m3_satisfied_pct": pct_m3(SATISFIED_RATINGS),
        "m0_m3_dissatisfied_pct": pct_m3(DISSATISFIED_RATINGS),
        "brands": ["all", "mcaffeine", "hyphen"],
        "brand_labels": BRAND_LABEL,
        "categories": ["all"] + [f"c{i}" for i in range(len(CATEGORY_LABELS))] + ["other"],
        "category_labels": CATEGORY_LABEL,
        "ratings": RATINGS,
        "totals": {f"{b}|{c}|{r}": count for (b, c, r), count in totals.items()},
        "agg": {f"{b}|{c}|{r}": counts for (b, c, r), counts in agg.items()},
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
