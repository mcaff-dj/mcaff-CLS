import json

DATA_PATH = r"mcaff-CLS/data/csat_dashboard_data.json"
OUT_PATH = r"C:\Users\VIKASH~1\AppData\Local\Temp\claude\c--Users-VIKASH-PATHAK-Desktop-Service-account\bd9f7c2d-a5ad-4cff-a5c9-0206d6b3cc94\scratchpad\csat_dashboard.html"
REPORT_OUT_PATH = r"mcaff-CLS/api/_reports/deepdive.html"

with open(DATA_PATH, "r", encoding="utf-8") as f:
    D = json.load(f)

def n(x):
    return f"{int(round(x)):,}"

def avg(x):
    return f"{x:.2f}"

k = D["kpis"]

DIP_MARK_NOTE = (
    "A &#9660; on the current month's cell means that row's rating dropped &ge;0.3 vs a prior month "
    "(both months need n&ge;15) &mdash; hover the cell for which month(s) and by how much."
)

coverage_html = (
    f"Click &#9656; on a Query Class row to expand its Query Category breakdown. "
    f"The top 20 of {D['n_tasks_total']} distinct Query Categories "
    f"({D['task_coverage_pct']}% of all completed CSAT volume) are shown per class; the remainder are grouped into <b>Other</b>. "
    f"'(none)' means no category was tagged on the ticket. {D['n_query_classes_total']} Query Classes total. {DIP_MARK_NOTE}"
)

agent_coverage_html = (
    f"Click &#9656; on an agent row to expand its Query Class breakdown. "
    f"All {D['n_agents_total']} agents are shown (no bucketing needed). "
    f"'AI' is every AI-resolved ticket plus any human-resolved ticket with no agent name recorded. "
    f"{DIP_MARK_NOTE}"
)

# Shared by the Agent wise analysis tab (JS mirrors these as AGENT_MIN_N / CELL_DIP_MIN_N / CELL_DIP_THRESHOLD).
AGENT_MIN_N = 30
CELL_DIP_MIN_N = 15
CELL_DIP_THRESHOLD = 0.3

agent_leaderboard_footnote = (
    f"'Top agent' / 'Needs attention' require at least {AGENT_MIN_N} responses under the current filter, "
    f"so a low-volume agent can't win or lose on noise. Trend flags a &#9660;/&#9650; when this agent's current-month avg "
    f"is &ge;{CELL_DIP_THRESHOLD} off a prior month's avg (both months need n&ge;{CELL_DIP_MIN_N}) &mdash; hover the badge for which month(s)."
)

GRANULAR_JSON = json.dumps(D["granular"], ensure_ascii=False, separators=(",", ":"))
GRANULAR_AGENT_JSON = json.dumps(D["granular_agent"], ensure_ascii=False, separators=(",", ":"))
GRANULAR_AGENT_CLASS_JSON = json.dumps(D["granular_agent_class"], ensure_ascii=False, separators=(",", ":"))
WORDS_JSON = json.dumps(D["words_by_filter"], ensure_ascii=False, separators=(",", ":"))
MONTH_ORDER_JSON = json.dumps(D["month_order"], ensure_ascii=False)

brands = k["brands"]
hyphen = brands.get("Hyphen", {})
mcaff = brands.get("mCaffeine", {})
channels = k["channels"]
whatsapp = channels.get("whatsapp", {})
email = channels.get("email", {})
livechat = channels.get("liveChat", {})

