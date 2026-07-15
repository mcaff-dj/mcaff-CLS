"""Per-brand configuration for the report generator. Python port of brands.ps1.
Column indices are 0-based positions in each sheet's row arrays.
"""

BRANDS = [
    {
        "brand": "mcaffeine",
        "title": "mCaffeine",
        "spreadsheet_id": "1fjrwKgi26q3kxsLsFrXP0KY0uAJNfcpTeHBQhCXwkPA",
        "sheet_name": "mCaffeine",
        "last_col": "AG",
        "out_file": "api/_reports/mcaffeine.html",
        "months": ["01_Jan'25", "02_Feb'25", "03_Mar'25", "04_Apr'25", "07_Jul'25", "08_Aug'25",
                   "09_Sep'25", "10_Oct'25", "11_Nov'25", "12_Dec'25", "1_Jan'26", "2_Feb'26",
                   "3_Mar'26", "4_Apr'26", "5_May'26", "6_Jun'26", "7_Jul'26"],
        # Older KYC raw-dump sheet: same 21-column schema but with Last Source Type/Parent
        # Order swapped (cols 2 & 3) vs the primary sheet, and no columns beyond U. Only its
        # months not already covered by the primary sheet are pulled in, to avoid double
        # counting May/Jun/Jul '26 which both sheets report on independently.
        "secondary": {
            "spreadsheet_id": "1msLi85ITDTg4v09Wa8eIWDhhwj6LTU8T0dqqDsmi7Hs",
            "sheet_name": "mCaffeine",
            "last_col": "U",
            "swap_cols": (2, 3),
            "exclude_months": ["05_May'26", "06_Jun'26", "07_Jul'26"],
        },
        "classes": [
            {"key": "Delivery", "id": "delivery", "label": "Delivery", "color": "var(--s1)"},
            {"key": "Warehouse", "id": "warehouse", "label": "Warehouse", "color": "var(--s2)"},
            {"key": "Technical", "id": "technical", "label": "Technical", "color": "var(--s3)"},
            {"key": "Packaging and Operational", "id": "packaging", "label": "Packaging & Operational", "color": "var(--s4)"},
            {"key": "Product", "id": "product", "label": "Product", "color": "var(--s5)"},
            {"key": "Product Suggestion/Recommendation", "id": "suggestion", "label": "Product Suggestion", "color": "var(--s6)"},
        ],
        "col": {"prod": 6, "batch": 7, "sku": 8, "cls": 4, "cat": 5, "partner": 10, "month": 12, "week": 13,
                "sales": 19, "salesW": 20, "alloc": 23, "uniq": 17, "created_date": 1,
                "wh": 21, "lastsource": 3, "platform": 32, "visdamage": 30, "outerpkg": 29, "statezone": 28},
        "small_tabs": {"mom": "MoM", "prodnps": "MCF:PRODUCT NPS", "agent": "AGENT", "ai": "AI"},
    },
    {
        "brand": "hyphen",
        "title": "Hyphen",
        "spreadsheet_id": "11RM238fAcqZxLKF1zzrUB0fPTQgDO2kwfkzcQSoYjBg",
        "sheet_name": "Hyphen",
        "last_col": "AO",
        "out_file": "api/_reports/hyphen.html",
        "months": ["08_Aug'25", "09_Sep'25", "10_Oct'25", "11_Nov'25", "12_Dec'25", "1_Jan'26",
                   "2_Feb'26", "3_Mar'26", "4_Apr'26", "5_May'26", "6_Jun'26", "7_Jul'26"],
        "classes": [
            {"key": "Delivery", "id": "delivery", "label": "Delivery", "color": "var(--s1)"},
            {"key": "Warehouse", "id": "warehouse", "label": "Warehouse", "color": "var(--s2)"},
            {"key": "Technical", "id": "technical", "label": "Technical", "color": "var(--s3)"},
            {"key": "Packaging and Operational", "id": "packaging", "label": "Packaging & Operational", "color": "var(--s4)"},
            {"key": "Product", "id": "product", "label": "Product", "color": "var(--s5)"},
        ],
        "col": {"prod": 6, "batch": 7, "sku": 8, "cls": 4, "cat": 5, "partner": 10, "month": 12, "week": 13,
                "sales": 19, "salesW": 20, "alloc": 23, "uniq": 17, "created_date": 1,
                "wh": 22, "lastsource": 3, "platform": 40, "visdamage": 33, "outerpkg": 32, "statezone": 34},
        "small_tabs": {"mom": "Hyp: MoM", "prodnps": "HYP:PRODUCT NPS", "agent": "Hyp Agent Chart", "ai": "HYP AI Chart"},
    },
]
