"""Keyword-rule categorization of NPS Detractor free-text feedback
(nps_product.additional_feedback). See
docs/superpowers/specs/2026-09-17-nps-dip-reasons-design.md.

Multi-label: one feedback string can match more than one category, since real
feedback is rarely about exactly one thing. Case-insensitive substring match -
no regex compilation, no NLP library.
# ponytail: substring match will mis-fire on rare cross-category words (e.g.
# "small" also fits Quantity/Size); revisit with word-boundary regex if
# false-positives show up in real data.
"""

OTHER_CATEGORY = "Other/Unclear"

CATEGORY_KEYWORDS = {
    "Product Efficacy/Results": ["no result", "didn't work", "did not work", "no effect", "not effective", "no change"],
    "Fragrance": ["smell", "fragrance", "odour", "odor", "stink"],
    "Texture/Consistency": ["texture", "sticky", "greasy", "runny", "watery"],
    "Packaging/Leakage": ["leak", "packaging", "spill", "broken bottle", "cap", "pump"],
    "Skin Reaction/Suitability": ["irritation", "allergy", "breakout", "rash", "burning", "not suitable"],
    "Price/Value": ["expensive", "price", "costly", "value for money", "overpriced"],
    "Delivery/Logistics": ["late", "delay", "delivery", "courier", "damaged in transit", "wrong item"],
    "Quantity/Size": ["quantity", "size", "small", "less product", "short"],
    "Customer Service": ["customer care", "customer support", "no reply", "rude", "support team"],
}


def categorize(text):
    """Case-insensitive substring match against CATEGORY_KEYWORDS.
    Returns every category whose keyword list matches; [OTHER_CATEGORY] if
    none do. Never returns an empty list."""
    t = (text or "").lower()
    hits = [cat for cat, keywords in CATEGORY_KEYWORDS.items() if any(kw in t for kw in keywords)]
    return hits or [OTHER_CATEGORY]