html = f"""<title>Deep Dive — Hyphen &amp; mCaffeine (Mar&ndash;Jul 2026)</title>
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

    --warn-bg:     #fdf3e2; --warn-border: #edc871; --warn-text: #7a5205;
    --good-bg:     #eaf6ee; --good-border: #a6dcb6; --good-text: #1e6b38;

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
      --warn-bg:     #3a2c0d; --warn-border: #7a5a17; --warn-text: #f0c869;
      --good-bg:     #123321; --good-border: #2f6b45; --good-text: #7fdba0;
      --seq-300: #1c5cab; --seq-400: #3987e5; --seq-500: #5598e7; --seq-600: #86b6ef; --seq-700: #cde2fb;
    }}
  }}
  :root[data-theme="dark"] .viz-root {{
    --surface-1: #1a1a19; --page-plane: #0d0d0d; --text-primary: #ffffff;
    --text-secondary: #c3c2b7; --text-muted: #898781; --gridline: #2c2c2a; --border: rgba(255,255,255,0.10);
    --rating-1: #e66767; --rating-3: #898781; --rating-5: #3987e5;
    --brand-hyphen: #9a7fe0; --brand-mcaff: #eba845; --resolver-ai: #3987e5; --resolver-human: #199e70;
    --warn-bg: #3a2c0d; --warn-border: #7a5a17; --warn-text: #f0c869;
    --good-bg: #123321; --good-border: #2f6b45; --good-text: #7fdba0;
    --seq-300: #1c5cab; --seq-400: #3987e5; --seq-500: #5598e7; --seq-600: #86b6ef; --seq-700: #cde2fb;
  }}
  :root[data-theme="light"] .viz-root {{
    --surface-1: #fcfcfb; --page-plane: #f9f9f7; --text-primary: #0b0b0b;
    --text-secondary: #52514e; --text-muted: #898781; --gridline: #e1e0d9; --border: rgba(11,11,11,0.10);
    --rating-1: #e34948; --rating-3: #898781; --rating-5: #2a78d6;
    --brand-hyphen: #6b4bc7; --brand-mcaff: #d98c1f; --resolver-ai: #2a78d6; --resolver-human: #1baf7a;
    --warn-bg: #fdf3e2; --warn-border: #edc871; --warn-text: #7a5205;
    --good-bg: #eaf6ee; --good-border: #a6dcb6; --good-text: #1e6b38;
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
  table.heatmap td.cell.dip {{ box-shadow: inset 0 0 0 2px var(--warn-border); }}
  .dip-flag {{ display: inline-block; font-size: 8px; line-height: 1; padding: 1.5px 3px; border-radius: 3px; margin-left: 3px; vertical-align: 1px; }}
  table.heatmap tr + tr td, table.heatmap tr + tr th {{ border-top: 1px solid var(--gridline); }}
  .row-toggle {{ display: inline-block; width: 14px; cursor: pointer; user-select: none; color: var(--text-muted); font-size: 10px; transition: transform 0.15s; }}
  .row-toggle.expanded {{ transform: rotate(90deg); }}
  .row-toggle-spacer {{ display: inline-block; width: 14px; }}
  table.heatmap tr.cls-row td.rowlabel {{ cursor: pointer; }}
  table.heatmap td.rowlabel.sub {{ padding-left: 30px; font-weight: 450; color: var(--text-secondary); }}
  table.heatmap tr.qcat-row {{ background: color-mix(in srgb, var(--text-primary) 3%, transparent); }}

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

  .dip-banner {{
    display: flex; align-items: flex-start; gap: 10px;
    border-radius: 10px; padding: 12px 16px; margin-bottom: 20px;
    font-size: 13px; line-height: 1.5; border: 1px solid transparent;
  }}
  .dip-banner .dip-icon {{ font-size: 15px; line-height: 1.5; flex: none; }}
  .dip-banner b {{ font-weight: 650; }}
  .dip-banner.warn {{ background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }}
  .dip-banner.good {{ background: var(--good-bg); border-color: var(--good-border); color: var(--good-text); }}
  .dip-banner.neutral {{ background: var(--surface-1); border-color: var(--border); color: var(--text-secondary); }}

  .tab-nav {{ display: flex; flex-wrap: wrap; gap: 6px; margin: 20px 0 24px; border-bottom: 1px solid var(--gridline); padding-bottom: 0; overflow-x: auto; }}
  .tab-btn {{ appearance: none; border: 1px solid transparent; background: transparent; color: var(--text-secondary); font-size: 13px; font-family: inherit; padding: 9px 14px; border-radius: 8px 8px 0 0; cursor: pointer; position: relative; top: 1px; white-space: nowrap; flex: none; }}
  .tab-btn:hover {{ color: var(--text-primary); background: var(--surface-1); }}
  .tab-btn.active {{ color: var(--text-primary); font-weight: 650; background: var(--surface-1); border: 1px solid var(--border); border-bottom: 1px solid var(--surface-1); }}
  .tab-panel {{ display: none; }}
  .tab-panel.active {{ display: block; }}

  table.data-table tr.agent-cls-row td:first-child {{ cursor: pointer; }}
  table.data-table tr.agent-sub-row td {{ background: color-mix(in srgb, var(--text-primary) 3%, transparent); }}
  table.data-table th[data-sort] {{ cursor: pointer; user-select: none; }}
  table.data-table th[data-sort]:hover {{ color: var(--text-primary); }}
  table.data-table th .sort-arrow {{ font-size: 9px; opacity: 0.55; margin-left: 3px; }}
  .trend-badge {{ display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }}
  .trend-badge.down {{ color: var(--warn-text); background: var(--warn-bg); }}
  .trend-badge.up {{ color: var(--good-text); background: var(--good-bg); }}
  .trend-badge.flat {{ color: var(--text-muted); background: transparent; }}

  @media (max-width: 760px) {{
    .kpi-row {{ grid-template-columns: repeat(2, 1fr); }}
  }}
</style>

<div class="viz-root">
  <div class="wrap">
    <h1>Deep Dive — Query Class, Resolver &amp; Comment Themes</h1>
    <p class="sub">{n(k['total'])} completed CSAT responses &middot; {k['date_min']} &ndash; {k['date_max']} &middot; overall avg rating <b>{avg(k['overall_avg'])}</b> / 5</p>
    <p class="sub-brands">
      <span class="chip hyphen">Hyphen</span> {n(hyphen.get('n',0))} responses, avg {avg(hyphen.get('avg',0))} &nbsp;&middot;&nbsp;
      <span class="chip mcaff">mCaffeine</span> {n(mcaff.get('n',0))} responses, avg {avg(mcaff.get('avg',0))} &nbsp;&middot;&nbsp;
      AI-resolved avg {avg(k['ai_avg'])} (n={n(k['ai_n'])}) &nbsp;vs&nbsp; Human-resolved avg {avg(k['human_avg'])} (n={n(k['human_n'])}) &nbsp;&middot;&nbsp;
      WhatsApp avg {avg(whatsapp.get('avg',0))} (n={n(whatsapp.get('n',0))}) &nbsp;&middot;&nbsp; Email avg {avg(email.get('avg',0))} (n={n(email.get('n',0))}) &nbsp;&middot;&nbsp; Live Chat avg {avg(livechat.get('avg',0))} (n={n(livechat.get('n',0))})
    </p>

    <nav class="tab-nav">
      <button class="tab-btn active" data-tab="csat">CSAT Deep Dive</button>
      <button class="tab-btn" data-tab="agent">Agent wise analysis</button>
    </nav>

    <div class="tab-panel active" id="panel-csat">
      <div id="dip-banner" class="dip-banner neutral"><span class="dip-icon">…</span><span>Checking month-on-month CSAT…</span></div>

      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Total responses</div><div class="kpi-value" id="kpi-total">{n(k['total'])}</div><div class="kpi-sub" id="kpi-total-sub">closed tickets</div></div>
        <div class="kpi"><div class="kpi-label">Overall avg rating</div><div class="kpi-value" id="kpi-overall-avg">{avg(k['overall_avg'])}</div><div class="kpi-sub">out of 5</div></div>
        <div class="kpi"><div class="kpi-label">AI-resolved avg</div><div class="kpi-value" id="kpi-ai-avg">{avg(k['ai_avg'])}</div><div class="kpi-sub" id="kpi-ai-sub">n={n(k['ai_n'])}</div></div>
        <div class="kpi"><div class="kpi-label">Human-resolved avg</div><div class="kpi-value" id="kpi-human-avg">{avg(k['human_avg'])}</div><div class="kpi-sub" id="kpi-human-sub">n={n(k['human_n'])}</div></div>
        <div class="kpi"><div class="kpi-label">Promoters (4&ndash;5)</div><div class="kpi-value" id="kpi-promoters">{k['promoters_pct']}%</div><div class="kpi-sub">of filtered responses</div></div>
        <div class="kpi"><div class="kpi-label">Detractors (1&ndash;2)</div><div class="kpi-value" id="kpi-detractors">{k['detractors_pct']}%</div><div class="kpi-sub">of filtered responses</div></div>
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
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="liveChat">Live Chat</option>
          </select>
        </div>
        <div class="filter-group" style="color:var(--text-muted); font-size:12px;">Applies to the KPIs and heatmap below</div>
      </div>

      <div class="card">
        <h2>Average CSAT rating, month on month</h2>
        <p class="card-sub">Query Class &times; month, sorted by overall avg rating &mdash; blank cells = no completed CSAT that month. Hover a cell for n, expand a row for its Query Category breakdown.</p>
        <div class="heatmap-scroll">
          <table class="heatmap" id="heatmap-table">
            <thead><tr id="heatmap-head"></tr></thead>
            <tbody id="heatmap-body"></tbody>
          </table>
        </div>
        <p class="footnote">{coverage_html}</p>
      </div>

      <div class="card">
        <h2>Average CSAT rating, month on month &mdash; by Agent</h2>
        <p class="card-sub">Agent &times; month, sorted by overall avg rating &mdash; blank cells = no completed CSAT that month. Hover a cell for n, expand a row for its Query Class breakdown.</p>
        <div class="heatmap-scroll">
          <table class="heatmap" id="heatmap-agent-table">
            <thead><tr id="heatmap-agent-head"></tr></thead>
            <tbody id="heatmap-agent-body"></tbody>
          </table>
        </div>
        <p class="footnote">{agent_coverage_html}</p>
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
        <p class="footnote">mCaffeine's CSAT comment field is empty in the source DB for every response here &mdash; all comment text below comes from Hyphen.</p>
      </div>
    </div>

    <div class="tab-panel" id="panel-agent">
      <div class="filterbar">
        <div class="filter-group">
          <label for="fa-brand">Brand</label>
          <select id="fa-brand">
            <option value="All">All</option>
            <option value="Hyphen">Hyphen</option>
            <option value="mCaffeine">mCaffeine</option>
          </select>
        </div>
        <div class="filter-group">
          <label for="fa-channel">Channel</label>
          <select id="fa-channel">
            <option value="All">All</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="liveChat">Live Chat</option>
          </select>
        </div>
        <div class="filter-group" style="color:var(--text-muted); font-size:12px;">Applies to the KPIs and table below &middot; AI-resolved tickets are excluded here &mdash; see CSAT Deep Dive for AI vs Human.</div>
      </div>

      <div class="kpi-row" style="grid-template-columns: repeat(4, 1fr);">
        <div class="kpi"><div class="kpi-label">Human agents</div><div class="kpi-value" id="akpi-count">&ndash;</div><div class="kpi-sub" id="akpi-count-sub">with completed CSAT</div></div>
        <div class="kpi"><div class="kpi-label">Avg rating (human)</div><div class="kpi-value" id="akpi-avg">&ndash;</div><div class="kpi-sub" id="akpi-avg-sub">out of 5</div></div>
        <div class="kpi"><div class="kpi-label">Top agent</div><div class="kpi-value" id="akpi-top" style="font-size:16px;">&ndash;</div><div class="kpi-sub" id="akpi-top-sub">&ndash;</div></div>
        <div class="kpi"><div class="kpi-label">Needs attention</div><div class="kpi-value" id="akpi-bottom" style="font-size:16px;">&ndash;</div><div class="kpi-sub" id="akpi-bottom-sub">&ndash;</div></div>
      </div>

      <div class="card">
        <h2>Agent leaderboard</h2>
        <p class="card-sub">Sorted by total responses by default &mdash; click a column header to re-sort. Click an agent row to expand its Query Class breakdown (top 6 by volume).</p>
        <div class="heatmap-scroll">
          <table class="data-table" id="agent-leaderboard-table">
            <thead>
              <tr>
                <th data-sort="agent">Agent<span class="sort-arrow"></span></th>
                <th data-sort="n" class="num">Responses<span class="sort-arrow"></span></th>
                <th data-sort="avg" class="num">Avg rating<span class="sort-arrow"></span></th>
                <th data-sort="promotersPct" class="num">Promoters %<span class="sort-arrow"></span></th>
                <th data-sort="detractorsPct" class="num">Detractors %<span class="sort-arrow"></span></th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody id="agent-leaderboard-body"></tbody>
          </table>
        </div>
        <p class="footnote">{agent_leaderboard_footnote}</p>
      </div>
    </div>
  </div>
</div>

<div class="tooltip" id="tooltip"></div>

<script>
const GRANULAR = {GRANULAR_JSON};
const GRANULAR_AGENT = {GRANULAR_AGENT_JSON};
const GRANULAR_AGENT_CLASS = {GRANULAR_AGENT_CLASS_JSON};
const WORDS_BY_FILTER = {WORDS_JSON};
const MONTH_ORDER = {MONTH_ORDER_JSON};

function passesFilter(rec, brand, resolver, channel) {{
  if (brand !== "All" && rec.b !== brand) return false;
  if (resolver !== "All" && rec.r !== resolver) return false;
  if (channel !== "All" && rec.ch !== channel) return false;
  return true;
}}

function computeGroupedRows(records, keyFn) {{
  const cell = {{}};
  const overall = {{}};
  records.forEach(rec => {{
    const key = keyFn(rec);
    if (!cell[key]) cell[key] = {{}};
    if (!cell[key][rec.m]) cell[key][rec.m] = {{ n: 0, sum: 0 }};
    cell[key][rec.m].n += rec.n;
    cell[key][rec.m].sum += rec.n * Number(rec.rt);
    if (!overall[key]) overall[key] = {{ n: 0, sum: 0 }};
    overall[key].n += rec.n;
    overall[key].sum += rec.n * Number(rec.rt);
  }});
  const rows = Object.keys(cell).map(key => ({{
    cls: key, cell: cell[key],
    avg: overall[key].n ? overall[key].sum / overall[key].n : 0,
    n: overall[key].n
  }}));
  rows.sort((a, b) => b.avg - a.avg);
  return rows;
}}

function computeHeatmap(granular, brand, resolver, channel) {{
  const filtered = granular.filter(rec => passesFilter(rec, brand, resolver, channel));
  return computeGroupedRows(filtered, rec => rec.c);
}}

// Query Category breakdown within a single Query Class row (used by the expand toggle).
function computeSubHeatmap(className, brand, resolver, channel) {{
  const filtered = GRANULAR.filter(rec => passesFilter(rec, brand, resolver, channel) && rec.c === className);
  return computeGroupedRows(filtered, rec => rec.cat);
}}

// Query Class breakdown within a single Agent row (used by the by-Agent table's expand toggle).
function computeSubHeatmapByAgent(agentName, brand, resolver, channel) {{
  const filtered = GRANULAR_AGENT_CLASS.filter(rec => passesFilter(rec, brand, resolver, channel) && rec.ag === agentName);
  return computeGroupedRows(filtered, rec => rec.c);
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

// A row's current-month cell is flagged as a dip when it drops at least this many
// rating points vs some prior month's cell for that same row (both need min sample size).
const CELL_DIP_MIN_N = {CELL_DIP_MIN_N};
const CELL_DIP_THRESHOLD = {CELL_DIP_THRESHOLD};
const CURRENT_MONTH = MONTH_ORDER[MONTH_ORDER.length - 1];
// Min responses for an agent to be eligible as "Top agent" / "Needs attention" in the Agent wise analysis tab.
const AGENT_MIN_N = {AGENT_MIN_N};

function rowDips(row) {{
  const curr = row.cell[CURRENT_MONTH];
  if (!curr || curr.n < CELL_DIP_MIN_N) return null;
  const currAvg = curr.sum / curr.n;
  const dips = [];
  MONTH_ORDER.forEach(m => {{
    if (m === CURRENT_MONTH) return;
    const b = row.cell[m];
    if (!b || b.n < CELL_DIP_MIN_N) return;
    const avg = b.sum / b.n;
    if (avg - currAvg >= CELL_DIP_THRESHOLD) dips.push({{ month: m, avg, drop: avg - currAvg }});
  }});
  return dips.length ? dips.sort((a, b) => b.drop - a.drop) : null;
}}

function colorScale() {{
  const cs = getComputedStyle(document.documentElement);
  const c1 = hexToRgb(cs.getPropertyValue('--rating-1') || '#e34948');
  const c3 = hexToRgb(cs.getPropertyValue('--rating-3') || '#898781');
  const c5 = hexToRgb(cs.getPropertyValue('--rating-5') || '#2a78d6');
  return avg => (avg <= 3 ? mixRgb(c1, c3, (avg - 1) / 2) : mixRgb(c3, c5, (avg - 3) / 2));
}}

function cellsHtmlForRow(row, colorForAvg) {{
  const dips = rowDips(row);
  return MONTH_ORDER.map(m => {{
    const b = row.cell[m];
    if (!b || b.n === 0) return '<td class="cell empty">&ndash;</td>';
    const avg = b.sum / b.n;
    const rgb = colorForAvg(avg);
    const lum = relLuminance(rgb);
    const textColor = lum > 0.45 ? '#0b0b0b' : '#ffffff';
    const isDipCell = m === CURRENT_MONTH && dips;
    const cellClass = 'cell' + (isDipCell ? ' dip' : '');
    let dipMark = '';
    let dipTitle = '';
    if (isDipCell) {{
      const badgeBg = lum > 0.45 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)';
      dipTitle = ' data-dip="Down vs ' + dips.map(d => d.month + ' (' + d.avg.toFixed(2) + ', &minus;' + d.drop.toFixed(2) + ')').join(', ') + '"';
      dipMark = ` <span class="dip-flag" style="background:${{badgeBg}}; color:${{textColor}}">&#9660;</span>`;
    }}
    return `<td class="${{cellClass}}" data-cls="${{row.cls}}" data-month="${{m}}" data-avg="${{avg.toFixed(2)}}" data-n="${{b.n}}"${{dipTitle}} style="background:rgb(${{rgb.r}},${{rgb.g}},${{rgb.b}}); color:${{textColor}}">${{avg.toFixed(1)}}${{dipMark}}</td>`;
  }}).join('');
}}

function wireCellTooltips(body, tooltip) {{
  body.querySelectorAll('td.cell:not(.empty)').forEach(td => {{
    td.addEventListener('mousemove', (e) => {{
      let html = `<b>${{td.dataset.cls}} &middot; ${{td.dataset.month}}</b><br>Avg ${{td.dataset.avg}} &middot; n=${{td.dataset.n}}`;
      if (td.dataset.dip) html += `<br>${{td.dataset.dip}}`;
      tooltip.innerHTML = html;
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top = (e.clientY - 10) + 'px';
      tooltip.classList.add('show');
    }});
    td.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
  }});
}}

// Shared renderer for both expandable heatmaps (Query Class -> Query Category,
// Agent -> Query Class) - rows are the top-level (already-filtered) groups;
// computeSubRowsFn(row.cls) returns that row's expand-on-click breakdown.
function renderExpandableHeatmap(rows, headId, bodyId, cornerLabel, computeSubRowsFn) {{
  const head = document.getElementById(headId);
  const body = document.getElementById(bodyId);
  const tooltip = document.getElementById('tooltip');

  head.innerHTML = `<th class="corner">${{cornerLabel}}</th>` + MONTH_ORDER.map(m => `<th>${{m.replace(' 20', " '")}}</th>`).join('');

  if (rows.length === 0) {{
    body.innerHTML = '<tr><td class="rowlabel">No completed CSAT responses match this filter combination.</td></tr>';
    return;
  }}

  const colorForAvg = colorScale();
  body.innerHTML = rows.map((row, i) => {{
    const subRows = computeSubRowsFn(row.cls);
    const subHtml = subRows.map(sub =>
      `<tr class="qcat-row" data-parent-idx="${{i}}" style="display:none;"><td class="rowlabel sub" title="${{sub.cls}}">${{sub.cls}} <span style="color:var(--text-muted); font-weight:400;">(n=${{sub.n}})</span></td>${{cellsHtmlForRow(sub, colorForAvg)}}</tr>`
    ).join('');
    const toggle = subRows.length
      ? `<span class="row-toggle" data-toggle-idx="${{i}}">&#9656;</span>`
      : '<span class="row-toggle-spacer"></span>';
    return `<tr class="cls-row" data-toggle-idx="${{i}}"><td class="rowlabel" title="${{row.cls}}">${{toggle}}${{row.cls}} <span style="color:var(--text-muted); font-weight:400;">(n=${{row.n}})</span></td>${{cellsHtmlForRow(row, colorForAvg)}}</tr>${{subHtml}}`;
  }}).join('');

  wireCellTooltips(body, tooltip);

  function toggleRow(i) {{
    const toggleEl = body.querySelector(`.row-toggle[data-toggle-idx="${{i}}"]`);
    if (!toggleEl) return;
    const expanded = toggleEl.classList.toggle('expanded');
    body.querySelectorAll(`tr.qcat-row[data-parent-idx="${{i}}"]`).forEach(tr => {{
      tr.style.display = expanded ? '' : 'none';
    }});
  }}
  body.querySelectorAll('tr.cls-row').forEach(tr => {{
    tr.querySelector('td.rowlabel').addEventListener('click', () => toggleRow(tr.dataset.toggleIdx));
  }});
}}

// Query Class heatmap: each class row expands to show its Query Category breakdown.
function renderClassHeatmap(brand, resolver, channel) {{
  const rows = computeHeatmap(GRANULAR, brand, resolver, channel);
  renderExpandableHeatmap(rows, 'heatmap-head', 'heatmap-body', 'Query Class',
    cls => computeSubHeatmap(cls, brand, resolver, channel));
}}

// Agent heatmap: each agent row expands to show its Query Class breakdown.
function renderAgentHeatmap(brand, resolver, channel) {{
  const rows = computeHeatmap(GRANULAR_AGENT, brand, resolver, channel);
  renderExpandableHeatmap(rows, 'heatmap-agent-head', 'heatmap-agent-body', 'Agent',
    agentName => computeSubHeatmapByAgent(agentName, brand, resolver, channel));
}}

// ---------------- Agent wise analysis tab ----------------
// Per-agent totals + month cells (n/sum), built straight from GRANULAR_AGENT so
// rowDips()/riseInfo() (month-over-month) work unchanged - same {{cell: {{month: {{n,sum}}}}}} shape
// the CSAT tab's heatmap rows already use.
function computeAgentStats(brand, channel) {{
  const stats = {{}};
  GRANULAR_AGENT.forEach(rec => {{
    if (!passesFilter(rec, brand, "All", channel)) return;
    const agent = rec.c;
    if (!stats[agent]) stats[agent] = {{ n: 0, sum: 0, promN: 0, detN: 0, cell: {{}} }};
    const s = stats[agent];
    const rt = Number(rec.rt);
    s.n += rec.n;
    s.sum += rec.n * rt;
    if (rt >= 4) s.promN += rec.n;
    if (rt <= 2) s.detN += rec.n;
    if (!s.cell[rec.m]) s.cell[rec.m] = {{ n: 0, sum: 0 }};
    s.cell[rec.m].n += rec.n;
    s.cell[rec.m].sum += rec.n * rt;
  }});
  return Object.keys(stats).map(agent => {{
    const s = stats[agent];
    return {{
      agent, n: s.n, avg: s.n ? s.sum / s.n : 0,
      promotersPct: s.n ? 100 * s.promN / s.n : 0,
      detractorsPct: s.n ? 100 * s.detN / s.n : 0,
      cell: s.cell,
    }};
  }});
}}

// Query Class breakdown for one agent (used by the leaderboard's row expand).
function computeAgentClassBreakdown(agentName, brand, channel) {{
  const filtered = GRANULAR_AGENT_CLASS.filter(rec => passesFilter(rec, brand, "All", channel) && rec.ag === agentName);
  const byClass = {{}};
  filtered.forEach(rec => {{
    if (!byClass[rec.c]) byClass[rec.c] = {{ n: 0, sum: 0 }};
    byClass[rec.c].n += rec.n;
    byClass[rec.c].sum += rec.n * Number(rec.rt);
  }});
  return Object.keys(byClass)
    .map(c => ({{ cls: c, n: byClass[c].n, avg: byClass[c].sum / byClass[c].n }}))
    .sort((a, b) => b.n - a.n);
}}

// Mirror of rowDips() (same row shape, same thresholds) but for an improvement instead of a drop.
function riseInfo(row) {{
  const curr = row.cell[CURRENT_MONTH];
  if (!curr || curr.n < CELL_DIP_MIN_N) return null;
  const currAvg = curr.sum / curr.n;
  const rises = [];
  MONTH_ORDER.forEach(m => {{
    if (m === CURRENT_MONTH) return;
    const b = row.cell[m];
    if (!b || b.n < CELL_DIP_MIN_N) return;
    const avg = b.sum / b.n;
    if (currAvg - avg >= CELL_DIP_THRESHOLD) rises.push({{ month: m, avg, rise: currAvg - avg }});
  }});
  return rises.length ? rises.sort((a, b) => b.rise - a.rise) : null;
}}

function trendBadgeHtml(row) {{
  const dips = rowDips(row);
  if (dips) {{
    const detail = dips.map(d => `${{d.month}} (${{d.avg.toFixed(2)}})`).join(', ');
    return `<span class="trend-badge down" title="Down vs ${{detail}}">&#9660; vs prior</span>`;
  }}
  const rises = riseInfo(row);
  if (rises) {{
    const detail = rises.map(d => `${{d.month}} (${{d.avg.toFixed(2)}})`).join(', ');
    return `<span class="trend-badge up" title="Up vs ${{detail}}">&#9650; vs prior</span>`;
  }}
  const curr = row.cell[CURRENT_MONTH];
  if (!curr || curr.n < CELL_DIP_MIN_N) return `<span class="trend-badge flat" title="Not enough current-month volume (n<${{CELL_DIP_MIN_N}}) to compare">&ndash;</span>`;
  return `<span class="trend-badge flat" title="Within &plusmn;${{CELL_DIP_THRESHOLD}} of every comparable prior month">flat</span>`;
}}

const agentSort = {{ key: 'n', dir: 'desc' }};

function sortAgentRows(rows) {{
  const {{ key, dir }} = agentSort;
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => key === 'agent' ? mul * a.agent.localeCompare(b.agent) : mul * (a[key] - b[key]));
}}

function renderAgentKPIs(rows) {{
  const totalN = rows.reduce((s, r) => s + r.n, 0);
  const totalSum = rows.reduce((s, r) => s + r.avg * r.n, 0);
  const eligible = rows.filter(r => r.n >= AGENT_MIN_N);
  const top = eligible.length ? eligible.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
  const bottom = eligible.length ? eligible.reduce((a, b) => (b.avg < a.avg ? b : a)) : null;

  document.getElementById('akpi-count').textContent = fmtInt(rows.length);
  document.getElementById('akpi-avg').textContent = totalN ? fmtAvg(totalSum / totalN) : '&ndash;';
  document.getElementById('akpi-avg-sub').textContent = 'n=' + fmtInt(totalN);

  if (top) {{
    document.getElementById('akpi-top').textContent = top.agent;
    document.getElementById('akpi-top-sub').textContent = fmtAvg(top.avg) + ' avg · n=' + fmtInt(top.n);
  }} else {{
    document.getElementById('akpi-top').textContent = '&ndash;';
    document.getElementById('akpi-top-sub').textContent = 'needs n≥' + AGENT_MIN_N;
  }}
  if (bottom) {{
    document.getElementById('akpi-bottom').textContent = bottom.agent;
    document.getElementById('akpi-bottom-sub').textContent = fmtAvg(bottom.avg) + ' avg · n=' + fmtInt(bottom.n);
  }} else {{
    document.getElementById('akpi-bottom').textContent = '&ndash;';
    document.getElementById('akpi-bottom-sub').textContent = 'needs n≥' + AGENT_MIN_N;
  }}
}}

function renderAgentLeaderboard(brand, channel) {{
  const allRows = computeAgentStats(brand, channel);
  const rows = allRows.filter(r => r.agent !== 'AI');
  renderAgentKPIs(rows);

  const sorted = sortAgentRows(rows);
  const tbody = document.getElementById('agent-leaderboard-body');

  if (sorted.length === 0) {{
    tbody.innerHTML = '<tr><td colspan="6">No completed CSAT responses match this filter combination.</td></tr>';
    return;
  }}

  tbody.innerHTML = sorted.map((row, i) => {{
    const classBreak = computeAgentClassBreakdown(row.agent, brand, channel).slice(0, 6);
    const subHtml = classBreak.length
      ? `<tr class="agent-sub-row" data-parent-idx="${{i}}" style="display:none;"><td colspan="6" style="padding:10px 10px 14px 30px;">` +
        classBreak.map(c => `<span style="display:inline-block; margin:2px 14px 2px 0; font-size:12px; color:var(--text-secondary);"><b style="color:var(--text-primary)">${{c.cls}}</b> &mdash; n=${{c.n}}, avg ${{c.avg.toFixed(2)}}</span>`).join('') +
        `</td></tr>`
      : '';
    const toggle = classBreak.length
      ? `<span class="row-toggle" data-toggle-idx="${{i}}">&#9656;</span>`
      : '<span class="row-toggle-spacer"></span>';
    return `<tr class="agent-cls-row" data-toggle-idx="${{i}}">` +
      `<td>${{toggle}}${{row.agent}}</td>` +
      `<td class="num">${{fmtInt(row.n)}}</td>` +
      `<td class="num">${{fmtAvg(row.avg)}}</td>` +
      `<td class="num">${{fmtPct(row.promotersPct)}}</td>` +
      `<td class="num">${{fmtPct(row.detractorsPct)}}</td>` +
      `<td>${{trendBadgeHtml(row)}}</td>` +
      `</tr>${{subHtml}}`;
  }}).join('');

  tbody.querySelectorAll('tr.agent-cls-row').forEach(tr => {{
    tr.querySelector('td:first-child').addEventListener('click', () => {{
      const idx = tr.dataset.toggleIdx;
      const toggleEl = tr.querySelector('.row-toggle');
      if (!toggleEl) return;
      const expanded = toggleEl.classList.toggle('expanded');
      tbody.querySelectorAll(`tr.agent-sub-row[data-parent-idx="${{idx}}"]`).forEach(sub => {{
        sub.style.display = expanded ? '' : 'none';
      }});
    }});
  }});
}}

function refreshAgentTab() {{
  const brand = document.getElementById('fa-brand').value;
  const channel = document.getElementById('fa-channel').value;
  renderAgentLeaderboard(brand, channel);
}}

document.querySelectorAll('#agent-leaderboard-table th[data-sort]').forEach(th => {{
  th.addEventListener('click', () => {{
    const key = th.dataset.sort;
    if (agentSort.key === key) {{
      agentSort.dir = agentSort.dir === 'asc' ? 'desc' : 'asc';
    }} else {{
      agentSort.key = key;
      agentSort.dir = key === 'agent' ? 'asc' : 'desc';
    }}
    document.querySelectorAll('#agent-leaderboard-table th[data-sort] .sort-arrow').forEach(a => a.textContent = '');
    th.querySelector('.sort-arrow').textContent = agentSort.dir === 'asc' ? '▲' : '▼';
    refreshAgentTab();
  }});
}});

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

function computeKPIs(brand, resolver, channel) {{
  let totalN = 0, totalSum = 0;
  let aiN = 0, aiSum = 0, humanN = 0, humanSum = 0;
  let promotersN = 0, detractorsN = 0;
  GRANULAR.forEach(rec => {{
    if (!passesFilter(rec, brand, resolver, channel)) return;
    const rt = Number(rec.rt);
    totalN += rec.n;
    totalSum += rec.n * rt;
    if (rec.r === 'AI') {{ aiN += rec.n; aiSum += rec.n * rt; }}
    if (rec.r === 'Human') {{ humanN += rec.n; humanSum += rec.n * rt; }}
    if (rt >= 4) promotersN += rec.n;
    if (rt <= 2) detractorsN += rec.n;
  }});
  return {{
    totalN,
    overallAvg: totalN ? totalSum / totalN : 0,
    aiAvg: aiN ? aiSum / aiN : 0, aiN,
    humanAvg: humanN ? humanSum / humanN : 0, humanN,
    promotersPct: totalN ? 100 * promotersN / totalN : 0,
    detractorsPct: totalN ? 100 * detractorsN / totalN : 0,
  }};
}}

function fmtInt(x) {{ return Math.round(x).toLocaleString('en-IN'); }}
function fmtAvg(x) {{ return x.toFixed(2); }}
function fmtPct(x) {{ return x.toFixed(1) + '%'; }}

function renderKPIs(brand, resolver, channel) {{
  const s = computeKPIs(brand, resolver, channel);
  document.getElementById('kpi-total').textContent = fmtInt(s.totalN);
  document.getElementById('kpi-total-sub').textContent = brand === 'All' && resolver === 'All' && channel === 'All' ? 'closed tickets' : 'closed tickets (filtered)';
  document.getElementById('kpi-overall-avg').textContent = s.totalN ? fmtAvg(s.overallAvg) : '–';
  document.getElementById('kpi-ai-avg').textContent = s.aiN ? fmtAvg(s.aiAvg) : '–';
  document.getElementById('kpi-ai-sub').textContent = 'n=' + fmtInt(s.aiN);
  document.getElementById('kpi-human-avg').textContent = s.humanN ? fmtAvg(s.humanAvg) : '–';
  document.getElementById('kpi-human-sub').textContent = 'n=' + fmtInt(s.humanN);
  document.getElementById('kpi-promoters').textContent = s.totalN ? fmtPct(s.promotersPct) : '–';
  document.getElementById('kpi-detractors').textContent = s.totalN ? fmtPct(s.detractorsPct) : '–';
}}

// Minimum sample size per month before it's trusted for the dip comparison.
const DIP_MIN_N = 20;
// Minimum ratings-point drop before it counts as a real dip (not rounding noise).
const DIP_THRESHOLD = 0.05;

function computeMonthly(brand, resolver, channel) {{
  const byMonth = {{}};
  GRANULAR.forEach(rec => {{
    if (!passesFilter(rec, brand, resolver, channel)) return;
    if (!byMonth[rec.m]) byMonth[rec.m] = {{ n: 0, sum: 0 }};
    byMonth[rec.m].n += rec.n;
    byMonth[rec.m].sum += rec.n * Number(rec.rt);
  }});
  return MONTH_ORDER
    .filter(m => byMonth[m] && byMonth[m].n >= DIP_MIN_N)
    .map(m => ({{ month: m, avg: byMonth[m].sum / byMonth[m].n, n: byMonth[m].n }}));
}}

function renderDipBanner(brand, resolver, channel) {{
  const el = document.getElementById('dip-banner');
  const months = computeMonthly(brand, resolver, channel);

  if (months.length < 2) {{
    el.className = 'dip-banner neutral';
    el.innerHTML = '<span class="dip-icon">–</span><span>Not enough months with sufficient volume (n&ge;' + DIP_MIN_N + ') under this filter to compare.</span>';
    return;
  }}

  const current = months[months.length - 1];
  const prior = months.slice(0, -1);
  const isPartial = current.month === MONTH_ORDER[MONTH_ORDER.length - 1];
  const partialNote = isPartial ? ' (month in progress, so far)' : '';

  const dips = prior
    .map(p => ({{ month: p.month, avg: p.avg, n: p.n, drop: p.avg - current.avg }}))
    .filter(p => p.drop >= DIP_THRESHOLD)
    .sort((a, b) => b.drop - a.drop);

  if (dips.length > 0) {{
    const list = dips.map(p => `${{p.month}} (${{p.avg.toFixed(2)}}, &minus;${{p.drop.toFixed(2)}})`).join(', ');
    el.className = 'dip-banner warn';
    el.innerHTML = `<span class="dip-icon">&#9888;</span><span><b>${{current.month}}${{partialNote}} CSAT (${{current.avg.toFixed(2)}}) is down vs ${{dips.length}} prior month${{dips.length > 1 ? 's' : ''}}</b> under this filter: ${{list}}.</span>`;
  }} else {{
    const best = prior.reduce((a, b) => (b.avg > a.avg ? b : a), prior[0]);
    el.className = 'dip-banner good';
    el.innerHTML = `<span class="dip-icon">&#10003;</span><span><b>${{current.month}}${{partialNote}} CSAT (${{current.avg.toFixed(2)}}) is holding steady or better</b> than every prior month shown here (best comparison: ${{best.month}} at ${{best.avg.toFixed(2)}}) under this filter.</span>`;
  }}
}}

function refreshAll() {{
  const brand = document.getElementById('f-brand').value;
  const resolver = document.getElementById('f-resolver').value;
  const channel = document.getElementById('f-channel').value;
  renderKPIs(brand, resolver, channel);
  renderDipBanner(brand, resolver, channel);
  renderClassHeatmap(brand, resolver, channel);
  renderAgentHeatmap(brand, resolver, channel);
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
refreshAgentTab();

document.getElementById('f-brand').addEventListener('change', refreshAll);
document.getElementById('f-resolver').addEventListener('change', refreshAll);
document.getElementById('f-channel').addEventListener('change', refreshAll);
document.getElementById('f-word-brand').addEventListener('change', refreshWords);
document.getElementById('f-word-month').addEventListener('change', refreshWords);
document.getElementById('fa-brand').addEventListener('change', refreshAgentTab);
document.getElementById('fa-channel').addEventListener('change', refreshAgentTab);
window.addEventListener('resize', () => {{ refreshWords(); refreshAll(); }});

document.querySelectorAll('.tab-btn').forEach(function(b) {{
  b.addEventListener('click', function() {{
    document.querySelectorAll('.tab-btn').forEach(function(x) {{ x.classList.remove('active'); }});
    document.querySelectorAll('.tab-panel').forEach(function(p) {{ p.classList.remove('active'); }});
    b.classList.add('active');
    document.getElementById('panel-' + b.dataset.tab).classList.add('active');
  }});
}});
// The dashboard's sidebar mirrors these tabs in its own "Report Views" nav (see
// dashboard.html's onIframeLoaded) - this in-report row is redundant there, but
// stays visible when the report is opened directly (no other nav available then).
if (window.top !== window.self) {{
  var tn = document.querySelector('.tab-nav');
  if (tn) tn.style.display = 'none';
}}
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
