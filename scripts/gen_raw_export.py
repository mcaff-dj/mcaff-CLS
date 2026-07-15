"""Raw (ticket-level) CSV export, generated once per tab at report-build time and served
on demand via the gated /api/report/raw endpoint - NOT embedded in the report HTML, since
a tab's raw dump can run to 100k+ rows and would bloat the page for everyone just to serve
the rare download.

Deliberately a curated field subset, not every raw sheet column: only the fields already
named/normalized in brands.py's `col` dict (no PII - no ticket ID, chat link, image
attachments, or internal routing codes), confirmed with the user before building this.

Written gzip-compressed (.csv.gz): these ticket-level dumps are heavily repetitive
categorical data (product names, categories, month labels) and compress ~20-25x, which
keeps them out of Vercel's serverless function bundle-size limit and off the repo's daily
commit-size growth. raw.js serves them with Content-Encoding: gzip so the browser
decompresses transparently on download.
"""
import csv
import gzip
import io

RAW_CORE_FIELDS = [
    ("Created Date", "created_date"),
    ("Query Class", "cls"),
    ("Query Category", "cat"),
    ("Product Name", "prod"),
    ("SKU", "sku"),
    ("Batch Number", "batch"),
    ("Delivery Partner", "partner"),
    ("Month", "month"),
    ("Week", "week"),
    ("Total Sales (M)", "sales"),
    ("Unique/Duplicate", "uniq"),
]

RAW_TAB_EXTRA_FIELDS = {
    "warehouse": [("Warehouse Facility", "wh")],
    "technical": [("Platform", "platform")],
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

        fields = RAW_CORE_FIELDS + RAW_TAB_EXTRA_FIELDS.get(tab_key, [])
        path = out_dir / f"{ctx.b['brand']}_raw_{tab_key}.csv.gz"
        buf = io.StringIO()
        w = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writerow([label for label, _ in fields])
        for r in rows:
            w.writerow([ctx.cell(r, col[key]) for _, key in fields])
        csv_bytes = ("﻿" + buf.getvalue()).encode("utf-8")
        with gzip.GzipFile(path, "wb", mtime=0) as gz:
            gz.write(csv_bytes)
        print(f"[{ctx.b['brand']}] wrote raw export {path.name} ({len(rows)} rows, {path.stat().st_size} bytes gzipped)")


def raw_download_link(ctx, tab_key):
    return (f'<div class="raw-export-row"><a class="raw-export-btn" '
            f'href="/api/report/raw?card={ctx.b["brand"]}&amp;tab={tab_key}">'
            f'&#8681; Download Raw Data (CSV)</a></div>')
