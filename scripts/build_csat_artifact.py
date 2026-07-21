import json

DATA_PATH = r"mcaff-CLS/data/csat_dashboard_data.json"
OUT_PATH = r"C:\Users\VIKASH PATHAK\AppData\Local\Temp\claude\c--Users-VIKASH-PATHAK-Desktop-Service-account\16b80c7f-e823-4d15-be9d-cfcc291e6052\scratchpad\csat_dashboard.html"
REPORT_OUT_PATH = r"mcaff-CLS/api/_reports/npsdeepdive.html"

with open(DATA_PATH, "r", encoding="utf-8") as f:
    D = json.load(f)

def n(x):
    return f"{int(round(x)):,}"

def avg(x):
    return f"{x:.2f}"

k = D["kpis"]
weakest = D["weakest"]
ai_worse = D["ai_worse"]
ai_better = D["ai_better_or_tied"]
declines = D["declines"]
tv = D["top_volume_compare"]

w0, w1, w2, w3 = weakest[0], weakest[1], weakest[2], weakest[3]
weakest_html = (
    f"<b>{w0['task']}</b> is the single weakest category by volume — avg {avg(w0['mean'])} across {n(w0['count'])} completed CSATs, "
    f"well below the {avg(k['overall_avg'])} overall average. "
    f"<b>{w2['task']}</b> ({avg(w2['mean'])}, n={n(w2['count'])}), <b>{w3['task']}</b> ({avg(w3['mean'])}, n={n(w3['count'])}) "
    f"round out the lowest-rated categories with meaningful sample size."
)

a0, a1, a2, a3 = ai_worse[0], ai_worse[1], ai_worse[2], ai_worse[3]
ai_worse_html = (
    "<b>AI trails Human by roughly a point or more on categories that need judgment or account correction</b> — "
    f"{a0['task']} (AI {avg(a0['mean_AI'])}/n={n(a0['count_AI'])} vs Human {avg(a0['mean_Human'])}/n={n(a0['count_Human'])}), "
    f"{a1['task']} (AI {avg(a1['mean_AI'])}/n={n(a1['count_AI'])} vs Human {avg(a1['mean_Human'])}/n={n(a1['count_Human'])}), "
    f"{a2['task']} (AI {avg(a2['mean_AI'])}/n={n(a2['count_AI'])} vs Human {avg(a2['mean_Human'])}/n={n(a2['count_Human'])}) and "
    f"{a3['task']} (AI {avg(a3['mean_AI'])}/n={n(a3['count_AI'])} vs Human {avg(a3['mean_Human'])}/n={n(a3['count_Human'])}) "
    "all show a wide gap with enough volume on both sides that this isn't noise. These are exactly the categories where "
    "a wrong automated answer — a refund status, a dispatch claim, a delivery mark — is verifiably wrong to the customer."
)

b0, b1 = ai_better[0], ai_better[1]
tv_pct = round(100 * tv['n'] / k['total'], 1)
ai_tied_html = (
    f"<b>On the single largest category, {tv['task']}</b> (n={n(tv['n'])}, {tv_pct}% of all responses), "
    f"AI ({avg(tv['ai_avg'])}) is essentially level with Human ({avg(tv['human_avg'])}) — "
    "a pure status lookup is where AI performs closest to parity. AI also leads Human on "
    f"'{b1['task']}' ({avg(b1['mean_AI'])} vs {avg(b1['mean_Human'])}, n={n(b1['count_AI'])} AI). "
    "The AI shortfall looks concentrated in categories needing account changes or judgment calls, not simple lookups."
)

d0, d1, d2 = declines[0], declines[1], declines[2]
decline_html = (
    f"<b>{d0['task']}</b> for AI-resolved tickets fell from {avg(d0['first_v'])} (n={n(d0['first_n'])}) in {d0['first_m']} "
    f"to {avg(d0['last_v'])} (n={n(d0['last_n'])}) in {d0['last_m']} — a {avg(d0['drop'])}-point drop on comparable volume. "
    f"<b>{d1['task']}</b> shows a similar slide ({avg(d1['first_v'])} &rarr; {avg(d1['last_v'])}, drop {avg(d1['drop'])}), "
    f"as does <b>{d2['task']}</b> ({avg(d2['first_v'])} &rarr; {avg(d2['last_v'])}). Worth investigating what changed in these AI flows over the period."
)

