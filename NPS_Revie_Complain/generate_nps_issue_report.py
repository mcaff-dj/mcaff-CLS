#!/usr/bin/env python3
"""Daily Product-wise Issue vs NPS report.

Pulls CLS complaint tickets from PEP_CLS.CLS_KYC_mCaff / CLS_KYC_Hyphen whose
query_class is "Product" or "Packaging and Operational" - the two classes the
NPS review/complaint work cares about - groups them by product, and maps each
product onto its PEP_CLS.nps_product NPS numbers (overall score, packaging
score, detractor rate).

Matching caveat: the two systems name products differently (ticket "DOUBLE
SHOT FACE SERUM - 50ML" vs NPS "DOUBLE SHOT RADIANCE-LIFT SERUM"), so product
names are normalized (lowercased, size/volume stripped, punctuation stripped)
before joining, and only ~1/3 of complaint volume matches by name alone. Rather
than hide that gap, unmatched products are written out too (unmatched_products.csv)
so the coverage gap stays visible run over run instead of silently improving or
regressing.

Outputs (all under this NPS_Revie_Complain/ folder, overwritten each run):
  product_issue_vs_nps.csv   - matched products: complaint counts + NPS numbers
  unmatched_products.csv     - complaint volume that couldn't be matched to nps_product
  report.html                - self-contained dashboard of the above
  run_meta.json               - last-run timestamp + coverage stats, for monitoring
"""
import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
import mysql_lib  # noqa: E402  (needs the sys.path.insert above)

KYC_DATABASE = "PEP_CLS"
# Same brand labels nps_product itself uses (its `brand` column), so a future
# join on brand rather than product name lines up without relabeling.
KYC_TABLE_BRANDS = {"CLS_KYC_mCaff": "Mcaffeine", "CLS_KYC_Hyphen": "Hyphen"}
ISSUE_CLASSES = ("Product", "Packaging and Operational")

CSV_OUT = HERE / "product_issue_vs_nps.csv"
UNMATCHED_OUT = HERE / "unmatched_products.csv"
HTML_OUT = HERE / "report.html"
META_OUT = HERE / "run_meta.json"

# Products with fewer NPS responses than this are flagged in the dashboard as
# low-confidence rather than trusted at face value alongside high-volume ones.
LOW_SAMPLE_THRESHOLD = 50

_SIZE_RE = re.compile(r"\d+\.?\d*\s*(ml|g|gm|gms|kg|l)\b")
_NONALNUM_RE = re.compile(r"[^a-z0-9]+")
_WS_RE = re.compile(r"\s+")


def normalize_product_name(name):
    """lower-cases, drops anything after a '|', strips size/volume tokens and
    punctuation, and collapses whitespace, so e.g. 'Summer Breeze Perfume Body
    Lotion - 300ml' and 'Summer Breeze Perfume Body Lotion' both become the
    same key."""
    s = (name or "").lower().split("|", 1)[0]
    s = _SIZE_RE.sub(" ", s)
    s = _NONALNUM_RE.sub(" ", s)
    return _WS_RE.sub(" ", s).strip()


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_issue_rows():
    """(brand, query_class, query_category, product_name, sku) for every
    Product/Packaging complaint ticket across both brands, or None if MYSQL_*
    creds aren't set."""
    placeholders = ", ".join(["%s"] * len(ISSUE_CLASSES))
    rows = []
    for table, brand in KYC_TABLE_BRANDS.items():
        result = mysql_lib.query(
            f"SELECT query_class, query_category, product_name, sku FROM `{table}` "
            f"WHERE query_class IN ({placeholders}) "
            f"AND product_name IS NOT NULL AND TRIM(product_name) NOT IN ('', 'NA')",
            params=ISSUE_CLASSES,
            database=KYC_DATABASE,
        )
        if result is None:
            return None
        rows.extend((brand, query_class, query_category, product_name, sku)
                    for query_class, query_category, product_name, sku in result)
    return rows


