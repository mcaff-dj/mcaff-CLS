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
                "wh": 21, "prosales": 22, "lastsource": 3, "platform": 32, "visdamage": 30, "outerpkg": 29, "statezone": 28,
                "order_id": 2, "awb": 9},
        "small_tabs": {"agent": "AGENT", "ai": "AI"},
        # Read only to patch Jan'26/Feb'26 onto the MySQL-sourced NPS charts, and only on runs
        # that actually re-query NPS - see generate_report.py's NPS_SHEET_OVERRIDE_MONTHS. Kept
        # separate from small_tabs (which is CSAT-only and follows the --quick cache) because
        # these two follow the NPS cache instead.
        "nps_override_tabs": {"mom": "MoM", "prodnps": "MCF:PRODUCT NPS"},
        # NPS - Overall / NPS - Product now come from mcaff_dwh.nps_delivery /
        # mcaff_dwh.nps_product (see nps_source.py) instead of the "MoM" / "MCF:PRODUCT NPS"
        # sheet tabs - this is that MySQL data's own `brand` column value (verified via
        # SELECT DISTINCT brand: exactly "Mcaffeine" / "Hyphen", not "mcaffeine").
        "nps_mysql_brand": "Mcaffeine",
        # RTO-Conversion tab: monthly RTO vs. punched/delivered/conversion figures, lives in
        # this same spreadsheet's "Sales per month" tab (not the ticket-row sheet above).
        "rto_conv_range": "AN:AT",
        # Settled-month ticket rows (everything but the current, still-moving month) come
        # from this table instead of a live Sheets pull - see scripts/kyc_source.py. It's a
        # column-for-column mirror (in this exact order) of the primary sheet's own columns
        # A:Z, verified against the live "mCaffeine" tab header - the sheet has more trailing
        # columns (State_zone/Outer_package/visible_damage/CPR/platform) this table doesn't
        # carry, which is fine: ctx.cell() already returns "" past a row's actual length.
        "kyc_mysql_table": "CLS_KYC_mCaff",
        "kyc_mysql_columns": [
            "created_date", "parent_order", "last_source_type", "ticket_no", "query_class", "query_category",
            "product_name", "batch_number", "sku", "awb_number", "delivery_partner_name", "order_date",
            "month", "week", "order_month", "order_week", "year", "unique_flag", "order_year",
            "total_sales_m", "total_sales_w", "wh_name", "pro_sales", "partner_allocation", "wh_allocation",
            "log_partner",
        ],
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
                "wh": 22, "prosales": 21, "lastsource": 3, "platform": 40, "visdamage": 33, "outerpkg": 32, "statezone": 34,
                "order_id": 2, "awb": 9},
        "small_tabs": {"agent": "Hyp Agent Chart", "ai": "HYP AI Chart"},
        "nps_override_tabs": {"mom": "Hyp: MoM", "prodnps": "HYP:PRODUCT NPS"},
        "nps_mysql_brand": "Hyphen",
        # RTO-Conversion tab: monthly RTO vs. punched/delivered/conversion figures, lives in
        # this same spreadsheet's "Sales per month" tab (not the ticket-row sheet above).
        "rto_conv_range": "AS:AY",
        # See the matching mcaffeine comment above - verified against the live "Hyphen" tab
        # header (columns A:AO), same exact order.
        "kyc_mysql_table": "CLS_KYC_Hyphen",
        "kyc_mysql_columns": [
            "ticket_no", "created_date", "parent_order", "last_source_type", "query_class", "query_category",
            "product_name", "batch_number", "sku", "awb_number", "delivery_partner_name", "order_date",
            "month", "week", "order_month", "order_week", "year", "unique_flag", "order_year",
            "total_sales_m", "total_sales_w", "pro_sales", "wh_name", "partner_allocation", "wh_allocation",
            "log_partner", "product_link", "edd", "age", "gender", "skin_type", "first_time_regular",
            "outer_packaging", "visible_damage", "state_zone", "cpr", "reason_of_purchase", "am_pm",
            "usage_times", "sequence_of_usage", "platform",
        ],
    },
]