coverage_html = (
    f"The heatmap below covers the top 20 of {D['n_tasks_total']} distinct task categories "
    f"({D['task_coverage_pct']}% of all completed CSAT volume); the remainder are grouped into <b>Other</b>. "
    f"'(none)' means no task was tagged on the ticket."
)

GRANULAR_JSON = json.dumps(D["granular"], ensure_ascii=False, separators=(",", ":"))
WORDS_JSON = json.dumps(D["words_by_filter"], ensure_ascii=False, separators=(",", ":"))
MONTH_ORDER_JSON = json.dumps(D["month_order"], ensure_ascii=False)

brands = k["brands"]
hyphen = brands.get("Hyphen", {})
mcaff = brands.get("mCaffeine", {})
channels = k["channels"]
chat = channels.get("chat", {})
email = channels.get("email", {})

html = f"""<title>CSAT Deep Dive — Hyphen &amp; mCaffeine (Mar&ndash;Jul 2026)</title>
<style>
  .viz-root {{
    --surface-1:      #fcfcfb;
    --page-plane:     #f9f9f7;
    --text-primary:   #0b0b0b;
    --text-secondary: #52514e;
    --text-muted:     #898781;
    --gridline:       #e1e0d9;
    --border:         rgba(11,11,11,0.10);

    --rating-1:       #e34948;
    --rating-3:       #898781;
    --rating-5:       #2a78d6;

    --brand-hyphen:   #6b4bc7;
    --brand-mcaff:    #d98c1f;
    --resolver-ai:    #2a78d6;
    --resolver-human: #1baf7a;

    --seq-300: #6da7ec; --seq-400: #3987e5; --seq-500: #256abf; --seq-600: #184f95; --seq-700: #0d366b;

    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--text-primary);
    background: var(--page-plane);
  }}
  @media (prefers-color-scheme: dark) {{
    .viz-root {{
      --surface-1:      #1a1a19;
      --page-plane:     #0d0d0d;
      --text-primary:   #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted:     #898781;
      --gridline:       #2c2c2a;
      --border:         rgba(255,255,255,0.10);
      --rating-1:       #e66767;
      --rating-3:       #898781;
      --rating-5:       #3987e5;
      --brand-hyphen:   #9a7fe0;
      --brand-mcaff:    #eba845;
      --resolver-ai:    #3987e5;
      --resolver-human: #199e70;
      --seq-300: #1c5cab; --seq-400: #3987e5; --seq-500: #5598e7; --seq-600: #86b6ef; --seq-700: #cde2fb;
    }}
  }}
  :root[data-theme="dark"] .viz-root {{
    --surface-1: #1a1a19; --page-plane: #0d0d0d; --text-primary: #ffffff;
    --text-secondary: #c3c2b7; --text-muted: #898781; --gridline: #2c2c2a; --border: rgba(255,255,255,0.10);
    --rating-1: #e66767; --rating-3: #898781; --rating-5: #3987e5;
    --brand-hyphen: #9a7fe0; --brand-mcaff: #eba845; --resolver-ai: #3987e5; --resolver-human: #199e70;
    --seq-300: #1c5cab; --seq-400: #3987e5; --seq-500: #5598e7; --seq-600: #86b6ef; --seq-700: #cde2fb;
  }}
  :root[data-theme="light"] .viz-root {{
    --surface-1: #fcfcfb; --page-plane: #f9f9f7; --text-primary: #0b0b0b;
    --text-secondary: #52514e; --text-muted: #898781; --gridline: #e1e0d9; --border: rgba(11,11,11,0.10);
    --rating-1: #e34948; --rating-3: #898781; --rating-5: #2a78d6;
    --brand-hyphen: #6b4bc7; --brand-mcaff: #d98c1f; --resolver-ai: #2a78d6; --resolver-human: #1baf7a;
    --seq-300: #6da7ec; --seq-400: #3987e5; --seq-500: #256abf; --seq-600: #184f95; --seq-700: #0d366b;
  }}

  * {{ box-sizing: border-box; }}
  body {{ margin: 0; }}
  .viz-root {{ min-height: 100vh; padding: 32px 20px 64px; }}
  .wrap {{ max-width: 1060px; margin: 0 auto; }}

  h1 {{ font-size: 22px; font-weight: 650; margin: 0 0 4px; text-wrap: balance; }}
  .sub {{ color: var(--text-secondary); font-size: 14px; margin: 0 0 4px; }}
  .sub b {{ color: var(--text-primary); font-weight: 650; }}
  .sub-brands {{ color: var(--text-muted); font-size: 12.5px; margin: 0 0 20px; }}
  .chip {{ display:inline-flex; align-items:center; gap:5px; font-weight:600; }}
  .chip::before {{ content:""; width:8px; height:8px; border-radius:50%; display:inline-block; }}
  .chip.hyphen::before {{ background: var(--brand-hyphen); }}
  .chip.mcaff::before {{ background: var(--brand-mcaff); }}

  .kpi-row {{ display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 24px; }}
  .kpi {{ background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 14px 12px; }}
  .kpi .kpi-label {{ font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 650; margin-bottom: 6px; }}
  .kpi .kpi-value {{ font-size: 21px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }}
  .kpi .kpi-sub {{ font-size: 11px; color: var(--text-secondary); margin-top: 3px; font-variant-numeric: tabular-nums; }}

  .filterbar {{
    display: flex; gap: 20px; flex-wrap: wrap; align-items: center;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 16px; margin-bottom: 24px; font-size: 13px;
  }}
  .filterbar label {{ color: var(--text-secondary); margin-right: 6px; }}
  .filterbar select {{
    font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--page-plane); color: var(--text-primary);
  }}
  .filter-group {{ display: flex; align-items: center; }}

  .card {{
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;
    padding: 24px 24px 20px; margin-bottom: 24px;
  }}
  .card h2 {{ font-size: 15px; font-weight: 650; margin: 0 0 2px; }}
  .card .card-sub {{ font-size: 12.5px; color: var(--text-secondary); margin: 0 0 18px; }}
  .card-controls {{ display: flex; gap: 16px; align-items: center; font-size: 12.5px; margin-bottom: 14px; }}
  .card-controls select {{ font: inherit; font-size: 12.5px; padding: 4px 7px; border-radius: 6px; border: 1px solid var(--border); background: var(--page-plane); color: var(--text-primary); }}

  .heatmap-scroll {{ overflow-x: auto; }}
  table.heatmap {{ border-collapse: collapse; font-size: 12.5px; min-width: 100%; }}
  table.heatmap th, table.heatmap td {{ padding: 7px 10px; text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }}
  table.heatmap th {{ color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid var(--gridline); }}
  table.heatmap td.rowlabel, table.heatmap th.corner {{ text-align: left; position: sticky; left: 0; background: var(--surface-1); }}
  table.heatmap td.rowlabel {{ color: var(--text-primary); font-weight: 550; border-right: 1px solid var(--gridline); max-width: 220px; overflow: hidden; text-overflow: ellipsis; }}
  table.heatmap td.cell {{ border-radius: 4px; }}
  table.heatmap td.cell.empty {{ color: var(--text-muted); }}
  table.heatmap tr + tr td, table.heatmap tr + tr th {{ border-top: 1px solid var(--gridline); }}

  .legend {{ display: flex; gap: 18px; flex-wrap: wrap; margin: 4px 0 18px; font-size: 12.5px; color: var(--text-secondary); }}
  .legend-item {{ display: flex; align-items: center; gap: 6px; }}
  .legend-swatch {{ width: 12px; height: 12px; border-radius: 3px; display: inline-block; }}

  .tooltip {{
    position: fixed; pointer-events: none; z-index: 50;
    background: var(--text-primary); color: var(--surface-1);
    font-size: 12px; padding: 6px 10px; border-radius: 6px;
    opacity: 0; transition: opacity 0.1s ease; white-space: nowrap;
    transform: translate(-50%, -100%);
  }}
  .tooltip.show {{ opacity: 1; }}

  table.data-table {{ width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }}
  table.data-table th, table.data-table td {{ text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--gridline); font-variant-numeric: tabular-nums; }}
  table.data-table th {{ color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }}
  table.data-table td.num, table.data-table th.num {{ text-align: right; }}
  details.table-toggle {{ margin-top: 10px; }}
  details.table-toggle summary {{ cursor: pointer; font-size: 12.5px; color: var(--text-secondary); user-select: none; }}

  #cloud {{ position: relative; width: 100%; height: 420px; }}
  #cloud span {{ position: absolute; white-space: nowrap; font-weight: 650; line-height: 1; user-select: none; transition: opacity 0.15s; }}
  #cloud span:hover {{ opacity: 0.7; }}

  .footnote {{ font-size: 11.5px; color: var(--text-muted); margin-top: 14px; }}

  .findings-list {{ margin: 0 0 4px; padding-left: 20px; }}
  .findings-list li {{ font-size: 13.5px; line-height: 1.55; color: var(--text-primary); margin-bottom: 12px; }}
  .findings-list li b {{ font-weight: 650; }}

  @media (max-width: 760px) {{
    .kpi-row {{ grid-template-columns: repeat(2, 1fr); }}
  }}
</style>

<div class="viz-root">
  <div class="wrap">
    <h1>CSAT Deep Dive — Task Category, Resolver &amp; Comment Themes</h1>
    <p class="sub">{n(k['total'])} completed CSAT responses &middot; {k['date_min']} &ndash; {k['date_max']} &middot; overall avg rating <b>{avg(k['overall_avg'])}</b> / 5</p>
    <p class="sub-brands">
      <span class="chip hyphen">Hyphen</span> {n(hyphen.get('n',0))} responses, avg {avg(hyphen.get('avg',0))} &nbsp;&middot;&nbsp;
      <span class="chip mcaff">mCaffeine</span> {n(mcaff.get('n',0))} responses, avg {avg(mcaff.get('avg',0))} &nbsp;&middot;&nbsp;
      AI-resolved avg {avg(k['ai_avg'])} (n={n(k['ai_n'])}) &nbsp;vs&nbsp; Human-resolved avg {avg(k['human_avg'])} (n={n(k['human_n'])}) &nbsp;&middot;&nbsp;
      Chat avg {avg(chat.get('avg',0))} (n={n(chat.get('n',0))}) &nbsp;vs&nbsp; Email avg {avg(email.get('avg',0))} (n={n(email.get('n',0))})
    </p>

    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Total responses</div><div class="kpi-value">{n(k['total'])}</div><div class="kpi-sub">closed tickets</div></div>
      <div class="kpi"><div class="kpi-label">Overall avg rating</div><div class="kpi-value">{avg(k['overall_avg'])}</div><div class="kpi-sub">out of 5</div></div>
      <div class="kpi"><div class="kpi-label">AI-resolved avg</div><div class="kpi-value">{avg(k['ai_avg'])}</div><div class="kpi-sub">n={n(k['ai_n'])}</div></div>
      <div class="kpi"><div class="kpi-label">Human-resolved avg</div><div class="kpi-value">{avg(k['human_avg'])}</div><div class="kpi-sub">n={n(k['human_n'])}</div></div>
      <div class="kpi"><div class="kpi-label">Promoters (4&ndash;5)</div><div class="kpi-value">{k['promoters_pct']}%</div><div class="kpi-sub">of all responses</div></div>
      <div class="kpi"><div class="kpi-label">Detractors (1&ndash;2)</div><div class="kpi-value">{k['detractors_pct']}%</div><div class="kpi-sub">of all responses</div></div>
    </div>

    <div class="filterbar">
      <div class="filter-group">
        <label for="f-brand">Brand</label>
        <select id="f-brand">
          <option value="All">All</option>
          <option value="Hyphen">Hyphen</option>
          <option value="mCaffeine">mCaffeine</option>
        </select>
      </div>
      <div class="filter-group">
        <label for="f-resolver">Resolver</label>
        <select id="f-resolver">
          <option value="All">All (compare AI vs Human)</option>
          <option value="AI">AI CSAT only</option>
          <option value="Human">Human CSAT only</option>
        </select>
      </div>
      <div class="filter-group">
        <label for="f-channel">Channel</label>
        <select id="f-channel">
          <option value="All">All</option>
          <option value="chat">Chat</option>
          <option value="email">Email</option>
        </select>
      </div>
      <div class="filter-group" style="color:var(--text-muted); font-size:12px;">Applies to the heatmap below</div>
    </div>

    <div class="card">
      <h2>Average CSAT rating, month on month</h2>
      <p class="card-sub">Task category &times; month, sorted by overall avg rating &mdash; blank cells = no completed CSAT that month. Hover a cell for n.</p>
      <div class="heatmap-scroll">
        <table class="heatmap" id="heatmap-table">
          <thead><tr id="heatmap-head"></tr></thead>
          <tbody id="heatmap-body"></tbody>
        </table>
      </div>
      <p class="footnote">{coverage_html}</p>
    </div>

    <div class="card">
      <h2>Task category patterns</h2>
      <p class="card-sub">Findings below are computed directly from the CSAT-completed data (Hyphen + mCaffeine, all resolvers unless noted) &mdash; not from the filters above.</p>
      <ul class="findings-list">
        <li>{weakest_html}</li>
        <li>{ai_worse_html}</li>
        <li>{ai_tied_html}</li>
        <li>{decline_html}</li>
      </ul>
      <p class="footnote">All AI-vs-Human comparisons use a minimum sample size of n&ge;30 per side to avoid drawing conclusions from a handful of responses.</p>
    </div>

    <div class="card">
      <h2>What shows up in CSAT comments</h2>
      <p class="card-sub">Top words across completed CSAT comments (stopwords removed) &mdash; size and shade both scale with frequency.</p>
      <div class="card-controls">
        <div class="filter-group">
          <label for="f-word-brand">Brand</label>
          <select id="f-word-brand">
            <option value="All">All</option>
            <option value="Hyphen">Hyphen</option>
            <option value="mCaffeine">mCaffeine</option>
          </select>
        </div>
        <div class="filter-group">
          <label for="f-word-month">Month</label>
          <select id="f-word-month"><option value="All">All months</option></select>
        </div>
      </div>
      <div id="cloud"></div>
      <div id="cloud-empty" class="empty-note" style="display:none;">No CSAT comments with text for this Brand/Month combination.</div>
      <details class="table-toggle">
        <summary>Show as table</summary>
        <table class="data-table" id="words-table">
          <thead><tr><th>Word</th><th class="num">Mentions</th></tr></thead>
          <tbody></tbody>
        </table>
      </details>
    </div>
  </div>
</div>

<div class="tooltip" id="tooltip"></div>

<script>
const GRANULAR = {GRANULAR_JSON};
const WORDS_BY_FILTER = {WORDS_JSON};
const MONTH_ORDER = {MONTH_ORDER_JSON};

function passesFilter(rec, brand, resolver, channel) {{
  if (brand !== "All" && rec.b !== brand) return false;
  if (resolver !== "All" && rec.r !== resolver) return false;
  if (channel !== "All" && rec.ch !== channel) return false;
  return true;
}}

function computeHeatmap(brand, resolver, channel) {{
  const cell = {{}};
  const overall = {{}};
  GRANULAR.forEach(rec => {{
    if (!passesFilter(rec, brand, resolver, channel)) return;
    if (!cell[rec.c]) cell[rec.c] = {{}};
    if (!cell[rec.c][rec.m]) cell[rec.c][rec.m] = {{ n: 0, sum: 0 }};
    cell[rec.c][rec.m].n += rec.n;
    cell[rec.c][rec.m].sum += rec.n * Number(rec.rt);
    if (!overall[rec.c]) overall[rec.c] = {{ n: 0, sum: 0 }};
    overall[rec.c].n += rec.n;
    overall[rec.c].sum += rec.n * Number(rec.rt);
  }});
  const classes = Object.keys(cell).map(cls => ({{
    cls, cell: cell[cls],
    avg: overall[cls].n ? overall[cls].sum / overall[cls].n : 0,
    n: overall[cls].n
  }}));
  classes.sort((a, b) => b.avg - a.avg);
  return classes;
}}

function hexToRgb(hex) {{
  hex = hex.trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  return {{ r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }};
}}
function mixRgb(a, b, t) {{
  return {{ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) }};
}}
function relLuminance(rgb) {{
  const lin = c => {{ c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }};
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}}

function renderHeatmap(brand, resolver, channel) {{
  const rows = computeHeatmap(brand, resolver, channel);
  const head = document.getElementById('heatmap-head');
  const body = document.getElementById('heatmap-body');
  const tooltip = document.getElementById('tooltip');

  head.innerHTML = '<th class="corner">Task Category</th>' + MONTH_ORDER.map(m => `<th>${{m.replace(' 20', " '")}}</th>`).join('');

  if (rows.length === 0) {{
    body.innerHTML = '<tr><td class="rowlabel">No completed CSAT responses match this filter combination.</td></tr>';
    return;
  }}

  const cs = getComputedStyle(document.documentElement);
  const c1 = hexToRgb(cs.getPropertyValue('--rating-1') || '#e34948');
  const c3 = hexToRgb(cs.getPropertyValue('--rating-3') || '#898781');
  const c5 = hexToRgb(cs.getPropertyValue('--rating-5') || '#2a78d6');

  function colorForAvg(avg) {{
    return avg <= 3 ? mixRgb(c1, c3, (avg - 1) / 2) : mixRgb(c3, c5, (avg - 3) / 2);
  }}

  body.innerHTML = rows.map(row => {{
    const cells = MONTH_ORDER.map(m => {{
      const b = row.cell[m];
      if (!b || b.n === 0) return '<td class="cell empty">&ndash;</td>';
      const avg = b.sum / b.n;
      const rgb = colorForAvg(avg);
      const lum = relLuminance(rgb);
      const textColor = lum > 0.45 ? '#0b0b0b' : '#ffffff';
      return `<td class="cell" data-cls="${{row.cls}}" data-month="${{m}}" data-avg="${{avg.toFixed(2)}}" data-n="${{b.n}}" style="background:rgb(${{rgb.r}},${{rgb.g}},${{rgb.b}}); color:${{textColor}}">${{avg.toFixed(1)}}</td>`;
    }}).join('');
    return `<tr><td class="rowlabel" title="${{row.cls}}">${{row.cls}} <span style="color:var(--text-muted); font-weight:400;">(n=${{row.n}})</span></td>${{cells}}</tr>`;
  }}).join('');

  body.querySelectorAll('td.cell:not(.empty)').forEach(td => {{
    td.addEventListener('mousemove', (e) => {{
      tooltip.innerHTML = `<b>${{td.dataset.cls}} &middot; ${{td.dataset.month}}</b><br>Avg ${{td.dataset.avg}} &middot; n=${{td.dataset.n}}`;
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top = (e.clientY - 10) + 'px';
      tooltip.classList.add('show');
    }});
    td.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
  }});
}}

function renderWordsTable(words) {{
  const tbody = document.querySelector('#words-table tbody');
  tbody.innerHTML = words.map(w => `<tr><td>${{w.word}}</td><td class="num">${{w.count}}</td></tr>`).join('');
}}

function renderCloud(words) {{
  const container = document.getElementById('cloud');
  container.innerHTML = '';
  const W = container.clientWidth || 900;
  const H = 420;
  const top = words.slice(0, 80);
  const maxCount = top[0].count;
  const minCount = top[top.length - 1].count;
  const seqSteps = ['var(--seq-300)','var(--seq-400)','var(--seq-500)','var(--seq-600)','var(--seq-700)'];

  function fontSizeFor(count) {{
    const t = maxCount === minCount ? 1 : (count - minCount) / (maxCount - minCount);
    return 13 + t * (54 - 13);
  }}
  function colorFor(count) {{
    const t = maxCount === minCount ? 1 : (count - minCount) / (maxCount - minCount);
    const idx = Math.min(seqSteps.length - 1, Math.floor(t * seqSteps.length));
    return seqSteps[idx];
  }}

  const placed = [];
  const cx = W / 2, cy = H / 2;

  top.forEach(w => {{
    const size = fontSizeFor(w.count);
    const span = document.createElement('span');
    span.textContent = w.word;
    span.style.fontSize = size + 'px';
    span.style.color = colorFor(w.count);
    span.title = w.word + ': ' + w.count + ' mentions';
    span.style.visibility = 'hidden';
    container.appendChild(span);
    const rect = span.getBoundingClientRect();
    const bw = rect.width, bh = rect.height;

    let angle = 0, radius = 0;
    let x = cx - bw / 2, y = cy - bh / 2;
    let placedOk = false;
    for (let attempt = 0; attempt < 600; attempt++) {{
      const candX = cx + radius * Math.cos(angle) - bw / 2;
      const candY = cy + radius * Math.sin(angle) * 0.62 - bh / 2;
      const box = {{ x: candX, y: candY, w: bw + 4, h: bh + 4 }};
      const overlaps = placed.some(p =>
        box.x < p.x + p.w && box.x + box.w > p.x &&
        box.y < p.y + p.h && box.y + box.h > p.y
      );
      const inBounds = box.x >= 0 && box.y >= 0 && box.x + box.w <= W && box.y + box.h <= H;
      if (!overlaps && inBounds) {{ x = candX; y = candY; placedOk = true; break; }}
      angle += 0.45;
      radius += 2.2;
    }}
    placed.push({{ x, y, w: bw + 4, h: bh + 4 }});
    span.style.left = x + 'px';
    span.style.top = y + 'px';
    span.style.visibility = placedOk || radius < Math.max(W, H) ? 'visible' : 'hidden';
  }});
}}

function refreshAll() {{
  const brand = document.getElementById('f-brand').value;
  const resolver = document.getElementById('f-resolver').value;
  const channel = document.getElementById('f-channel').value;
  renderHeatmap(brand, resolver, channel);
}}

function computeWords(brand, month) {{
  const totals = {{}};
  WORDS_BY_FILTER.forEach(rec => {{
    if (brand !== "All" && rec.b !== brand) return;
    if (month !== "All" && rec.m !== month) return;
    totals[rec.w] = (totals[rec.w] || 0) + rec.c;
  }});
  return Object.keys(totals).map(w => ({{ word: w, count: totals[w] }})).sort((a, b) => b.count - a.count);
}}

function refreshWords() {{
  const brand = document.getElementById('f-word-brand').value;
  const month = document.getElementById('f-word-month').value;
  const words = computeWords(brand, month);
  const cloudEl = document.getElementById('cloud');
  const emptyEl = document.getElementById('cloud-empty');
  if (words.length === 0) {{
    cloudEl.style.display = 'none';
    emptyEl.style.display = 'block';
  }} else {{
    cloudEl.style.display = 'block';
    emptyEl.style.display = 'none';
    renderCloud(words);
  }}
  renderWordsTable(words);
}}

const wordMonthSelect = document.getElementById('f-word-month');
MONTH_ORDER.forEach(m => {{
  const opt = document.createElement('option');
  opt.value = m; opt.textContent = m;
  wordMonthSelect.appendChild(opt);
}});

refreshWords();
refreshAll();

document.getElementById('f-brand').addEventListener('change', refreshAll);
document.getElementById('f-resolver').addEventListener('change', refreshAll);
document.getElementById('f-channel').addEventListener('change', refreshAll);
document.getElementById('f-word-brand').addEventListener('change', refreshWords);
document.getElementById('f-word-month').addEventListener('change', refreshWords);
window.addEventListener('resize', () => {{ refreshWords(); refreshAll(); }});
</script>
"""

with open(OUT_PATH, "w", encoding="utf-8") as f:
    f.write(html)

print("wrote", OUT_PATH, len(html), "chars")

# Standalone document for the gated report server (api/report/[card].js reads this
# file raw and serves it to an iframe, so it needs its own doctype/html/head/body).
# The <title>/<style> tags inside `html` are parsed into the document head per the
# HTML5 parsing algorithm even though they're physically written in the body.
report_html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body>
{html}
</body>
</html>
"""

with open(REPORT_OUT_PATH, "w", encoding="utf-8") as f:
    f.write(report_html)

print("wrote", REPORT_OUT_PATH, len(report_html), "chars")