def fetch_nps_rows():
    """(product_name, overall_nps_score, packaging, product_nps, nps_category)
    for every nps_product response with a real product name."""
    return mysql_lib.query(
        "SELECT product_name, overall_nps_score, packaging, product_nps, nps_category "
        "FROM nps_product "
        "WHERE product_name IS NOT NULL AND TRIM(product_name) NOT IN ('', 'NA')",
        database=KYC_DATABASE,
    )


def aggregate_issues(rows):
    agg = {}
    for brand, query_class, _query_category, product_name, sku in rows:
        norm = normalize_product_name(product_name)
        if not norm:
            continue
        bucket = agg.setdefault(norm, {
            "issue_count": 0, "product_issues": 0, "packaging_issues": 0,
            "brands": {}, "skus": {},
        })
        bucket["issue_count"] += 1
        if query_class == "Product":
            bucket["product_issues"] += 1
        elif query_class == "Packaging and Operational":
            bucket["packaging_issues"] += 1
        bucket["brands"][brand] = bucket["brands"].get(brand, 0) + 1
        sku_clean = (sku or "").strip()
        if sku_clean and sku_clean.upper() != "NA":
            bucket["skus"][sku_clean] = bucket["skus"].get(sku_clean, 0) + 1
    return agg


def _top_key(counter):
    """Most frequent key in a {value: count} counter, or None if empty."""
    return max(counter.items(), key=lambda kv: kv[1])[0] if counter else None


def _brand_label(counter):
    """Usually one brand per normalized name; on the rare collision, list both
    with the dominant one first rather than silently picking one."""
    if not counter:
        return None
    return " / ".join(k for k, _ in sorted(counter.items(), key=lambda kv: kv[1], reverse=True))


def aggregate_nps(rows):
    agg = {}
    for product_name, overall_nps_score, packaging, product_nps, nps_category in rows:
        norm = normalize_product_name(product_name)
        if not norm:
            continue
        bucket = agg.setdefault(norm, {
            "nps_responses": 0,
            "overall_sum": 0.0, "overall_n": 0,
            "packaging_sum": 0.0, "packaging_n": 0,
            "product_nps_sum": 0.0, "product_nps_n": 0,
            "promoters": 0, "passives": 0, "detractors": 0,
        })
        bucket["nps_responses"] += 1
        v = _to_float(overall_nps_score)
        if v is not None:
            bucket["overall_sum"] += v
            bucket["overall_n"] += 1
        v = _to_float(packaging)
        if v is not None:
            bucket["packaging_sum"] += v
            bucket["packaging_n"] += 1
        v = _to_float(product_nps)
        if v is not None:
            bucket["product_nps_sum"] += v
            bucket["product_nps_n"] += 1
        if nps_category == "Promoter":
            bucket["promoters"] += 1
        elif nps_category == "Passive":
            bucket["passives"] += 1
        elif nps_category == "Detractor":
            bucket["detractors"] += 1
    return agg


def _avg(total, n):
    return round(total / n, 2) if n else None


def build_combined(issue_agg, nps_agg):
    matched, unmatched = [], []
    for norm, issue in issue_agg.items():
        base = {
            "product": norm,
            "brand": _brand_label(issue["brands"]) or "",
            "sku_code": _top_key(issue["skus"]) or "",
            "sku_variant_count": len(issue["skus"]),
            "issue_count": issue["issue_count"],
            "product_issues": issue["product_issues"],
            "packaging_issues": issue["packaging_issues"],
        }
        nps = nps_agg.get(norm)
        if nps is None:
            unmatched.append(base)
            continue
        matched.append({
            **base,
            "nps_responses": nps["nps_responses"],
            "avg_overall_nps": _avg(nps["overall_sum"], nps["overall_n"]),
            "avg_packaging_score": _avg(nps["packaging_sum"], nps["packaging_n"]),
            "avg_product_nps": _avg(nps["product_nps_sum"], nps["product_nps_n"]),
            "promoters": nps["promoters"],
            "passives": nps["passives"],
            "detractors": nps["detractors"],
            "detractor_rate_pct": round(nps["detractors"] / nps["nps_responses"] * 100, 1) if nps["nps_responses"] else None,
        })
    matched.sort(key=lambda r: r["issue_count"], reverse=True)
    unmatched.sort(key=lambda r: r["issue_count"], reverse=True)
    return matched, unmatched


