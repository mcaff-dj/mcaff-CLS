#!/usr/bin/env python3
"""Generates product-kyc.html from the "Product feedback KYC" workbook.
Each product tab has its own bespoke question schema (no shared template), so products
are configured individually in productkyc_config.py rather than via a generic column map.

For "comparison" products (two SKUs surveyed head-to-head via a "which did you like more"
question), splits respondents into two groups and shows a side-by-side breakdown, matching
the workbook's own manually-built "Guava & Caramel Report" comparison-table style.
For "standalone" products, shows a single breakdown table.
"Common themes" per product = automated keyword-frequency counts + verbatim sample quotes
pulled directly from free-text columns (dislikes/improvements/remarks) - not synthesized.

Python port of Generate-ProductKYC.ps1.
"""
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from productkyc_config import PKYC_CATEGORY_LABELS, PKYC_PRODUCTS, PKYC_SPREADSHEET_ID
from report_context import h_enc

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
OUT_PATH = REPO_ROOT / "api" / "_reports" / "productkyc.html"

PKYC_STOPWORDS = {
    "the", "and", "for", "are", "was", "were", "this", "that", "with", "have", "has", "had", "not", "but", "you", "your",
    "they", "them", "their", "from", "when", "what", "who", "which", "these", "those", "because", "about", "into", "over",
    "under", "after", "before", "both", "more", "less", "most", "much", "many", "some", "all", "only", "out", "off", "again",
    "once", "been", "being", "than", "then", "also", "there", "here", "can", "could", "would", "should", "will", "did", "does",
    "she", "her", "him", "his", "our", "ours", "use", "used", "using", "one", "two", "get", "got", "felt", "feel", "really", "quite", "bit",
}


def cell(row, i):
    if row is None:
        return ""
    if isinstance(row, list):
        return row[i] if i < len(row) and row[i] is not None else ""
    return row if i == 0 else ""


def get_tokens(text):
    t = re.sub(r"[^a-z\s]", " ", str(text).lower())
    return [tok for tok in t.split() if len(tok) >= 3]


def get_top_keywords(texts, top_n=6):
    freq = {}
    for t in texts:
        if not t or not str(t).strip():
            continue
        for tok in get_tokens(t):
            if tok in PKYC_STOPWORDS:
                continue
            freq[tok] = freq.get(tok, 0) + 1
    top = sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
    return [{"word": w, "count": c} for w, c in top]


def get_sample_quotes(texts, n=2):
    seen = set()
    out = []
    for t in texts:
        tt = str(t).strip() if t else ""
        if len(tt) < 15 or tt in seen:
            continue
        seen.add(tt)
        out.append(tt)
        if len(out) >= n:
            break
    return out


def net_num(n):
    """Mimics .NET's default double.ToString(): round to 1 decimal and drop a
    trailing .0, matching how the PowerShell original's [math]::Round() output
    rendered when interpolated into a string (25.0 -> "25", 46.666 -> "46.7")."""
    r = round(n, 1)
    return str(int(r)) if r == int(r) else f"{r:.1f}"


def get_categorical_breakdown(rows, col_idx):
    tally = {}
    total = 0
    for r in rows:
        v = cell(r, col_idx)
        if not v or not str(v).strip():
            continue
        v = str(v).strip()
        tally[v] = tally.get(v, 0) + 1
        total += 1
    lst = sorted(tally.items(), key=lambda kv: kv[1], reverse=True)
    return {
        "list": [{"value": k, "count": c, "pct": round(c / total * 100, 1) if total > 0 else 0} for k, c in lst],
        "total": total,
    }


def split_compare_groups(rows, compare_cfg):
    group_a, group_b = [], []
    for r in rows:
        v = cell(r, compare_cfg["likeMoreCol"])
        if not v or not str(v).strip():
            continue
        v = str(v).strip()
        if v == compare_cfg["labelA"]:
            group_a.append(r)
        elif v == compare_cfg["labelB"]:
            group_b.append(r)
    return group_a, group_b


def build_compare_table(categorical_cfg, group_a, group_b, short_a, short_b):
    out = [f"<table class='pk-table'><thead><tr><th>Category</th><th>{h_enc(short_a)}</th><th>{h_enc(short_b)}</th></tr></thead><tbody>"]
    for f in categorical_cfg:
        bd_a = get_categorical_breakdown(group_a, f["c"])["list"][:2]
        bd_b = get_categorical_breakdown(group_b, f["c"])["list"][:2]
        cell_a = ", ".join(f"{h_enc(x['value'])} ({net_num(x['pct'])}%)" for x in bd_a) or "-"
        cell_b = ", ".join(f"{h_enc(x['value'])} ({net_num(x['pct'])}%)" for x in bd_b) or "-"
        out.append(f"<tr><td class='pk-rowlabel'>{h_enc(f['l'])}</td><td>{cell_a}</td><td>{cell_b}</td></tr>")
    out.append("</tbody></table>")
    return "".join(out)


