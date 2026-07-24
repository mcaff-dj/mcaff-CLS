import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent

DATA_PATH = REPO_ROOT / "data/csat_dashboard_data.json"
REPORT_OUT_PATH = REPO_ROOT / "api/_reports/deepdive.html"

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

# Shared by the CSAT tab's month-over-month dip banner (JS mirrors these as CELL_DIP_MIN_N / CELL_DIP_THRESHOLD).
CELL_DIP_MIN_N = 15
CELL_DIP_THRESHOLD = 0.3

GRANULAR_JSON = json.dumps(D["granular"], ensure_ascii=False, separators=(",", ":"))
GRANULAR_AGENT_JSON = json.dumps(D["granular_agent"], ensure_ascii=False, separators=(",", ":"))
GRANULAR_AGENT_CLASS_JSON = json.dumps(D["granular_agent_class"], ensure_ascii=False, separators=(",", ":"))
WORDS_JSON = json.dumps(D["words_by_filter"], ensure_ascii=False, separators=(",", ":"))
MONTH_ORDER_JSON = json.dumps(D["month_order"], ensure_ascii=False)

# Agent wise analysis tab: daily agent-status export (login/logout, busy/break/offline
# minutes per agent per day), a separate dataset from the CSAT tables above.
SHIFT_DATA_PATH = REPO_ROOT / "data/agent_shift_status.json"
with open(SHIFT_DATA_PATH, "r", encoding="utf-8") as f:
    SHIFT_DATA = json.load(f)