MATCHED_FIELDS = [
    "product", "brand", "sku_code", "sku_variant_count", "issue_count", "product_issues", "packaging_issues",
    "nps_responses", "avg_overall_nps", "avg_packaging_score", "avg_product_nps",
    "promoters", "passives", "detractors", "detractor_rate_pct",
]
UNMATCHED_FIELDS = ["product", "brand", "sku_code", "sku_variant_count", "issue_count", "product_issues", "packaging_issues"]


def write_csv(path, fields, rows):
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def h_enc(s):
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def risk_badge(row):
    """good/warning/critical classification for the dashboard - never color
    alone, always paired with the label per the dataviz skill's status-palette
    rule, since low-sample products would otherwise look identical to
    well-evidenced ones."""
    if row["nps_responses"] < LOW_SAMPLE_THRESHOLD:
        return "low-sample", "Low sample"
    rate = row["detractor_rate_pct"] or 0
    if rate >= 25 or (row["avg_overall_nps"] or 10) < 7:
        return "critical", "High risk"
    if rate >= 15:
        return "warning", "Watch"
    return "good", "Healthy"


def render_html(matched, unmatched, meta):
    total_issue_rows = meta["total_issue_rows"]
    matched_issue_rows = sum(r["issue_count"] for r in matched)
    coverage_pct = round(matched_issue_rows / total_issue_rows * 100, 1) if total_issue_rows else 0
    high_risk = [r for r in matched if risk_badge(r)[0] == "critical"]

    def stat_tile(label, value, sub):
        return f"""
        <div class="stat-tile">
          <div class="stat-label">{h_enc(label)}</div>
          <div class="stat-value">{h_enc(value)}</div>
          <div class="stat-sub">{h_enc(sub)}</div>
        </div>"""

    stats_html = "".join([
        stat_tile("Complaint rows analyzed", f"{total_issue_rows:,}", "Product + Packaging tickets, both brands"),
        stat_tile("Distinct products complained about", f"{len(matched) + len(unmatched):,}", "Normalized product names"),
        stat_tile("Matched to NPS data", f"{coverage_pct}%", f"{matched_issue_rows:,} of {total_issue_rows:,} complaint rows"),
        stat_tile("High-risk products", f"{len(high_risk)}", "Detractor rate ≥25% or avg NPS <7"),
    ])

    def sku_cell(r):
        if not r["sku_code"]:
            return "–"
        extra = f" (+{r['sku_variant_count'] - 1} more)" if r["sku_variant_count"] > 1 else ""
        return h_enc(r["sku_code"]) + h_enc(extra)

    def row_html(r):
        cls, label = risk_badge(r)
        overall = r["avg_overall_nps"] if r["avg_overall_nps"] is not None else "–"
        packaging = r["avg_packaging_score"] if r["avg_packaging_score"] is not None else "–"
        rate = f"{r['detractor_rate_pct']}%" if r["detractor_rate_pct"] is not None else "–"
        return f"""
        <tr data-brand="{h_enc(r['brand'])}">
          <td class="col-product">{h_enc(r['product'])}</td>
          <td class="col-brand">{h_enc(r['brand'] or '–')}</td>
          <td class="col-sku">{sku_cell(r)}</td>
          <td data-sort="{r['issue_count']}">{r['issue_count']:,}</td>
          <td data-sort="{r['product_issues']}">{r['product_issues']:,}</td>
          <td data-sort="{r['packaging_issues']}">{r['packaging_issues']:,}</td>
          <td data-sort="{r['nps_responses']}">{r['nps_responses']:,}</td>
          <td data-sort="{r['avg_overall_nps'] or 0}">{overall}</td>
          <td data-sort="{r['avg_packaging_score'] or 0}">{packaging}</td>
          <td data-sort="{r['detractor_rate_pct'] or 0}">{rate}</td>
          <td><span class="risk-pill risk-{cls}">{h_enc(label)}</span></td>
        </tr>"""

    rows_html = "".join(row_html(r) for r in matched)

    brands_present = sorted({r["brand"] for r in (matched + unmatched) if r["brand"]})

    def unmatched_row_html(r):
        return f"""<tr data-brand="{h_enc(r['brand'])}">
          <td class="col-product">{h_enc(r['product'])}</td>
          <td class="col-brand">{h_enc(r['brand'] or '–')}</td>
          <td class="col-sku">{sku_cell(r)}</td>
          <td data-sort="{r['issue_count']}">{r['issue_count']:,}</td>
        </tr>"""

    unmatched_html = "".join(unmatched_row_html(r) for r in unmatched[:40])

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Product-wise Issue vs NPS</title>
<style>
  :root{{
    --page:#f9f9f7; --surface-card:#ffffff; --text-primary:#0b0b0b; --text-secondary:#52514e;
    --text-muted:#898781; --border:rgba(11,11,11,0.10); --grid:#e1e0d9;
    --accent:#c2740c;
    --good:#0ca30c; --warning:#fab219; --critical:#d03b3b;
  }}
  @media (prefers-color-scheme: dark){{
    :root{{
      --page:#0d0d0d; --surface-card:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7;
      --text-muted:#898781; --border:rgba(255,255,255,0.10); --grid:#2c2c2a;
      --accent:#e0993d;
      --good:#0ca30c; --warning:#fab219; --critical:#e66767;
    }}
  }}
  *{{box-sizing:border-box;}}
  body{{margin:0;min-height:100vh;background:var(--page);color:var(--text-primary);
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 20px;}}
  .wrap{{width:100%;max-width:1180px;margin:0 auto;}}
  header{{text-align:center;margin-bottom:24px;}}
  .badge{{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    color:var(--accent);background:color-mix(in srgb, var(--accent) 14%, transparent);border-radius:999px;padding:4px 12px;margin-bottom:14px;}}
  h1{{font-size:clamp(22px,4vw,28px);margin:0 0 12px;letter-spacing:-0.01em;}}
  header p{{margin:0;color:var(--text-secondary);font-size:14px;line-height:1.6;}}

  .stat-row{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px;}}
  @media (max-width:760px){{.stat-row{{grid-template-columns:repeat(2,1fr);}}}}
  .stat-tile{{background:var(--surface-card);border:1px solid var(--border);border-radius:14px;padding:16px 18px;}}
  .stat-label{{font-size:11.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px;}}
  .stat-value{{font-size:26px;font-weight:700;letter-spacing:-0.01em;font-variant-numeric:proportional-nums;}}
  .stat-sub{{font-size:12px;color:var(--text-secondary);margin-top:4px;}}

  .panel{{background:var(--surface-card);border:1px solid var(--border);border-radius:14px;padding:20px 22px;margin-bottom:20px;}}
  .panel h2{{font-size:15px;margin:0 0 4px;}}
  .panel .hint{{font-size:12.5px;color:var(--text-secondary);margin:0 0 14px;}}

  .toolbar{{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center;}}
  .search{{flex:1;max-width:320px;padding:8px 12px;border-radius:8px;border:1px solid var(--grid);
    background:var(--page);color:var(--text-primary);font-size:13px;font-family:inherit;}}
  .brand-filter{{display:flex;gap:6px;}}
  .brand-btn{{appearance:none;border:1px solid var(--grid);background:var(--page);color:var(--text-secondary);
    font-size:12.5px;font-family:inherit;padding:7px 12px;border-radius:8px;cursor:pointer;}}
  .brand-btn:hover{{color:var(--text-primary);}}
  .brand-btn.active{{color:#fff;background:var(--accent);border-color:var(--accent);font-weight:600;}}
  .col-brand{{white-space:nowrap;}}
  .col-sku{{white-space:nowrap;font-variant-numeric:tabular-nums;}}

  table{{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;}}
  thead th{{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--text-muted);
    border-bottom:1px solid var(--grid);padding:8px 10px;cursor:pointer;user-select:none;white-space:nowrap;}}
  thead th:hover{{color:var(--text-primary);}}
  tbody td{{padding:9px 10px;border-bottom:1px solid var(--grid);}}
  tbody tr:last-child td{{border-bottom:none;}}
  .col-product{{max-width:340px;}}
  tbody td, thead th{{text-align:right;}}
  td.col-product, td.col-brand, td.col-sku, thead th[data-type="text"]{{text-align:left;}}

  .risk-pill{{display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
    border-radius:999px;padding:2px 9px;}}
  .risk-good{{color:var(--good);background:color-mix(in srgb, var(--good) 14%, transparent);}}
  .risk-warning{{color:var(--warning);background:color-mix(in srgb, var(--warning) 20%, transparent);}}
  .risk-critical{{color:var(--critical);background:color-mix(in srgb, var(--critical) 16%, transparent);}}
  .risk-low-sample{{color:var(--text-muted);background:color-mix(in srgb, var(--text-muted) 14%, transparent);}}

  .table-scroll{{overflow-x:auto;}}
  footer{{text-align:center;color:var(--text-muted);font-size:12px;margin-top:24px;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="badge">NPS Review &amp; Complaint</span>
    <h1>Product-wise Issue vs NPS</h1>
    <p>Complaint tickets (query class: Product / Packaging and Operational) from CLS_KYC_mCaff + CLS_KYC_Hyphen,
       mapped onto nps_product. Generated {h_enc(meta['generated_at'])}.</p>
  </header>

  <div class="stat-row">{stats_html}</div>

  <div class="panel">
    <h2>Products with complaints, matched to NPS</h2>
    <p class="hint">Sorted by complaint volume. Click a column header to re-sort. {len(unmatched)} product name(s)
      ({total_issue_rows - matched_issue_rows:,} complaint rows) could not be matched to nps_product by name and are
      listed below the table instead of being silently dropped.</p>
    <div class="toolbar">
      <input class="search" id="search" type="text" placeholder="Filter by product name...">
      <div class="brand-filter" id="brand-filter">
        <button class="brand-btn active" data-brand="all" type="button">All brands</button>
        {"".join(f'<button class="brand-btn" data-brand="{h_enc(b)}" type="button">{h_enc(b)}</button>' for b in brands_present)}
      </div>
    </div>
    <div class="table-scroll">
    <table id="main-table">
      <thead><tr>
        <th data-type="text">Product</th>
        <th data-type="text">Brand</th>
        <th data-type="text">SKU</th>
        <th data-type="num">Complaints</th>
        <th data-type="num">Product issues</th>
        <th data-type="num">Packaging issues</th>
        <th data-type="num">NPS responses</th>
        <th data-type="num">Avg NPS</th>
        <th data-type="num">Avg packaging score</th>
        <th data-type="num">Detractor %</th>
        <th data-type="text">Status</th>
      </tr></thead>
      <tbody>{rows_html}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>Unmatched product names (top {min(40, len(unmatched))} by complaint volume)</h2>
    <p class="hint">These didn't resolve to an nps_product entry after name normalization - usually because the
      ticket's product name and the NPS survey's product name diverge (e.g. an ingredient-led ticket name vs a
      marketing name). Needs a manual SKU-level mapping to close.</p>
    <div class="table-scroll">
    <table id="unmatched-table">
      <thead><tr>
        <th data-type="text">Product</th>
        <th data-type="text">Brand</th>
        <th data-type="text">SKU</th>
        <th data-type="num">Complaints</th>
      </tr></thead>
      <tbody>{unmatched_html}</tbody>
    </table>
    </div>
  </div>

  <footer>Regenerated daily at 3:00 AM IST by generate_nps_issue_report.py</footer>
</div>
<script>
(function() {{
  function wireSort(table) {{
    var tbody = table.tBodies[0];
    var headers = table.tHead.rows[0].cells;
    Array.prototype.forEach.call(headers, function(th, idx) {{
      var dir = 1;
      th.addEventListener('click', function() {{
        var rows = Array.prototype.slice.call(tbody.rows);
        var type = th.getAttribute('data-type');
        rows.sort(function(a, b) {{
          var av = a.cells[idx], bv = b.cells[idx];
          if (type === 'num') {{
            var an = parseFloat(av.getAttribute('data-sort') || av.textContent) || 0;
            var bn = parseFloat(bv.getAttribute('data-sort') || bv.textContent) || 0;
            return (an - bn) * dir;
          }}
          return av.textContent.localeCompare(bv.textContent) * dir;
        }});
        rows.forEach(function(r) {{ tbody.appendChild(r); }});
        dir *= -1;
      }});
    }});
  }}
  wireSort(document.getElementById('main-table'));
  wireSort(document.getElementById('unmatched-table'));

  var mainBody = document.getElementById('main-table').tBodies[0];
  var unmatchedBody = document.getElementById('unmatched-table').tBodies[0];
  var search = document.getElementById('search');
  var brandFilter = document.getElementById('brand-filter');
  var activeBrand = 'all';

  function applyFilters() {{
    var q = search.value.trim().toLowerCase();
    Array.prototype.forEach.call(mainBody.rows, function(r) {{
      var name = r.cells[0].textContent.toLowerCase();
      var brandOk = activeBrand === 'all' || r.getAttribute('data-brand').indexOf(activeBrand) !== -1;
      r.style.display = (name.indexOf(q) === -1 || !brandOk) ? 'none' : '';
    }});
    Array.prototype.forEach.call(unmatchedBody.rows, function(r) {{
      var brandOk = activeBrand === 'all' || r.getAttribute('data-brand').indexOf(activeBrand) !== -1;
      r.style.display = brandOk ? '' : 'none';
    }});
  }}

  search.addEventListener('input', applyFilters);
  brandFilter.addEventListener('click', function(e) {{
    var btn = e.target.closest('.brand-btn');
    if (!btn) return;
    Array.prototype.forEach.call(brandFilter.querySelectorAll('.brand-btn'), function(b) {{
      b.classList.toggle('active', b === btn);
    }});
    activeBrand = btn.getAttribute('data-brand');
    applyFilters();
  }});
}})();
</script>
</body>
</html>"""


def main():
    issue_rows = fetch_issue_rows()
    if issue_rows is None:
        print("MYSQL_* credentials not configured - cannot generate the report.", file=sys.stderr)
        sys.exit(1)
    nps_rows = fetch_nps_rows()
    if nps_rows is None:
        print("MYSQL_* credentials not configured - cannot generate the report.", file=sys.stderr)
        sys.exit(1)

    issue_agg = aggregate_issues(issue_rows)
    nps_agg = aggregate_nps(nps_rows)
    matched, unmatched = build_combined(issue_agg, nps_agg)

    write_csv(CSV_OUT, MATCHED_FIELDS, matched)
    write_csv(UNMATCHED_OUT, UNMATCHED_FIELDS, unmatched)

    generated_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    meta = {
        "generated_at": generated_at,
        "total_issue_rows": len(issue_rows),
        "matched_products": len(matched),
        "unmatched_products": len(unmatched),
        "matched_issue_rows": sum(r["issue_count"] for r in matched),
        "unmatched_issue_rows": sum(r["issue_count"] for r in unmatched),
    }
    META_OUT.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    HTML_OUT.write_text(render_html(matched, unmatched, meta), encoding="utf-8")

    print(f"Wrote {CSV_OUT.name} ({len(matched)} products), {UNMATCHED_OUT.name} ({len(unmatched)} products), "
          f"{HTML_OUT.name}, {META_OUT.name}.")
    print(f"Coverage: {meta['matched_issue_rows']:,}/{meta['total_issue_rows']:,} complaint rows matched to NPS data.")


if __name__ == "__main__":
    main()
