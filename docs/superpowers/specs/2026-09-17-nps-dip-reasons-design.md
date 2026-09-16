# NPS Dip Reasons — design

## Problem

The Product wise NPS heatmap (`scripts/gen_panels.py`'s `_build_prodwise_heatmap`)
shows *that* a product's NPS% dropped month over month, but not *why*. The
`nps_product` MySQL table carries a free-text `additional_feedback` field per
survey response that nobody currently reads at report-generation time. This
feature mines that text (and reuses the response's own `nps_category`) to
surface *why* NPS dipped, per product per month, right next to the heatmap
that already flags *when*.

## Goals

- For every product-month where NPS% fell versus the prior month, show the
  top reason categories behind that dip, with example verbatim quotes.
- Zero new external dependencies or secrets (no LLM call) — everything runs
  at report-generation time, same as the rest of `gen_panels.py`.

## Non-goals

- Perfect per-product attribution of feedback (see Known limitation below).
- Sentiment/reason classification for Promoters or Passives — only
  Detractors' feedback is mined, since they're the ones pulling NPS down.
- Trend/forecast of *future* dips — this is descriptive, not predictive.

## Data source

`nps_product` (external MySQL table, `PEP_CLS` database, same table the
existing heatmap already queries via `nps_source.fetch_product_wise_nps`):

- One row per `(response_id, product_slot)` — a respondent can rate up to 4
  products in one survey.
- `additional_feedback` (TEXT) and `nps_category` (Promoter/Passive/Detractor)
  are **response-level**, constant across every slot of a given
  `response_id` (confirmed in `nps_source.py`'s own module docstring and
  relied on by `api/_lib/db.js`'s `claimOneProductDetractorLead`).
- `product_name` is **slot-level** — this is what lets us group feedback by
  product at all, despite the feedback text itself being response-level.

### New query: `fetch_product_dip_feedback(mysql_brand)`

Added to `scripts/nps_source.py`, sibling to `fetch_product_wise_nps`. One
query, not one per dip (avoids N+1):

```sql
SELECT product_name,
       DATE_FORMAT(STR_TO_DATE(submitted_date, '%d/%m/%Y'), '%Y-%m') AS ym,
       additional_feedback
FROM nps_product
WHERE brand = %s AND nps_category = 'Detractor'
  AND product_name IS NOT NULL AND TRIM(product_name) NOT IN ('', 'NA')
  AND additional_feedback IS NOT NULL AND TRIM(additional_feedback) != ''
  AND STR_TO_DATE(submitted_date, '%d/%m/%Y') >= '2026-04-01'
ORDER BY product_name, ym
```

Returns `{product_name: {ym: [feedback_text, ...]}}` — same nesting shape as
`fetch_product_wise_nps`'s `months` dict, so the two are easy to zip together
by `(product, ym)` in `gen_panels.py`.

## Category taxonomy

New module `scripts/nps_feedback_categorizer.py`. Keyword-rule based,
**multi-label** (one feedback can match more than one category — real
feedback is rarely about exactly one thing) plus a catch-all so nothing is
force-fit into the wrong bucket:

| Category | Example keywords |
|---|---|
| Product Efficacy/Results | "no result", "didn't work", "no effect", "not effective", "no change" |
| Fragrance | "smell", "fragrance", "odour", "odor", "stink" |
| Texture/Consistency | "texture", "sticky", "greasy", "runny", "thick", "watery" |
| Packaging/Leakage | "leak", "packaging", "spill", "broken bottle", "cap", "pump" |
| Skin Reaction/Suitability | "irritation", "allergy", "breakout", "rash", "burning", "not suitable" |
| Price/Value | "expensive", "price", "costly", "value for money", "overpriced" |
| Delivery/Logistics | "late", "delay", "delivery", "courier", "damaged in transit", "wrong item" |
| Quantity/Size | "quantity", "size", "small", "less product", "short" |
| Customer Service | "support", "customer care", "response", "no reply", "rude" |
| Other/Unclear | (fallback — no keyword rule matched) |

```python
def categorize(text: str) -> list[str]:
    """Case-insensitive substring match against CATEGORY_KEYWORDS.
    Returns every category whose keyword list matches; ["Other/Unclear"]
    if none do. Never returns an empty list."""
```

Plain `dict[str, list[str]]` + substring checks — no regex compilation, no
NLP library. `# ponytail: substring match will mis-fire on rare cross-category
words (e.g. "small" also fits Quantity); revisit with word-boundary regex if
false-positives show up in real data.`

## Dip detection

No new computation — reuses `_build_prodwise_heatmap`'s already-computed
per-product `months` dict (`nps_pct` per `ym`). A product-month is a "dip" if
it has a chronologically preceding month with data and
`nps_pct[ym] < nps_pct[prev_ym]`.

## Interaction: click-to-expand row (revised — supersedes the original separate-panel plan)

Prototyped as a live-data artifact preview and approved by the user. No
separate "NPS Dip Reasons" table. Instead, every
product row in the *existing* heatmap (`_build_prodwise_heatmap`) becomes
expandable in place:

- Each `td.rowlabel` gets a chevron (`▶`, rotates to `▼` when open) and
  `cursor:pointer` — added only for products that have at least one flagged
  dip in the visible range; products with no dip stay plain, non-interactive
  rows.
- Clicking the row toggles a sibling `<tr class="dip-detail" hidden>` inserted
  immediately after it, `colspan`-ing the full table width. One `<tr>` +
  small vanilla-JS click handler (event delegation on the `<tbody>`, matching
  the report's existing self-contained inline-`<script>`-per-panel pattern) —
  no framework, no per-row listeners.
- The expanded content is a small inner table, one row per **dip month for
  that product only** (not every product's dips in one global list), sorted
  Δ ascending (biggest drop first):

  | Month | NPS (prev → current) | Δ | Responses | Top reasons | Example feedback |
  |---|---|---|---|---|---|
  | Jul '26 | 51.1 → 48.1 | −3.0 | 240 | Fragrance — 46% | "smell changed…" (title-attr, full quote on hover) |

  - **Responses**: that month's real total response count — already computed
    by the heatmap (`m["responses"]`), just surfaced again inline. Not new
    data.
  - **Top reasons**: category-name + `mentions / that month's Detractor count
    × 100`, top 2 by count, sorted desc.
  - **Example feedback**: 1 shortest quote from the top category,
    HTML-escaped (`h_enc`), truncated (~80 chars), full quote in a `title`
    attribute — same pattern the heatmap's own cells already use.
- **Low-sample guard**: dip months with fewer than 5 Detractor responses show
  "Not enough feedback (n<5)" instead of reasons — a 1-response blip
  shouldn't read as a trend, same spirit as the existing
  `LOW_SAMPLE_THRESHOLD` guard in `NPS_Revie_Complain/generate_nps_issue_report.py`.
- Products with zero flagged dips in the visible range get no chevron and no
  detail row — nothing to expand.

A `<p class="desc">` under the heatmap's title states the known limitation
below, so it isn't hidden.

## Known limitation

`additional_feedback` is per-survey-**response**, not per-product-**slot**.
If a respondent rated two products in one survey, both products' rows in
this panel would show the *same* feedback text, even if the text only
actually concerns one of the two. This is the same kind of disclosed gap
`NPS_Revie_Complain/generate_nps_issue_report.py` already accepts for its own
product-name matching, rather than silently hiding it — stated in the panel's
description text, not fixed (fixing it would require the survey itself to
collect feedback per product-slot, which is out of scope here).

## Testing

One `scripts/test_nps_feedback_categorizer.py` (plain `assert`-based, no
framework, matching repo convention) covering:
- A feedback string matching one category.
- A feedback string matching multiple categories (multi-label).
- A feedback string matching none (`Other/Unclear`).
- Empty string doesn't crash (`Other/Unclear`).

Dip detection and the low-sample guard get an inline `assert` (`__main__`
self-check) in `gen_panels.py`'s new function, per the "lazy code needs its
check" rule — not a separate test file for logic this small.
