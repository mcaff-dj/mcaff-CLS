"""Product Calling KYC config: per-product-tab column mapping for the "Product feedback KYC"
workbook. Column indices are 0-based. Schemas differ per tab (no shared template), so each
product is configured individually rather than via a generic brand-style column map.

Python port of productkyc-config.ps1.
"""

PKYC_SPREADSHEET_ID = "1OL_Trll9xJjtS4VaknU6zS3GYxcYdq-9dHvRe8a2JrY"

PKYC_PRODUCTS = [
    # ---------------- Body Wash ----------------
    {
        "key": "guava_caramel", "category": "bodywash", "kind": "comparison", "tab": "GT & CC Body Wash",
        "categorical": [
            {"l": "Occupation", "c": 5}, {"l": "Age Group", "c": 6}, {"l": "Gender", "c": 7},
            {"l": "Skin Type", "c": 8}, {"l": "Repurchase Likelihood", "c": 18},
        ],
        "compare": {"likeMoreCol": 12, "likeLessCol": 14, "labelA": "Guava Tini De-Tan Body Wash",
                    "labelB": "Exfoliating Caramel Crunch Body Wash", "shortA": "Guava Tini", "shortB": "Caramel Crunch"},
        "freeText": [{"l": "Why liked it less", "c": 15}, {"l": "Improvements wanted", "c": 17}, {"l": "Remarks", "c": 24}],
    },
    {
        "key": "raspberry_wash", "category": "bodywash", "kind": "standalone",
        "tab": "Brightening Raspberry Rush Body Wash", "label": "Brightening Raspberry Rush Body Wash",
        "categorical": [
            {"l": "Gender", "c": 10}, {"l": "Age Group", "c": 11}, {"l": "Skin Type", "c": 12},
            {"l": "Experience Rating (1-5)", "c": 15}, {"l": "Packaging Rating (1-5)", "c": 19},
            {"l": "Would Purchase Again", "c": 22},
        ],
        "freeText": [{"l": "Rating reason", "c": 16}, {"l": "Packaging dislike reason", "c": 20}, {"l": "Remarks", "c": 23}],
    },

    # ---------------- Lotions ----------------
    {
        "key": "lotion_compare", "category": "lotions", "kind": "comparison", "tab": "Perfume Body Lotion",
        "categorical": [
            {"l": "Age Group", "c": 9}, {"l": "Gender", "c": 10}, {"l": "Skin Type", "c": 11},
            {"l": "Repurchase Likelihood", "c": 19},
        ],
        "compare": {"likeMoreCol": 13, "likeLessCol": 15, "labelA": "Summer Breeze Perfume Body Lotion",
                    "labelB": "Sweet Escape Perfume Body Lotion", "shortA": "Summer Breeze", "shortB": "Sweet Escape"},
        "freeText": [{"l": "Why liked it less", "c": 16}, {"l": "One thing to change", "c": 18}, {"l": "Remarks", "c": 27}],
    },
    {
        "key": "magnesium_lotion", "category": "lotions", "kind": "standalone",
        "tab": "Magnesium Body Lotion", "label": "Magnesium Body Lotion",
        "categorical": [
            {"l": "Occupation", "c": 10}, {"l": "Age Group", "c": 11}, {"l": "Gender", "c": 12},
            {"l": "Skin Type", "c": 13}, {"l": "Repurchase Likelihood", "c": 21},
        ],
        "freeText": [{"l": "Likes / dislikes", "c": 14}, {"l": "Improvements wanted", "c": 23}, {"l": "Remarks", "c": 24}],
    },

    # ---------------- Lip Balms ----------------
    {
        "key": "balm", "category": "lipbalms", "kind": "standalone", "tab": "Balm", "label": "Balm",
        "categorical": [
            {"l": "Gender", "c": 17}, {"l": "Preferred Format", "c": 11}, {"l": "Would Try Chapstick Format", "c": 14},
        ],
        "freeText": [{"l": "Dislikes / improvements", "c": 13}, {"l": "Other suggestions", "c": 15}],
    },
    {
        "key": "jelly_glaze", "category": "lipbalms", "kind": "standalone",
        "tab": "Jelly Glaze Lip Balm", "label": "Jelly Glaze Lip Balm",
        "categorical": [
            {"l": "Occupation", "c": 6}, {"l": "Age Group", "c": 7}, {"l": "Gender", "c": 8},
            {"l": "Skin Type", "c": 9}, {"l": "Would Recommend", "c": 19},
        ],
        "freeText": [{"l": "Likes / dislikes", "c": 10}, {"l": "Improvements wanted", "c": 22}, {"l": "Remarks", "c": 25}],
    },

    # ---------------- Scrubs ----------------
    {
        "key": "cookie_scrub", "category": "scrubs", "kind": "standalone",
        "tab": "Cookie Face scrub", "label": "Cookie Face Scrub",
        "categorical": [{"l": "Would Recommend", "c": 20}],
        "freeText": [{"l": "Fragrance / texture / packaging feedback", "c": 9}, {"l": "Improvements wanted", "c": 22},
                     {"l": "Remarks", "c": 24}],
    },
]

PKYC_CATEGORY_LABELS = {
    "bodywash": "Body Wash", "lotions": "Lotions", "lipbalms": "Lip Balms", "scrubs": "Scrubs",
}