def build_standalone_stats(categorical_cfg, rows):
    out = ["<table class='pk-table'><thead><tr><th>Category</th><th>Breakdown</th></tr></thead><tbody>"]
    for f in categorical_cfg:
        top = get_categorical_breakdown(rows, f["c"])["list"][:3]
        cell_str = ", ".join(f"{h_enc(x['value'])} ({net_num(x['pct'])}%)" for x in top) or "-"
        out.append(f"<tr><td class='pk-rowlabel'>{h_enc(f['l'])}</td><td>{cell_str}</td></tr>")
    out.append("</tbody></table>")
    return "".join(out)


def build_themes_block(free_text_cfg, rows):
    out = []
    for ft in free_text_cfg:
        texts = [cell(r, ft["c"]) for r in rows]
        kw = get_top_keywords(texts, 6)
        quotes = get_sample_quotes(texts, 2)
        if not kw and not quotes:
            continue
        out.append(f"<div class='pk-theme'><div class='pk-theme-label'>{h_enc(ft['l'])}</div>")
        if kw:
            kw_html = "".join(f"<span class='pk-kw'>{h_enc(k['word'])} &times;{k['count']}</span>" for k in kw)
            out.append(f"<div class='pk-kw-row'>{kw_html}</div>")
        for q in quotes:
            out.append(f"<p class='pk-quote'>&ldquo;{h_enc(q)}&rdquo;</p>")
        out.append("</div>")
    return "".join(out)


def build_product_card(p):
    print(f"  [{p['key']}] fetching '{p['tab']}'...")
    rows = lib.get_sheet_rows_chunked(PKYC_SPREADSHEET_ID, p["tab"], "AF")
    print(f"  [{p['key']}] fetched {len(rows)} rows")

    out = []
    if p["kind"] == "comparison":
        group_a, group_b = split_compare_groups(rows, p["compare"])
        title = f"{p['compare']['shortA']} vs {p['compare']['shortB']}"
        compare_table = build_compare_table(p["categorical"], group_a, group_b, p["compare"]["shortA"], p["compare"]["shortB"])
        all_rows = group_a + group_b
        themes = build_themes_block(p["freeText"], all_rows)
        out.append(f"<div class='pk-product'><h3>{h_enc(title)}</h3><p class='pk-meta'>{len(group_a):,} preferred "
                    f"{h_enc(p['compare']['shortA'])} &middot; {len(group_b):,} preferred {h_enc(p['compare']['shortB'])} "
                    f"&middot; {len(rows):,} total rows</p>")
        out.append(compare_table)
        if themes:
            out.append(f"<div class='pk-themes-title'>Common themes in constructive feedback</div>{themes}")
        out.append("</div>")
    else:
        stats_table = build_standalone_stats(p["categorical"], rows)
        themes = build_themes_block(p["freeText"], rows)
        out.append(f"<div class='pk-product'><h3>{h_enc(p['label'])}</h3><p class='pk-meta'>{len(rows):,} total rows</p>")
        out.append(stats_table)
        if themes:
            out.append(f"<div class='pk-themes-title'>Common themes in constructive feedback</div>{themes}")
        out.append("</div>")
    return "".join(out)


