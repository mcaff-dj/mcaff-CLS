"""Raw (ticket-level) CSV export, generated once per tab at report-build time and served
on demand via the gated /api/report/raw endpoint - NOT embedded in the report HTML, since
a tab's raw dump can run to 100k+ rows and would bloat the page for everyone just to serve
the rare download.

Deliberately a curated field subset, not every raw sheet column: only the fields already
named/normalized in brands.py's `col` dict (no PII - no ticket ID, chat link, image
attachments, or internal routing codes), confirmed with the user before building this.

Written plain (uncompressed .csv), not gzipped: these go straight to S3 (never committed to
git, so commit-size doesn't apply), and raw.js serves them as attachment downloads - browsers
don't decode Content-Encoding for Content-Disposition: attachment (unlike the mcaffeine/hyphen
HTML reports, which are viewed, not saved, so the same gzip trick works fine there). A gzipped
attachment just downloads as opaque compressed bytes named ".csv".
"""
import csv
import io

from gen_geo_insights import _awb_geo_map, _awb_tokens

RAW_CORE_FIELDS = [
    ("Created Date", "created_date"),
    ("Order ID", "order_id"),
    ("Query Class", "cls"),
    ("Query Category", "cat"),
    ("Product Name", "prod"),
    ("SKU", "sku"),
    ("Batch Number", "batch"),
    ("Delivery Partner", "partner"),
    ("Month", "month"),
    ("Week", "week"),
    ("Source", "lastsource"),
]

RAW_TAB_EXTRA_FIELDS = {
    "warehouse": [("Warehouse Facility", "wh"), ("AWB Number", "awb")],
    "technical": [("Platform", "platform")],
}

# Delivery tab's export deviates enough from the shared RAW_CORE_FIELDS shape (drops
# Product Name/Batch Number - not relevant to a delivery ticket, renames Delivery Partner
# to Courier, adds AWB/City/State/Order Date/Order Month) that it gets its own full field
# list instead of layering onto RAW_CORE_FIELDS. City/State aren't sheet columns - they're
# resolved per-row below from the AWB via the same cached AWB->geo lookup gen_geo_insights
# already uses for the Delivery tab's city/state tables (_awb_geo_map).
RAW_TAB_FIELD_OVERRIDES = {
    "delivery": [
        ("Created Date", "created_date"),
        ("Order ID", "order_id"),
        ("Query Class", "cls"),
        ("Query Category", "cat"),
        ("Courier", "partner"),
        ("Month", "month"),
        ("Week", "week"),
        ("Source", "lastsource"),
        ("AWB", "awb"),
        ("City", "city"),
        ("State", "state"),
        ("Order Date", "order_date"),
        ("Order Month", "order_month"),
    ],
}

# tab id -> class-key filter (None = every row, e.g. Overview)
RAW_TAB_CLASS_FILTER = {
    "overview": None,
    "delivery": "Delivery",
    "warehouse": "Warehouse",
    "technical": "Technical",
    "packaging": "Packaging and Operational",
    "product": "Product",
    "suggestion": "Product Suggestion/Recommendation",
    "prodpkg": ("Packaging and Operational", "Product"),
}


def build_raw_exports(ctx, out_dir):
    col = ctx.col
    tab_keys = [c["id"] for c in ctx.b["classes"]] + ["overview", "prodpkg"]
    for tab_key in tab_keys:
        cls_filter = RAW_TAB_CLASS_FILTER.get(tab_key)
        if cls_filter is None:
            rows = ctx.data_rows
        elif isinstance(cls_filter, tuple):
            rows = [r for r in ctx.data_rows if ctx.cell(r, col["cls"]) in cls_filter]
        else:
            rows = [r for r in ctx.data_rows if ctx.cell(r, col["cls"]) == cls_filter]

        fields = RAW_TAB_FIELD_OVERRIDES.get(tab_key) or (RAW_CORE_FIELDS + RAW_TAB_EXTRA_FIELDS.get(tab_key, []))

        # City/State are resolved from the row's (first) AWB rather than a sheet column -
        # collected once per tab up front so _awb_geo_map makes at most one MySQL round-trip
        # for whatever AWBs aren't already cached, instead of one per row.
        row_geo = None
        if any(key in ("city", "state") for _, key in fields):
            first_awbs = [next(iter(_awb_tokens(ctx.cell(r, col["awb"]))), None) for r in rows]
            geo = _awb_geo_map(ctx, {a for a in first_awbs if a}) or {}
            row_geo = [geo.get(a) if a else None for a in first_awbs]

        path = out_dir / f"{ctx.b['brand']}_raw_{tab_key}.csv"
        buf = io.StringIO()
        w = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writerow([label for label, _ in fields])
        for i, r in enumerate(rows):
            vals = []
            for _, key in fields:
                if key == "city":
                    vals.append(row_geo[i][0] if row_geo[i] else "")
                elif key == "state":
                    vals.append(row_geo[i][1] if row_geo[i] else "")
                else:
                    vals.append(ctx.cell(r, col[key]))
            w.writerow(vals)
        csv_bytes = ("﻿" + buf.getvalue()).encode("utf-8")
        path.write_bytes(csv_bytes)
        print(f"[{ctx.b['brand']}] wrote raw export {path.name} ({len(rows)} rows, {path.stat().st_size} bytes)")


def raw_download_link(ctx, tab_key):
    return (f'<div class="raw-export-row"><a class="raw-export-btn" '
            f'href="/api/report/raw?card={ctx.b["brand"]}&amp;tab={tab_key}">'
            f'&#8681; Download Raw Data (CSV)</a></div>')
