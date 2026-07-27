'use client';

import { useEffect, useMemo, useState } from 'react';

const BAR_SERIES = [
  { key: 'assigned', label: 'Assigned', color: '#8b8d98' },
  { key: 'dialled', label: 'Dialled', color: '#2a78d6' },
];
const LINE_SERIES = [
  { key: 'connected', label: 'Connected', color: '#1a9c5c' },
  { key: 'reordered', label: 'Reordered', color: '#7c5cd6' },
  { key: 'refunded', label: 'Refunded', color: '#c2740c' },
];
const ALL_SERIES = [...BAR_SERIES, ...LINE_SERIES];

const DATE_OPTIONS = [
  { value: 'ALL_TIME', label: 'All time' },
  { value: 'TODAY', label: 'Today' },
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: '7_DAYS', label: 'Last 7 days' },
  { value: '30_DAYS', label: 'Last 30 days' },
  { value: 'CUSTOM', label: 'Custom range' },
];

// Uses the browser's own local date components (not toISOString(), which forces UTC and
// would misdate the early-morning IST hours - e.g. 2am IST is still the previous day in
// UTC) - correct as long as the agent's device clock/timezone is actually set to IST,
// which is the assumption the rest of this app already makes.
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Same preset set as app/rto-crm/RtoCrmClient.js's own date-scope selector, computed
// here as concrete from/to bounds sent to the server (this table can only be filtered
// by a real Postgres query, not by fetching everything and filtering client-side).
function resolveDateRange(scope, customFrom, customTo) {
  if (scope === 'ALL_TIME') return { dateFrom: null, dateTo: null };
  const today = new Date();
  if (scope === 'TODAY') { const t = isoDate(today); return { dateFrom: t, dateTo: t }; }
  if (scope === 'YESTERDAY') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    const t = isoDate(y);
    return { dateFrom: t, dateTo: t };
  }
  if (scope === '7_DAYS') {
    const from = new Date(today); from.setDate(from.getDate() - 6);
    return { dateFrom: isoDate(from), dateTo: isoDate(today) };
  }
  if (scope === '30_DAYS') {
    const from = new Date(today); from.setDate(from.getDate() - 29);
    return { dateFrom: isoDate(from), dateTo: isoDate(today) };
  }
  if (scope === 'CUSTOM') return { dateFrom: customFrom || null, dateTo: customTo || null };
  return { dateFrom: null, dateTo: null };
}