AGENT_SHIFT_JSON = json.dumps(SHIFT_DATA, ensure_ascii=False, separators=(",", ":"))

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

  /* Agent wise analysis tab: Brand filter + Daily/Weekly toggle + shift-status table.
     Brand is a plain <select> (not tab-nav/tab-btn) so it can't collide with the
     dashboard shell's onIframeLoaded(), which scrapes every .tab-nav .tab-btn in this
     document (unscoped) to build its own sidebar nav, or with this report's own
     top-level tab-click wiring (#main-tab-nav .tab-btn) - both previously picked up
     "Hyphen"/"mCaffeine" when they were rendered as tab-styled buttons. */
  .gran-toggle {{ display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }}
  .gran-btn {{ appearance: none; border: none; background: var(--page-plane); color: var(--text-secondary); font: inherit; font-size: 13px; font-weight: 600; padding: 6px 14px; cursor: pointer; }}
  .gran-btn.active {{ background: var(--brand-hyphen); color: #fff; }}
  #panel-agent table.data-table th {{ cursor: pointer; user-select: none; }}
  #panel-agent table.data-table th:hover {{ color: var(--text-primary); }}
  #panel-agent table.data-table th .arrow {{ font-size: 9px; margin-left: 3px; opacity: 0.6; }}
  #panel-agent table.data-table td.name {{ font-weight: 600; color: var(--text-primary); }}
  #panel-agent table.data-table tr.absent td {{ color: var(--text-muted); font-style: italic; }}
  #panel-agent table.data-table td.muted {{ color: var(--text-muted); font-size: 11.5px; }}

  @media (max-width: 760px) {{
    .kpi-row {{ grid-template-columns: repeat(2, 1fr); }}
  }}

  /* Report-level refresh control - reruns build_csat_dashboard_data.py,
     build_agent_shift_status.py and build_csat_artifact.py (see
     .github/workflows/refresh-deepdive.yml), so it sits above the tab-nav
     rather than inside either tab panel - it refreshes both. */
  .dd-refresh-row {{ display: flex; align-items: center; gap: 10px; margin: 4px 0 14px; flex-wrap: wrap; }}
  .dd-refresh-btn {{
    appearance: none; display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary);
    font: inherit; font-size: 12.5px; font-weight: 600; padding: 6px 12px; border-radius: 7px;
    cursor: pointer; transition: border-color .15s ease, color .15s ease;
  }}
  .dd-refresh-btn:hover:not(:disabled) {{ border-color: var(--brand-hyphen); color: var(--brand-hyphen); }}
  .dd-refresh-btn:disabled {{ opacity: .6; cursor: default; }}
  .dd-refresh-btn .spin {{ display: inline-block; }}
  .dd-refresh-btn.spinning .spin {{ animation: dd-spin 1s linear infinite; }}
  @keyframes dd-spin {{ from {{ transform: rotate(0deg); }} to {{ transform: rotate(360deg); }} }}
  .dd-refresh-status {{ font-size: 11.5px; color: var(--text-muted); }}
  .dd-refresh-status.error {{ color: var(--rating-1); }}
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

    <div class="dd-refresh-row">
      <button type="button" class="dd-refresh-btn" id="dd-refresh-btn" onclick="ddTriggerRefresh()">
        <span class="spin">&#8635;</span> Refresh data
      </button>
      <span class="dd-refresh-status" id="dd-refresh-status"></span>
      <span class="dd-refresh-status" id="dd-last-refreshed"></span>
    </div>

    <nav class="tab-nav" id="main-tab-nav">
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
      <p class="card-sub" style="margin:0 0 16px;">From the daily agent-status export (Hyphen &amp; mCaffeine).</p>

      <div class="filterbar">
        <div class="filter-group">
          <label for="ash-f-brand">Brand</label>
          <select id="ash-f-brand"></select>
        </div>
        <div class="filter-group">
          <div class="gran-toggle" id="ash-granToggle">
            <button type="button" class="gran-btn active" data-gran="daily">Daily</button>
            <button type="button" class="gran-btn" data-gran="weekly">Weekly</button>
          </div>
        </div>
        <div class="filter-group">
          <label for="ash-f-period" id="ash-periodLabel">Date</label>
          <select id="ash-f-period"></select>
        </div>
        <div class="filter-group" style="color:var(--text-muted); font-size:12px;" id="ash-filterNote"></div>
      </div>

      <div class="kpi-row" id="ash-kpiRow"></div>

      <div class="card">
        <h2 id="ash-tableTitle">Shift summary by agent</h2>
        <p class="card-sub" id="ash-cardSub"></p>
        <div class="heatmap-scroll">
          <table class="data-table" id="ash-dataTable">
            <thead><tr id="ash-tableHead"></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <p class="footnote" id="ash-tableFootnote"></p>
      </div>

      <div class="card">
        <h2>By day &mdash; heatmap</h2>
        <p class="card-sub" id="ash-heatmapSub"></p>
        <div class="card-controls">
          <div class="filter-group">
            <label for="ash-f-metric">Metric</label>
            <select id="ash-f-metric">
              <option value="busy">Total busy</option>
              <option value="break">Total break</option>
              <option value="offline">Total offline</option>
            </select>
          </div>
          <div class="legend" id="ash-heatmapLegend" style="margin:0;"></div>
        </div>
        <div class="heatmap-scroll">
          <table class="heatmap" id="ash-heatmapTable">
            <thead><tr id="ash-heatmapHead"></tr></thead>
            <tbody id="ash-heatmapBody"></tbody>
          </table>
        </div>
        <p class="footnote">Blank cells = no shift logged that day/week. Weekly cells are per-agent averages over the days worked that week.</p>
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

// ---------------- Agent wise analysis tab (shift-status export) ----------------
const AGENT_SHIFT_DATA = {AGENT_SHIFT_JSON};
(function() {{
const tooltip = document.getElementById('tooltip');

function hToLabel(min) {{
  if (min == null) return '–';
  const h = Math.floor(min / 60), m = Math.round(min - h * 60);
  if (h && m) return h + 'h ' + m + 'm';
  if (h) return h + 'h';
  return m + 'm';
}}
function minToClock(min) {{
  if (min == null) return '–';
  let h = Math.floor(min / 60), m = Math.round(min - h * 60);
  if (m === 60) {{ h += 1; m = 0; }}
  h = h % 24;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}}
function hexToRgb(hex) {{
  hex = hex.replace('#', '');
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

const METRIC_RAMPS = {{
  busy:    {{ light: '#e3f6e3', dark: '#0a7d0a', label: 'Total busy' }},
  break:   {{ light: '#fdf1d6', dark: '#c98500', label: 'Total break' }},
  offline: {{ light: '#fbdede', dark: '#b52f2f', label: 'Total offline' }},
}};

let currentBrand = Object.keys(AGENT_SHIFT_DATA)[0];
let currentGran = 'daily';
let currentPeriod = null;
let sortKey = 'busy_min';
let sortDir = -1;

function allDatesForBrand(brand) {{
  const set = new Set();
  AGENT_SHIFT_DATA[brand].forEach(a => a.days.forEach(d => set.add(d.date_sort)));
  return Array.from(set).sort();
}}
function allWeeksForBrand(brand) {{
  const set = new Set();
  AGENT_SHIFT_DATA[brand].forEach(a => a.days.forEach(d => set.add(d.week_start)));
  return Array.from(set).sort();
}}
function mostCommonLatestDate(brand) {{
  const counts = {{}};
  AGENT_SHIFT_DATA[brand].forEach(a => {{ if (a.days.length) counts[a.days[0].date_sort] = (counts[a.days[0].date_sort] || 0) + 1; }});
  let best = null, bestN = -1;
  Object.keys(counts).forEach(k => {{ if (counts[k] > bestN) {{ best = k; bestN = counts[k]; }} }});
  return best;
}}
function formatDateLabel(iso) {{
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', {{ day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' }});
}}
function formatWeekLabel(iso) {{
  const start = new Date(iso + 'T00:00:00');
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const opts = {{ day: 'numeric', month: 'short' }};
  return start.toLocaleDateString('en-IN', opts) + ' – ' + end.toLocaleDateString('en-IN', opts) + ', ' + start.getFullYear();
}}

// Builds one uniform row per agent for the selected period: a single day's
// figures in Daily mode, or the mean across that week's worked days in Weekly.
function rowFor(agent, period) {{
  if (currentGran === 'daily') {{
    const d = agent.days.find(x => x.date_sort === period);
    if (!d) return {{ agent, present: false }};
    return {{
      agent, present: true, days_worked: 1,
      login: d.login, logout: d.logout,
      busy_min: d.busy_min, break_min: d.break_min, offline_min: d.offline_min,
    }};
  }}
  const days = agent.days.filter(x => x.week_start === period);
  if (!days.length) return {{ agent, present: false }};
  const avg = key => days.reduce((s, x) => s + x[key], 0) / days.length;
  return {{
    agent, present: true, days_worked: days.length,
    login: minToClock(avg('login_min')), logout: minToClock(avg('logout_min')),
    busy_min: avg('busy_min'), break_min: avg('break_min'), offline_min: avg('offline_min'),
  }};
}}

function buildBrandSelect() {{
  const sel = document.getElementById('ash-f-brand');
  sel.innerHTML = Object.keys(AGENT_SHIFT_DATA).map(b =>
    `<option value="${{b}}"${{b === currentBrand ? ' selected' : ''}}>${{b}}</option>`
  ).join('');
  sel.addEventListener('change', () => {{
    currentBrand = sel.value;
    resetPeriod();
    buildPeriodSelect();
    render();
  }});
}}

function resetPeriod() {{
  if (currentGran === 'daily') {{
    currentPeriod = mostCommonLatestDate(currentBrand);
  }} else {{
    const weeks = allWeeksForBrand(currentBrand);
    currentPeriod = weeks[weeks.length - 1];
  }}
}}

function buildPeriodSelect() {{
  const sel = document.getElementById('ash-f-period');
  document.getElementById('ash-periodLabel').textContent = currentGran === 'daily' ? 'Date' : 'Week';
  if (currentGran === 'daily') {{
    const dates = allDatesForBrand(currentBrand).slice().reverse();
    sel.innerHTML = dates.map(d => `<option value="${{d}}"${{d === currentPeriod ? ' selected' : ''}}>${{formatDateLabel(d)}}</option>`).join('');
  }} else {{
    const weeks = allWeeksForBrand(currentBrand).slice().reverse();
    sel.innerHTML = weeks.map(w => `<option value="${{w}}"${{w === currentPeriod ? ' selected' : ''}}>${{formatWeekLabel(w)}}</option>`).join('');
  }}
}}

document.getElementById('ash-granToggle').querySelectorAll('.gran-btn').forEach(btn => {{
  btn.addEventListener('click', () => {{
    currentGran = btn.dataset.gran;
    document.querySelectorAll('#ash-granToggle .gran-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    resetPeriod();
    buildPeriodSelect();
    render();
  }});
}});

function sortRows(rows) {{
  rows.sort((r1, r2) => {{
    if (!r1.present && !r2.present) return r1.agent.name.localeCompare(r2.agent.name);
    if (!r1.present) return 1;
    if (!r2.present) return -1;
    if (sortKey === 'name') return sortDir * r1.agent.name.localeCompare(r2.agent.name);
    if (sortKey === 'login') return sortDir * r1.login.localeCompare(r2.login);
    return sortDir * ((r1[sortKey] ?? 0) - (r2[sortKey] ?? 0));
  }});
}}

const COLUMNS = [
  {{ key: 'name', label: 'Agent name' }},
  {{ key: 'login', label: 'Login time' }},
  {{ key: 'logout', label: 'Logout time' }},
  {{ key: 'break_min', label: 'Total break', num: true }},
  {{ key: 'offline_min', label: 'Total offline', num: true }},
  {{ key: 'busy_min', label: 'Total busy', num: true }},
];

function buildTableHead() {{
  const head = document.getElementById('ash-tableHead');
  const cols = COLUMNS.concat(currentGran === 'weekly' ? [{{ key: 'days_worked', label: 'Days', num: true }}] : []);
  head.innerHTML = cols.map(c => {{
    const arrow = sortKey === c.key ? `<span class="arrow">${{sortDir === 1 ? '▲' : '▼'}}</span>` : '';
    return `<th class="${{c.num ? 'num' : ''}}" data-key="${{c.key}}">${{c.label}}${{arrow}}</th>`;
  }}).join('');
  head.querySelectorAll('th').forEach(th => {{
    th.addEventListener('click', () => {{
      const key = th.dataset.key;
      if (sortKey === key) sortDir *= -1; else {{ sortKey = key; sortDir = key === 'name' || key === 'login' ? 1 : -1; }}
      render();
    }});
  }});
}}

function render() {{
  const agents = AGENT_SHIFT_DATA[currentBrand];
  const rows = agents.map(a => rowFor(a, currentPeriod));
  sortRows(rows);

  const present = rows.filter(r => r.present);
  const periodLabel = currentGran === 'daily' ? formatDateLabel(currentPeriod) : formatWeekLabel(currentPeriod);

  document.getElementById('ash-tableTitle').textContent = currentGran === 'daily' ? 'Shift summary by agent' : 'Weekly average by agent';
  document.getElementById('ash-cardSub').textContent = `${{periodLabel}} — ${{present.length}} of ${{rows.length}} agents ${{currentGran === 'daily' ? 'logged in' : 'with at least one shift'}}`;
  document.getElementById('ash-filterNote').textContent = currentGran === 'weekly' ? 'Numbers below are per-agent averages over days worked that week' : 'Applies to the summary and heatmap below';
  document.getElementById('ash-tableFootnote').textContent =
    'Login = first non-offline status of the day. Logout = last non-offline status end time. "Total busy" = time in the raw "Busy" status only (not Available). "Total offline" is every Offline segment logged that day, including time after logout until the next login.' +
    (currentGran === 'weekly' ? ' "Days" = how many days that week the agent had a logged shift, out of 7.' : '');

  const totalBusy = present.reduce((s, r) => s + r.busy_min, 0);
  const totalBreak = present.reduce((s, r) => s + r.break_min, 0);
  const totalOffline = present.reduce((s, r) => s + r.offline_min, 0);
  const sortedLogins = present.map(r => r.login).slice().sort();

  const kpis = [
    {{ label: currentGran === 'daily' ? 'Agents logged in' : 'Agents active this week', value: `${{present.length}}/${{rows.length}}`, sub: periodLabel }},
    {{ label: 'Median login time', value: sortedLogins.length ? sortedLogins[Math.floor(sortedLogins.length / 2)] : '–', sub: 'across active agents' }},
    {{ label: 'Avg busy time', value: present.length ? hToLabel(totalBusy / present.length) : '–', sub: currentGran === 'daily' ? `total ${{hToLabel(totalBusy)}}` : 'per agent, per active day' }},
    {{ label: 'Avg break time', value: present.length ? hToLabel(totalBreak / present.length) : '–', sub: currentGran === 'daily' ? `total ${{hToLabel(totalBreak)}}` : 'per agent, per active day' }},
    {{ label: 'Avg offline time', value: present.length ? hToLabel(totalOffline / present.length) : '–', sub: 'includes after-logout time' }},
  ];
  document.getElementById('ash-kpiRow').innerHTML = kpis.map(k =>
    `<div class="kpi"><div class="kpi-label">${{k.label}}</div><div class="kpi-value">${{k.value}}</div><div class="kpi-sub">${{k.sub}}</div></div>`
  ).join('');

  buildTableHead();
  const tbody = document.querySelector('#ash-dataTable tbody');
  tbody.innerHTML = '';
  rows.forEach(r => {{
    const tr = document.createElement('tr');
    if (!r.present) tr.className = 'absent';
    const nameTd = document.createElement('td');
    nameTd.className = 'name';
    nameTd.textContent = r.agent.name;
    tr.appendChild(nameTd);

    const cells = r.present
      ? [r.login, r.logout, hToLabel(r.break_min), hToLabel(r.offline_min), hToLabel(r.busy_min)]
      : ['–', '–', '–', '–', currentGran === 'daily' ? 'No shift logged' : 'No shift this week'];
    cells.forEach((c, i) => {{
      const td = document.createElement('td');
      if (i >= 2) td.className = 'num';
      if (!r.present && i === 4) {{ td.className = 'muted'; td.colSpan = 1; }}
      td.textContent = c;
      tr.appendChild(td);
    }});
    if (currentGran === 'weekly') {{
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = r.present ? (r.days_worked + '/7') : '0/7';
      tr.appendChild(td);
    }}
    tbody.appendChild(tr);
  }});

  renderHeatmap();
}}

function renderHeatmap() {{
  const metric = document.getElementById('ash-f-metric').value;
  const ramp = METRIC_RAMPS[metric];
  const metricKey = metric === 'busy' ? 'busy_min' : (metric === 'break' ? 'break_min' : 'offline_min');
  const agents = AGENT_SHIFT_DATA[currentBrand].slice().sort((a, b) => a.name.localeCompare(b.name));
  const periods = currentGran === 'daily' ? allDatesForBrand(currentBrand) : allWeeksForBrand(currentBrand);
  const labelFn = currentGran === 'daily'
    ? d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {{ day: 'numeric', month: 'short' }})
    : w => 'Wk ' + new Date(w + 'T00:00:00').toLocaleDateString('en-IN', {{ day: 'numeric', month: 'short' }});

  document.getElementById('ash-heatmapSub').textContent = `${{ramp.label}} per ${{currentGran === 'daily' ? 'day' : 'week'}}, by agent (${{currentBrand}})`;
  document.getElementById('ash-heatmapLegend').innerHTML =
    `<div class="legend-item"><span class="legend-swatch" style="background:${{ramp.light}};border:1px solid var(--border);"></span>Low</div>` +
    `<div class="legend-item"><span class="legend-swatch" style="background:${{ramp.dark}};"></span>High</div>`;

  // Precompute each agent's row values for all periods, and the max across
  // the grid, so the sequential ramp is scaled consistently across cells.
  const grid = agents.map(a => {{
    const cells = periods.map(p => {{
      const r = rowFor(a, p);
      return r.present ? r[metricKey] : null;
    }});
    return {{ name: a.name, cells }};
  }});
  const maxVal = Math.max(1, ...grid.flatMap(g => g.cells.filter(v => v != null)));

  const head = document.getElementById('ash-heatmapHead');
  head.innerHTML = `<th class="corner">Agent</th>` + periods.map(p => `<th>${{labelFn(p)}}</th>`).join('');

  const lightRgb = hexToRgb(ramp.light), darkRgb = hexToRgb(ramp.dark);
  const body = document.getElementById('ash-heatmapBody');
  body.innerHTML = grid.map(g => {{
    const cellsHtml = g.cells.map((v, i) => {{
      if (v == null) return '<td class="cell empty">&ndash;</td>';
      const t = Math.min(1, v / maxVal);
      const rgb = mixRgb(lightRgb, darkRgb, t);
      const lum = relLuminance(rgb);
      const textColor = lum > 0.45 ? '#0b0b0b' : '#ffffff';
      const periodLabel = currentGran === 'daily' ? formatDateLabel(periods[i]) : formatWeekLabel(periods[i]);
      return `<td class="cell" data-agent="${{g.name}}" data-period="${{periodLabel}}" data-val="${{hToLabel(v)}}" style="background:rgb(${{rgb.r}},${{rgb.g}},${{rgb.b}}); color:${{textColor}}">${{hToLabel(v)}}</td>`;
    }}).join('');
    return `<tr><td class="rowlabel" title="${{g.name}}">${{g.name}}</td>${{cellsHtml}}</tr>`;
  }}).join('');

  body.querySelectorAll('td.cell:not(.empty)').forEach(td => {{
    td.addEventListener('mousemove', (e) => {{
      tooltip.innerHTML = `<b>${{td.dataset.val}}</b> &middot; ${{td.dataset.agent}}, ${{td.dataset.period}}`;
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top = (e.clientY - 10) + 'px';
      tooltip.classList.add('show');
    }});
    td.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
  }});
}}

resetPeriod();
buildBrandSelect();
buildPeriodSelect();
render();
document.getElementById('ash-f-period').addEventListener('change', (e) => {{ currentPeriod = e.target.value; render(); }});
document.getElementById('ash-f-metric').addEventListener('change', renderHeatmap);
}})();

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

