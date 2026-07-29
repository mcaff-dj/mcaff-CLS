'use client';

import { useEffect, useState } from 'react';

const METRIC_RAMPS = {
  busy: { light: '#e3f6e3', dark: '#0a7d0a', label: 'Total busy' },
  break: { light: '#fdf1d6', dark: '#c98500', label: 'Total break' },
  offline: { light: '#fbdede', dark: '#b52f2f', label: 'Total offline' },
};

function hToLabel(min) {
  if (min == null) return '–';
  const h = Math.floor(min / 60), m = Math.round(min - h * 60);
  if (h && m) return h + 'h ' + m + 'm';
  if (h) return h + 'h';
  return m + 'm';
}
function minToClock(min) {
  if (min == null) return '–';
  let h = Math.floor(min / 60), m = Math.round(min - h * 60);
  if (m === 60) { h += 1; m = 0; }
  h = h % 24;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  const num = parseInt(hex, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function mixRgb(a, b, t) {
  return { r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) };
}
function relLuminance(rgb) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}
function formatDateLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' });
}
function formatWeekLabel(iso) {
  const start = new Date(iso + 'T00:00:00');
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const opts = { day: 'numeric', month: 'short' };
  return start.toLocaleDateString('en-IN', opts) + ' – ' + end.toLocaleDateString('en-IN', opts) + ', ' + start.getFullYear();
}

const COLUMNS = [
  { key: 'name', label: 'Agent name' },
  { key: 'login', label: 'Login time' },
  { key: 'logout', label: 'Logout time' },
  { key: 'break_min', label: 'Total break', num: true },
  { key: 'offline_min', label: 'Total offline', num: true },
  { key: 'busy_min', label: 'Total busy', num: true },
];