def main():
    print("Building Product Calling KYC report...")
    cards_by_category = {cat: [] for cat in PKYC_CATEGORY_LABELS}
    for p in PKYC_PRODUCTS:
        html = build_product_card(p)
        cards_by_category[p["category"]].append(html)

    now_str = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%d %b %Y, %H:%M") + " IST"

    tab_nav_html = []
    tab_panels_html = []
    first_cat = True
    for cat, label in PKYC_CATEGORY_LABELS.items():
        active_btn = " active" if first_cat else ""
        active_panel = " active" if first_cat else ""
        tab_nav_html.append(f'<button class="tab-btn{active_btn}" data-tab="{cat}">{h_enc(label)}</button>')
        cards_html = "".join(cards_by_category[cat])
        tab_panels_html.append(
            f'<div class="tab-panel{active_panel}" id="panel-{cat}"><span class=\'status-pill\'>Live</span>{cards_html}</div>'
        )
        first_cat = False

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Product Calling KYC</title>
<style>
  :root{{
    --page:#f9f9f7; --surface-card:#ffffff; --text-primary:#0b0b0b; --text-secondary:#52514e;
    --text-muted:#898781; --border:rgba(11,11,11,0.10); --grid:#e1e0d9;
    --pkyc:#c2740c;
  }}
  @media (prefers-color-scheme: dark){{
    :root{{
      --page:#0d0d0d; --surface-card:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7;
      --text-muted:#898781; --border:rgba(255,255,255,0.10); --grid:#2c2c2a;
      --pkyc:#e0993d;
    }}
  }}
  *{{box-sizing:border-box;}}
  body{{margin:0;min-height:100vh;background:var(--page);color:var(--text-primary);
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 20px;}}
  .wrap{{width:100%;max-width:1000px;margin:0 auto;}}
  .home-link{{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-size:13px;font-weight:600;
    color:var(--text-secondary);margin-bottom:20px;}}
  .home-link:hover{{color:var(--text-primary);}}
  header{{text-align:center;margin-bottom:24px;}}
  .badge{{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    color:var(--pkyc);background:color-mix(in srgb, var(--pkyc) 14%, transparent);border-radius:999px;padding:4px 12px;margin-bottom:14px;}}
  h1{{font-size:clamp(22px,4vw,28px);margin:0 0 12px;letter-spacing:-0.01em;}}
  header p{{margin:0;color:var(--text-secondary);font-size:14px;line-height:1.6;}}

  .tab-nav{{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px;border-bottom:1px solid var(--grid);padding-bottom:0;}}
  .tab-btn{{appearance:none;border:1px solid transparent;background:transparent;color:var(--text-secondary);
    font-size:13px;font-family:inherit;padding:9px 14px;border-radius:8px 8px 0 0;cursor:pointer;position:relative;top:1px;}}
  .tab-btn:hover{{color:var(--text-primary);background:var(--surface-card);}}
  .tab-btn.active{{color:var(--text-primary);font-weight:600;background:var(--surface-card);border:1px solid var(--grid);border-bottom:1px solid var(--surface-card);}}
  .tab-panel{{display:none;background:var(--surface-card);border:1px solid var(--border);border-radius:14px;padding:22px 24px;}}
  .tab-panel.active{{display:block;}}
  .status-pill{{display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
    color:#1a9c5c;background:rgba(26,156,92,.14);border-radius:999px;padding:2px 9px;margin-bottom:10px;}}

  .pk-product{{padding:16px 0;border-top:1px solid var(--grid);}}
  .pk-product:first-of-type{{border-top:none;padding-top:0;}}
  .pk-product h3{{font-size:14.5px;margin:0 0 4px;}}
  .pk-meta{{margin:0 0 12px;font-size:12px;color:var(--text-muted);}}
  .pk-table{{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:14px;}}
  .pk-table th{{background:var(--page);text-align:left;padding:7px 10px;border:1px solid var(--grid);font-weight:600;color:var(--text-secondary);}}
  .pk-table td{{padding:7px 10px;border:1px solid var(--grid);color:var(--text-secondary);vertical-align:top;}}
  .pk-rowlabel{{font-weight:600;color:var(--text-primary);white-space:nowrap;}}
  .pk-themes-title{{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);margin:10px 0 8px;}}
  .pk-theme{{margin-bottom:12px;}}
  .pk-theme-label{{font-size:12.5px;font-weight:600;margin-bottom:6px;}}
  .pk-kw-row{{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;}}
  .pk-kw{{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;background:color-mix(in srgb, var(--pkyc) 12%, transparent);color:var(--pkyc);font-weight:600;}}
  .pk-quote{{margin:0 0 4px;font-size:12.5px;color:var(--text-secondary);font-style:italic;padding-left:10px;border-left:2px solid var(--grid);}}
</style>
</head>
<body>
  <div class="wrap">
    <a class="home-link" href="/">&larr; Home</a>
    <header>
      <div><span class="badge">Auto-refreshed</span></div>
      <h1>Product Calling KYC</h1>
      <p>Built from the "Product feedback KYC" workbook &middot; last updated {now_str}.<br>Comparison tables are computed from response counts; feedback themes are keyword frequency + verbatim quotes pulled directly from free-text answers &mdash; not AI-written summaries.</p>
    </header>
    <nav class="tab-nav">{"".join(tab_nav_html)}</nav>
    {"".join(tab_panels_html)}
  </div>
  <script>
    document.querySelectorAll('.tab-btn').forEach(function(b){{
      b.addEventListener('click', function(){{
        document.querySelectorAll('.tab-btn').forEach(function(x){{ x.classList.remove('active'); }});
        document.querySelectorAll('.tab-panel').forEach(function(p){{ p.classList.remove('active'); }});
        b.classList.add('active');
        document.getElementById('panel-' + b.dataset.tab).classList.add('active');
      }});
    }});
    // Embedded in the dashboard iframe - the sidebar's mirrored Report Views list
    // already covers navigation, so hide this report's own tab row there. Leave it
    // visible on direct/standalone access, since that's the only nav available then.
    if (window.top !== window.self) {{
      var tn = document.querySelector('.tab-nav');
      if (tn) tn.style.display = 'none';
    }}
  </script>
</body>
</html>
"""

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(html, encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({round(OUT_PATH.stat().st_size / 1024)} KB)")


if __name__ == "__main__":
    main()