function formatHourLabel(hour) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h12}${ampm}`;
}

// Bars (Assigned/Dialled - the top-of-funnel volume) get their own scale, separate from
// the outcome lines (Connected/Reordered/Refunded), the same way this codebase's other
// combo charts (scripts/gen_panels.py's _build_combo_chart) scale a volume bar and a
// score/rate line independently rather than sharing one axis - Connected etc. are a
// fraction of Dialled, so a shared scale would flatten their line to near-zero.
// visibleSeries hides whichever series the checkboxes above have unchecked.
function HourlyChart({ hourly, visibleSeries }) {
  const barSeries = BAR_SERIES.filter((s) => visibleSeries[s.key]);
  const lineSeries = LINE_SERIES.filter((s) => visibleSeries[s.key]);
  const shownSeries = [...barSeries, ...lineSeries];

  const activeHours = hourly.filter((h) => shownSeries.some((s) => h[s.key] > 0));
  if (!shownSeries.length) {
    return <p className="co-loading">Pick at least one series above to show the chart.</p>;
  }
  if (!activeHours.length) {
    return <p className="co-loading">No hourly activity recorded yet.</p>;
  }

  const barMax = Math.max(1, ...activeHours.flatMap((h) => barSeries.map((s) => h[s.key])));
  const lineMax = Math.max(1, ...activeHours.flatMap((h) => lineSeries.map((s) => h[s.key])));

  const colWidth = 64;
  const plotTop = 28;
  const plotHeight = 190;
  const axisY = plotTop + plotHeight;
  const width = activeHours.length * colWidth;
  const height = axisY + 22;
  const barGap = 3;
  const barWidth = barSeries.length ? Math.min(16, Math.floor(40 / barSeries.length)) : 16;

  const linePoints = lineSeries.map((s) => ({
    ...s,
    points: activeHours.map((h, i) => ({
      x: i * colWidth + colWidth / 2,
      y: axisY - (h[s.key] / lineMax) * plotHeight,
      value: h[s.key],
    })),
  }));

  return (
    <div className="co-chart-scroll">
      <svg width={width} height={height} className="co-chart-svg">
        <line x1={0} y1={axisY} x2={width} y2={axisY} className="co-axis-line" />

        {activeHours.map((h, i) => {
          const cx = i * colWidth + colWidth / 2;
          const groupWidth = barSeries.length * barWidth + Math.max(0, barSeries.length - 1) * barGap;
          const groupStart = cx - groupWidth / 2;
          return (
            <g key={h.hour}>
              {barSeries.map((s, bi) => {
                const val = h[s.key];
                const barH = (val / barMax) * plotHeight;
                const x = groupStart + bi * (barWidth + barGap);
                const y = axisY - barH;
                return (
                  <g key={s.key}>
                    <rect x={x} y={y} width={barWidth} height={Math.max(barH, val > 0 ? 1 : 0)} fill={s.color} rx={2}>
                      <title>{`${s.label}: ${val.toLocaleString('en-IN')} at ${formatHourLabel(h.hour)}`}</title>
                    </rect>
                    {val > 0 && (
                      <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" className="co-data-label" fill={s.color}>
                        {val}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={cx} y={axisY + 16} textAnchor="middle" className="co-hour-label">
                {formatHourLabel(h.hour)}
              </text>
            </g>
          );
        })}

        {linePoints.map((s) => (
          <g key={s.key}>
            <polyline
              points={s.points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
            />
            {s.points.map((p, i) => (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r={3} fill={s.color}>
                  <title>{`${s.label}: ${p.value.toLocaleString('en-IN')} at ${formatHourLabel(activeHours[i].hour)}`}</title>
                </circle>
                {p.value > 0 && (
                  <text x={p.x} y={p.y - 7} textAnchor="middle" className="co-data-label" fill={s.color}>
                    {p.value}
                  </text>
                )}
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

// Generic grouped-bar-per-category chart, shared by the partner-wise and RTO-reason-wise
// breakdowns below - unlike HourlyChart, every series here shares one scale (a category's
// sub-counts, e.g. Customer Agreed to Accept, are a subset of its own total, so comparing
// them on the same axis is exactly the point).
function CategoryBarChart({ items, series }) {
  if (!items.length) {
    return <p className="co-loading">No data for this range yet.</p>;
  }
  const maxVal = Math.max(1, ...items.flatMap((it) => series.map((s) => it[s.key])));
  const colWidth = Math.max(70, series.length * 26);
  const plotTop = 20;
  const plotHeight = 190;
  const axisY = plotTop + plotHeight;
  const width = items.length * colWidth;
  const height = axisY + 46;
  const barGap = 3;
  const barWidth = Math.min(28, Math.floor((colWidth - 16) / series.length) - barGap);

  return (
    <div className="co-chart-scroll">
      <svg width={width} height={height} className="co-chart-svg">
        <line x1={0} y1={axisY} x2={width} y2={axisY} className="co-axis-line" />
        {items.map((it, i) => {
          const cx = i * colWidth + colWidth / 2;
          const groupWidth = series.length * barWidth + Math.max(0, series.length - 1) * barGap;
          const groupStart = cx - groupWidth / 2;
          return (
            <g key={it.label}>
              {series.map((s, si) => {
                const val = it[s.key];
                const barH = (val / maxVal) * plotHeight;
                const x = groupStart + si * (barWidth + barGap);
                const y = axisY - barH;
                return (
                  <g key={s.key}>
                    <rect x={x} y={y} width={barWidth} height={Math.max(barH, val > 0 ? 1 : 0)} fill={s.color} rx={2}>
                      <title>{`${s.label}: ${val.toLocaleString('en-IN')} (${it.label})`}</title>
                    </rect>
                    {val > 0 && (
                      <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" className="co-data-label" fill={s.color}>
                        {val}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={cx} y={axisY + 16} textAnchor="middle" className="co-hour-label co-category-label">
                <title>{it.label}</title>
                {it.label.length > 14 ? `${it.label.slice(0, 13)}…` : it.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function CallingOverviewClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [authed, setAuthed] = useState(false);
  const [dateScope, setDateScope] = useState('ALL_TIME');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [visibleSeries, setVisibleSeries] = useState(() =>
    Object.fromEntries(ALL_SERIES.map((s) => [s.key, true]))
  );

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (!d.authenticated) {
          window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
          return;
        }
        setAuthed(true);
      })
      .catch(() => {
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      });
  }, []);

  const { dateFrom, dateTo } = useMemo(
    () => resolveDateRange(dateScope, customFrom, customTo),
    [dateScope, customFrom, customTo]
  );

  useEffect(() => {
    if (!authed) return;
    setError(null);
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    const qs = params.toString();
    fetch(`/api/report/data/calling-overview${qs ? `?${qs}` : ''}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${r.status})`);
        }
        return r.json();
      })
      .then((json) => setData(json))
      .catch((e) => setError(e.message || 'Could not load Calling Team overview.'));
  }, [authed, dateFrom, dateTo]);

  const stats = data && data.stats;
  const hourly = data && data.hourly;
  const partnerItems = data && data.partnerBreakdown
    ? data.partnerBreakdown.map((p) => ({
        label: p.partner,
        totalDisposed: p.totalDisposed,
        customerAgreedToAccept: p.customerAgreedToAccept,
      }))
    : null;
  const rtoReasonItems = data && data.rtoReasonBreakdown
    ? data.rtoReasonBreakdown.map((r) => ({ label: r.rtoReason, total: r.total }))
    : null;

  const toggleSeries = (key) => {
    setVisibleSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="calling-overview-page">
      <header className="co-header">
        <h1>Calling Team — Overview</h1>
        <p className="co-sub">
          Lead assignment and disposition activity across the whole calling team, sourced
          from every agent&apos;s disposition history to date.
        </p>
      </header>

      <div className="co-filterbar">
        <div className="co-filter-group">
          <label htmlFor="co-date-scope">Date range</label>
          <select id="co-date-scope" value={dateScope} onChange={(e) => setDateScope(e.target.value)}>
            {DATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        {dateScope === 'CUSTOM' && (
          <div className="co-filter-group co-custom-range">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <span>to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        )}
      </div>

      {error && <p className="co-error">{error}</p>}
      {!error && !data && <p className="co-loading">Loading...</p>}

      {stats && (
        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-label">Total Assigned</div>
            <div className="kpi-value">{stats.totalAssigned.toLocaleString('en-IN')}</div>
            <div className="kpi-sub">Across all agents</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Total Disposed</div>
            <div className="kpi-value">{stats.totalDisposed.toLocaleString('en-IN')}</div>
            <div className="kpi-sub">Actioned leads</div>
          </div>
          <div className="kpi kpi-warn">
            <div className="kpi-label">Pending Queue</div>
            <div className="kpi-value">{stats.totalPending.toLocaleString('en-IN')}</div>
            <div className="kpi-sub">Awaiting action</div>
          </div>
          <div className="kpi kpi-good">
            <div className="kpi-label">Connect Rate</div>
            <div className="kpi-value">{stats.connectRate}%</div>
            <div className="kpi-sub">Call success</div>
          </div>
          <div className="kpi kpi-accent">
            <div className="kpi-label">Refunds</div>
            <div className="kpi-value">{stats.totalRefunded.toLocaleString('en-IN')}</div>
            <div className="kpi-sub">₹{stats.totalRefundAmount.toLocaleString('en-IN')}</div>
          </div>
        </div>
      )}

      {hourly && (
        <div className="co-chart-card">
          <h2>Hourly activity (by hour of day, IST)</h2>
          <p className="co-sub co-chart-sub">
            Every lead bucketed by the hour it was assigned or dialled. Assigned/Dialled are
            bars (left scale); Connected/Reordered/Refunded are lines (own scale).
          </p>
          <div className="co-chart-legend">
            {ALL_SERIES.map((s) => (
              <label className="co-legend-item" key={s.key}>
                <input
                  type="checkbox"
                  checked={visibleSeries[s.key]}
                  onChange={() => toggleSeries(s.key)}
                />
                <span className="co-legend-swatch" style={{ background: s.color }}></span>
                {s.label}
              </label>
            ))}
          </div>
          <HourlyChart hourly={hourly} visibleSeries={visibleSeries} />
        </div>
      )}

      {partnerItems && (
        <div className="co-chart-card">
          <h2>By delivery partner</h2>
          <p className="co-sub co-chart-sub">
            Total disposed leads vs. how many resulted in &quot;Customer Agreed to Accept&quot; per
            delivery partner (derived from AWB prefix), sorted by that count &mdash; answers which
            partner it&apos;s coming from most.
          </p>
          <div className="co-chart-legend">
            <span className="co-legend-item"><span className="co-legend-swatch" style={{ background: '#2a78d6' }}></span>Total Disposed</span>
            <span className="co-legend-item"><span className="co-legend-swatch" style={{ background: '#1a9c5c' }}></span>Customer Agreed to Accept</span>
          </div>
          <CategoryBarChart
            items={partnerItems}
            series={[
              { key: 'totalDisposed', label: 'Total Disposed', color: '#2a78d6' },
              { key: 'customerAgreedToAccept', label: 'Customer Agreed to Accept', color: '#1a9c5c' },
            ]}
          />
        </div>
      )}

      {rtoReasonItems && (
        <div className="co-chart-card">
          <h2>By RTO reason</h2>
          <p className="co-sub co-chart-sub">Lead volume per RTO reason, sorted highest first.</p>
          <CategoryBarChart
            items={rtoReasonItems}
            series={[{ key: 'total', label: 'Leads', color: '#c2740c' }]}
          />
        </div>
      )}
    </div>
  );
}