export default function AgentShiftTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/report/data/agent-shift-status')
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${r.status})`);
        }
        return r.json();
      })
      .then((json) => setData(json))
      .catch((e) => setError(e.message || 'Could not load shift-status data.'));
  }, []);

  // Faithful port of the IIFE at scripts/build_csat_artifact.py:684-984 - the exact same
  // imperative DOM-manipulation logic (module-level state -> component-scope state, no
  // rendering behavior changed), run once the data has arrived.
  useEffect(() => {
    if (!data) return;
    const AGENT_SHIFT_DATA = data;
    const tooltip = document.getElementById('tooltip');

    let currentBrand = Object.keys(AGENT_SHIFT_DATA)[0];
    let currentGran = 'daily';
    let currentPeriod = null;
    let sortKey = 'busy_min';
    let sortDir = -1;

    function allDatesForBrand(brand) {
      const set = new Set();
      AGENT_SHIFT_DATA[brand].forEach((a) => a.days.forEach((d) => set.add(d.date_sort)));
      return Array.from(set).sort();
    }
    function allWeeksForBrand(brand) {
      const set = new Set();
      AGENT_SHIFT_DATA[brand].forEach((a) => a.days.forEach((d) => set.add(d.week_start)));
      return Array.from(set).sort();
    }
    function mostCommonLatestDate(brand) {
      const counts = {};
      AGENT_SHIFT_DATA[brand].forEach((a) => { if (a.days.length) counts[a.days[0].date_sort] = (counts[a.days[0].date_sort] || 0) + 1; });
      let best = null, bestN = -1;
      Object.keys(counts).forEach((k) => { if (counts[k] > bestN) { best = k; bestN = counts[k]; } });
      return best;
    }

    function rowFor(agent, period) {
      if (currentGran === 'daily') {
        const d = agent.days.find((x) => x.date_sort === period);
        if (!d) return { agent, present: false };
        return {
          agent, present: true, days_worked: 1,
          login: d.login, logout: d.logout,
          busy_min: d.busy_min, break_min: d.break_min, offline_min: d.offline_min,
        };
      }
      const days = agent.days.filter((x) => x.week_start === period);
      if (!days.length) return { agent, present: false };
      const avg = (key) => days.reduce((s, x) => s + x[key], 0) / days.length;
      return {
        agent, present: true, days_worked: days.length,
        login: minToClock(avg('login_min')), logout: minToClock(avg('logout_min')),
        busy_min: avg('busy_min'), break_min: avg('break_min'), offline_min: avg('offline_min'),
      };
    }

    function buildBrandSelect() {
      const sel = document.getElementById('ash-f-brand');
      sel.innerHTML = Object.keys(AGENT_SHIFT_DATA).map((b) =>
        `<option value="${b}"${b === currentBrand ? ' selected' : ''}>${b}</option>`
      ).join('');
    }

    function resetPeriod() {
      if (currentGran === 'daily') {
        currentPeriod = mostCommonLatestDate(currentBrand);
      } else {
        const weeks = allWeeksForBrand(currentBrand);
        currentPeriod = weeks[weeks.length - 1];
      }
    }

    function buildPeriodSelect() {
      const sel = document.getElementById('ash-f-period');
      document.getElementById('ash-periodLabel').textContent = currentGran === 'daily' ? 'Date' : 'Week';
      if (currentGran === 'daily') {
        const dates = allDatesForBrand(currentBrand).slice().reverse();
        sel.innerHTML = dates.map((d) => `<option value="${d}"${d === currentPeriod ? ' selected' : ''}>${formatDateLabel(d)}</option>`).join('');
      } else {
        const weeks = allWeeksForBrand(currentBrand).slice().reverse();
        sel.innerHTML = weeks.map((w) => `<option value="${w}"${w === currentPeriod ? ' selected' : ''}>${formatWeekLabel(w)}</option>`).join('');
      }
    }

    function sortRows(rows) {
      rows.sort((r1, r2) => {
        if (!r1.present && !r2.present) return r1.agent.name.localeCompare(r2.agent.name);
        if (!r1.present) return 1;
        if (!r2.present) return -1;
        if (sortKey === 'name') return sortDir * r1.agent.name.localeCompare(r2.agent.name);
        if (sortKey === 'login') return sortDir * r1.login.localeCompare(r2.login);
        return sortDir * ((r1[sortKey] ?? 0) - (r2[sortKey] ?? 0));
      });
    }

    function buildTableHead() {
      const head = document.getElementById('ash-tableHead');
      const cols = COLUMNS.concat(currentGran === 'weekly' ? [{ key: 'days_worked', label: 'Days', num: true }] : []);
      head.innerHTML = cols.map((c) => {
        const arrow = sortKey === c.key ? `<span class="arrow">${sortDir === 1 ? '▲' : '▼'}</span>` : '';
        return `<th class="${c.num ? 'num' : ''}" data-key="${c.key}">${c.label}${arrow}</th>`;
      }).join('');
      head.querySelectorAll('th').forEach((th) => {
        th.addEventListener('click', () => {
          const key = th.dataset.key;
          if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = key === 'name' || key === 'login' ? 1 : -1; }
          render();
        });
      });
    }

    function render() {
      const agents = AGENT_SHIFT_DATA[currentBrand];
      const rows = agents.map((a) => rowFor(a, currentPeriod));
      sortRows(rows);

      const present = rows.filter((r) => r.present);
      const periodLabel = currentGran === 'daily' ? formatDateLabel(currentPeriod) : formatWeekLabel(currentPeriod);

      document.getElementById('ash-tableTitle').textContent = currentGran === 'daily' ? 'Shift summary by agent' : 'Weekly average by agent';
      document.getElementById('ash-cardSub').textContent = `${periodLabel} — ${present.length} of ${rows.length} agents ${currentGran === 'daily' ? 'logged in' : 'with at least one shift'}`;
      document.getElementById('ash-filterNote').textContent = currentGran === 'weekly' ? 'Numbers below are per-agent averages over days worked that week' : 'Applies to the summary and heatmap below';
      document.getElementById('ash-tableFootnote').textContent =
        'Login = first non-offline status of the day. Logout = last non-offline status end time. "Total busy" = time in the raw "Busy" status only (not Available). "Total offline" is every Offline segment logged that day, including time after logout until the next login.' +
        (currentGran === 'weekly' ? ' "Days" = how many days that week the agent had a logged shift, out of 7.' : '');

      const totalBusy = present.reduce((s, r) => s + r.busy_min, 0);
      const totalBreak = present.reduce((s, r) => s + r.break_min, 0);
      const totalOffline = present.reduce((s, r) => s + r.offline_min, 0);
      const sortedLogins = present.map((r) => r.login).slice().sort();

      const kpis = [
        { label: currentGran === 'daily' ? 'Agents logged in' : 'Agents active this week', value: `${present.length}/${rows.length}`, sub: periodLabel },
        { label: 'Median login time', value: sortedLogins.length ? sortedLogins[Math.floor(sortedLogins.length / 2)] : '–', sub: 'across active agents' },
        { label: 'Avg busy time', value: present.length ? hToLabel(totalBusy / present.length) : '–', sub: currentGran === 'daily' ? `total ${hToLabel(totalBusy)}` : 'per agent, per active day' },
        { label: 'Avg break time', value: present.length ? hToLabel(totalBreak / present.length) : '–', sub: currentGran === 'daily' ? `total ${hToLabel(totalBreak)}` : 'per agent, per active day' },
        { label: 'Avg offline time', value: present.length ? hToLabel(totalOffline / present.length) : '–', sub: 'includes after-logout time' },
      ];
      document.getElementById('ash-kpiRow').innerHTML = kpis.map((k) =>
        `<div class="kpi"><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div><div class="kpi-sub">${k.sub}</div></div>`
      ).join('');

      buildTableHead();
      const tbody = document.querySelector('#ash-dataTable tbody');
      tbody.innerHTML = '';
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        if (!r.present) tr.className = 'absent';
        const nameTd = document.createElement('td');
        nameTd.className = 'name';
        nameTd.textContent = r.agent.name;
        tr.appendChild(nameTd);

        const cells = r.present
          ? [r.login, r.logout, hToLabel(r.break_min), hToLabel(r.offline_min), hToLabel(r.busy_min)]
          : ['–', '–', '–', '–', currentGran === 'daily' ? 'No shift logged' : 'No shift this week'];
        cells.forEach((c, i) => {
          const td = document.createElement('td');
          if (i >= 2) td.className = 'num';
          if (!r.present && i === 4) { td.className = 'muted'; td.colSpan = 1; }
          td.textContent = c;
          tr.appendChild(td);
        });
        if (currentGran === 'weekly') {
          const td = document.createElement('td');
          td.className = 'num';
          td.textContent = r.present ? (r.days_worked + '/7') : '0/7';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });

      renderHeatmap();
    }

    function renderHeatmap() {
      const metric = document.getElementById('ash-f-metric').value;
      const ramp = METRIC_RAMPS[metric];
      const metricKey = metric === 'busy' ? 'busy_min' : (metric === 'break' ? 'break_min' : 'offline_min');
      const agents = AGENT_SHIFT_DATA[currentBrand].slice().sort((a, b) => a.name.localeCompare(b.name));
      const periods = currentGran === 'daily' ? allDatesForBrand(currentBrand) : allWeeksForBrand(currentBrand);
      const labelFn = currentGran === 'daily'
        ? (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        : (w) => 'Wk ' + new Date(w + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

      document.getElementById('ash-heatmapSub').textContent = `${ramp.label} per ${currentGran === 'daily' ? 'day' : 'week'}, by agent (${currentBrand})`;
      document.getElementById('ash-heatmapLegend').innerHTML =
        `<div class="legend-item"><span class="legend-swatch" style="background:${ramp.light};border:1px solid var(--border);"></span>Low</div>` +
        `<div class="legend-item"><span class="legend-swatch" style="background:${ramp.dark};"></span>High</div>`;

      const grid = agents.map((a) => {
        const cells = periods.map((p) => {
          const r = rowFor(a, p);
          return r.present ? r[metricKey] : null;
        });
        return { name: a.name, cells };
      });
      const maxVal = Math.max(1, ...grid.flatMap((g) => g.cells.filter((v) => v != null)));

      const head = document.getElementById('ash-heatmapHead');
      head.innerHTML = `<th class="corner">Agent</th>` + periods.map((p) => `<th>${labelFn(p)}</th>`).join('');

      const lightRgb = hexToRgb(ramp.light), darkRgb = hexToRgb(ramp.dark);
      const body = document.getElementById('ash-heatmapBody');
      body.innerHTML = grid.map((g) => {
        const cellsHtml = g.cells.map((v, i) => {
          if (v == null) return '<td class="cell empty">&ndash;</td>';
          const t = Math.min(1, v / maxVal);
          const rgb = mixRgb(lightRgb, darkRgb, t);
          const lum = relLuminance(rgb);
          const textColor = lum > 0.45 ? '#0b0b0b' : '#ffffff';
          const periodLabel = currentGran === 'daily' ? formatDateLabel(periods[i]) : formatWeekLabel(periods[i]);
          return `<td class="cell" data-agent="${g.name}" data-period="${periodLabel}" data-val="${hToLabel(v)}" style="background:rgb(${rgb.r},${rgb.g},${rgb.b}); color:${textColor}">${hToLabel(v)}</td>`;
        }).join('');
        return `<tr><td class="rowlabel" title="${g.name}">${g.name}</td>${cellsHtml}</tr>`;
      }).join('');

      body.querySelectorAll('td.cell:not(.empty)').forEach((td) => {
        td.addEventListener('mousemove', (e) => {
          tooltip.innerHTML = `<b>${td.dataset.val}</b> &middot; ${td.dataset.agent}, ${td.dataset.period}`;
          tooltip.style.left = e.clientX + 'px';
          tooltip.style.top = (e.clientY - 10) + 'px';
          tooltip.classList.add('show');
        });
        td.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
      });
    }

    const brandSelectEl = document.getElementById('ash-f-brand');
    const onBrandChange = () => {
      currentBrand = brandSelectEl.value;
      resetPeriod();
      buildPeriodSelect();
      render();
    };
    brandSelectEl.addEventListener('change', onBrandChange);

    const granButtons = Array.from(document.getElementById('ash-granToggle').querySelectorAll('.gran-btn'));
    const onGranClick = (btn) => () => {
      currentGran = btn.dataset.gran;
      granButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      resetPeriod();
      buildPeriodSelect();
      render();
    };
    granButtons.forEach((btn) => btn.addEventListener('click', onGranClick(btn)));

    const periodSelectEl = document.getElementById('ash-f-period');
    const onPeriodChange = (e) => { currentPeriod = e.target.value; render(); };
    periodSelectEl.addEventListener('change', onPeriodChange);

    const metricSelectEl = document.getElementById('ash-f-metric');
    metricSelectEl.addEventListener('change', renderHeatmap);

    resetPeriod();
    buildBrandSelect();
    buildPeriodSelect();
    render();

    return () => {
      brandSelectEl.removeEventListener('change', onBrandChange);
      granButtons.forEach((btn) => btn.removeEventListener('click', onGranClick(btn)));
      periodSelectEl.removeEventListener('change', onPeriodChange);
      metricSelectEl.removeEventListener('change', renderHeatmap);
    };
  }, [data]);

  if (error) return <p className="dd-error">{error}</p>;
  if (!data) return <p className="card-sub">Loading...</p>;

  return (
    <>
      <p className="card-sub" style={{ margin: '0 0 16px' }}>From the daily agent-status export (Hyphen &amp; mCaffeine).</p>

      <div className="filterbar">
        <div className="filter-group">
          <label htmlFor="ash-f-brand">Brand</label>
          <select id="ash-f-brand"></select>
        </div>
        <div className="filter-group">
          <div className="gran-toggle" id="ash-granToggle">
            <button type="button" className="gran-btn active" data-gran="daily">Daily</button>
            <button type="button" className="gran-btn" data-gran="weekly">Weekly</button>
          </div>
        </div>
        <div className="filter-group">
          <label htmlFor="ash-f-period" id="ash-periodLabel">Date</label>
          <select id="ash-f-period"></select>
        </div>
        <div className="filter-group dd-muted-note" id="ash-filterNote"></div>
      </div>

      <div className="kpi-row" id="ash-kpiRow"></div>

      <div className="card">
        <h2 id="ash-tableTitle">Shift summary by agent</h2>
        <p className="card-sub" id="ash-cardSub"></p>
        <div className="heatmap-scroll">
          <table className="data-table" id="ash-dataTable">
            <thead><tr id="ash-tableHead"></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <p className="footnote" id="ash-tableFootnote"></p>
      </div>

      <div className="card">
        <h2>By day &mdash; heatmap</h2>
        <p className="card-sub" id="ash-heatmapSub"></p>
        <div className="card-controls">
          <div className="filter-group">
            <label htmlFor="ash-f-metric">Metric</label>
            <select id="ash-f-metric">
              <option value="busy">Total busy</option>
              <option value="break">Total break</option>
              <option value="offline">Total offline</option>
            </select>
          </div>
          <div className="legend" id="ash-heatmapLegend" style={{ margin: 0 }}></div>
        </div>
        <div className="heatmap-scroll">
          <table className="heatmap" id="ash-heatmapTable">
            <thead><tr id="ash-heatmapHead"></tr></thead>
            <tbody id="ash-heatmapBody"></tbody>
          </table>
        </div>
        <p className="footnote">Blank cells = no shift logged that day/week. Weekly cells are per-agent averages over the days worked that week.</p>
      </div>
    </>
  );
}