document.getElementById('f-brand').addEventListener('change', refreshAll);
document.getElementById('f-resolver').addEventListener('change', refreshAll);
document.getElementById('f-channel').addEventListener('change', refreshAll);
document.getElementById('f-word-brand').addEventListener('change', refreshWords);
document.getElementById('f-word-month').addEventListener('change', refreshWords);
window.addEventListener('resize', () => {{ refreshWords(); refreshAll(); }});

// Scoped to #main-tab-nav specifically - a plain .tab-btn selector here would also
// catch the Agent wise analysis tab's own brand sub-tabs (Hyphen/mCaffeine), which
// share the tab-btn class for styling but use data-brand, not data-tab; clicking one
// would resolve to getElementById('panel-undefined') -> null -> classList throws.
document.querySelectorAll('#main-tab-nav .tab-btn').forEach(function(b) {{
  b.addEventListener('click', function() {{
    document.querySelectorAll('#main-tab-nav .tab-btn').forEach(function(x) {{ x.classList.remove('active'); }});
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

// "Refresh data" button - dispatches .github/workflows/refresh-deepdive.yml (reruns
// build_csat_dashboard_data.py + build_agent_shift_status.py + build_csat_artifact.py,
// so BOTH tabs' data goes current, not just Agent wise analysis) via /api/refresh-deepdive,
// then polls /api/refresh-deepdive-status until it completes and reloads this page.
// Mirrors index.html's own "Refresh Data" button/polling pattern (that one only covers
// the mcaffeine/hyphen reports, not this one - see refresh.yml vs refresh-deepdive.yml).
var ddRefreshPollTimer = null;

function ddSetStatus(text, isError) {{
  var el = document.getElementById('dd-refresh-status');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}}

function ddSetBusy(busy) {{
  var btn = document.getElementById('dd-refresh-btn');
  btn.disabled = busy;
  btn.classList.toggle('spinning', busy);
}}

function ddFormatRefreshedAt(isoString) {{
  var d = new Date(isoString);
  return d.toLocaleString('en-IN', {{ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }});
}}

function ddShowLastRefreshed(statusResp) {{
  var el = document.getElementById('dd-last-refreshed');
  if (!statusResp || !statusResp.updated_at) {{ el.textContent = ''; return; }}
  var label = statusResp.status === 'completed' && statusResp.conclusion !== 'success' ? ' (with issues)' : '';
  el.textContent = 'Last refreshed: ' + ddFormatRefreshedAt(statusResp.updated_at) + label;
}}

function ddPollRefreshStatus() {{
  fetch('/api/refresh-deepdive-status').then(function(r) {{ return r.json(); }}).then(function(d) {{
    if (d.status === 'completed') {{
      clearInterval(ddRefreshPollTimer);
      ddRefreshPollTimer = null;
      ddSetBusy(false);
      ddShowLastRefreshed(d);
      if (d.conclusion === 'success') {{
        ddSetStatus('Refresh complete - reloading...');
        setTimeout(function() {{ location.reload(); }}, 1200);
      }} else {{
        ddSetStatus('Refresh finished with issues - see the workflow run for details.', true);
      }}
    }}
  }}).catch(function() {{ /* transient poll failure - next tick retries */ }});
}}

function ddTriggerRefresh() {{
  ddSetBusy(true);
  ddSetStatus('Starting refresh...');
  fetch('/api/refresh-deepdive', {{ method: 'POST' }})
    .then(function(r) {{ return r.json(); }})
    .then(function(d) {{
      if (d.status === 'started' || d.status === 'already_running') {{
        ddSetStatus(d.message);
        if (!ddRefreshPollTimer) ddRefreshPollTimer = setInterval(ddPollRefreshStatus, 10000);
      }} else {{
        ddSetBusy(false);
        ddSetStatus(d.message || 'Could not start refresh.', true);
      }}
    }})
    .catch(function() {{
      ddSetBusy(false);
      ddSetStatus('Could not reach the refresh service.', true);
    }});
}}

(function ddInitRefreshStatus() {{
  fetch('/api/refresh-deepdive-status').then(function(r) {{ return r.json(); }}).then(function(d) {{
    ddShowLastRefreshed(d);
    if (d.status === 'in_progress' || d.status === 'queued') {{
      ddSetBusy(true);
      ddSetStatus('Refreshing data... (' + d.status.replace('_', ' ') + ')');
      if (!ddRefreshPollTimer) ddRefreshPollTimer = setInterval(ddPollRefreshStatus, 10000);
    }}
  }}).catch(function() {{ /* no last-refreshed info available - leave it blank */ }});
}})();
</script>
"""

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
