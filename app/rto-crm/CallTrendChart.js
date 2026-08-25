'use client';

// Call Trend chart - sits under the Overview tab's Time-of-Day Distribution table. Dialled and
// Connects as grouped bars on the left axis, Converted as a line on its OWN right axis: on this
// desk converted runs ~10-15% of dialled (262 against 2402 on 2026-08-25), so a shared axis
// would flatten it onto the baseline and hide exactly the movement this chart exists to show.
//
// Hand-rolled SVG rather than a charting library: the only runtime dependency in package.json
// anywhere near this is canvas-confetti, and recharts would add ~500KB to the bundle for one
// card. The arithmetic that would justify a library (nice axis ceilings, week/month roll-up,
// gap filling) lives in api/_lib/trendChart.js, which node tests directly - trendChart.test.js.
import { useState, useEffect, useMemo, useCallback } from 'react';
import { CustomSelect, MultiSelectDropdown } from '../_calling/ui';
import { buildSeries, niceMax, axisTicks } from '../../api/_lib/trendChart';

const SERIES = [
  { key: 'dialled', label: 'Total Dialled', color: '#6366f1' },    // indigo-500
  { key: 'connected', label: 'Total Connects', color: '#22d3ee' }, // cyan-400
];
const CONVERTED_COLOR = '#f59e0b'; // amber-500 - the accent the table above already uses

// IST day key. The server buckets in IST (CONVERT_TZ in getCallingCallTrend), so the range the
// user picks has to be expressed in the same day the data was bucketed into, not the browser's.
function istDayKey(date) {
  const ist = new Date(date.getTime() + (5.5 * 60 + date.getTimezoneOffset()) * 60000);
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
}
function daysAgoKey(n) {
  return istDayKey(new Date(Date.now() - n * 86400000));
}

// Default window per grain: enough buckets to read a trend, few enough to stay legible at this
// width. Month is capped by the data anyway - CLS_RTO_calling only starts 2026-07-24.
const DEFAULT_SPAN_DAYS = { day: 13, week: 55, month: 364 };

export default function CallTrendChart({ agents = [], defaultAgents = null, canFilterAgents = true }) {
  const [grain, setGrain] = useState('day');
  const [from, setFrom] = useState(() => daysAgoKey(DEFAULT_SPAN_DAYS.day));
  const [to, setTo] = useState(() => daysAgoKey(0));
  const [picked, setPicked] = useState(() => defaultAgents || []);
  const [daily, setDaily] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(null);

  // Switching grain re-picks the window rather than keeping a 14-day range under a Monthly
  // view, which would draw one lonely bar and read as "no data".
  const changeGrain = useCallback((g) => {
    setGrain(g);
    setFrom(daysAgoKey(DEFAULT_SPAN_DAYS[g] ?? DEFAULT_SPAN_DAYS.day));
    setTo(daysAgoKey(0));
  }, []);

  const agentParam = picked.join(',');
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Plain day keys, no time part: dateBounds() server-side already widens dateTo to
    // 23:59:59.999 IST, and appending our own would make the string unparseable.
    const qs = new URLSearchParams({ dateFrom: from, dateTo: to });
    if (agentParam) qs.set('agents', agentParam);
    fetch(`/api/report/data/calling-trend?${qs}`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`)))))
      .then((d) => { if (!cancelled) { setDaily(d.daily || []); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load trend'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, agentParam]);

  const series = useMemo(() => buildSeries(daily, grain, from, to), [daily, grain, from, to]);
  const hasData = series.some((b) => b.dialled || b.connected || b.converted);

  // Two independent ceilings - that is the whole point of the secondary axis.
  const leftMax = niceMax(Math.max(0, ...series.map((b) => Math.max(b.dialled, b.connected))));
  const rightMax = niceMax(Math.max(0, ...series.map((b) => b.converted)));
  const leftTicks = axisTicks(leftMax, 4);
  const rightTicks = axisTicks(rightMax, 4);

  // viewBox coordinates, not pixels: the SVG scales to its container, so the chart stays
  // readable on a narrow screen without a resize listener.
  const W = 900;
  const H = 260;
  const PAD = { t: 12, r: 46, b: 34, l: 44 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const n = Math.max(1, series.length);
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(18, slot * 0.28));
  const yL = (v) => PAD.t + plotH - (v / leftMax) * plotH;
  const yR = (v) => PAD.t + plotH - (v / rightMax) * plotH;
  const cx = (i) => PAD.l + slot * i + slot / 2;
  const linePath = series.map((b, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${yR(b.converted).toFixed(1)}`).join(' ');
  // Cap at ~12 x labels: past that they overlap into an unreadable smear, so drop every kth.
  const labelStep = Math.ceil(n / 12);

  return (
    <div className="bg-[#111113] border border-zinc-800/80 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">📈 Call Trend</h3>
        <div className="flex flex-wrap items-center gap-2">
          <CustomSelect
            value={grain}
            onChange={changeGrain}
            options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]}
          />
          <input
            type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[13px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
          />
          <span className="text-zinc-600 text-xs">to</span>
          <input
            type="date" value={to} min={from} max={daysAgoKey(0)} onChange={(e) => setTo(e.target.value)}
            className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[13px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
          />
          {canFilterAgents && (
            <MultiSelectDropdown
              value={picked}
              onChange={setPicked}
              options={agents}
              placeholder="All agents"
              itemNoun="agents"
            />
          )}
        </div>
      </div>
      <p className="text-[11px] text-zinc-500 mb-3">
        Counted on the date each lead was DISPOSED, in IST - the same three definitions as the table above.
        Converted sits on its own right-hand axis, so its shape stays readable next to a much larger dialled count.
      </p>

      {error ? (
        <p className="text-[12px] text-rose-400 py-8 text-center">{error}</p>
      ) : loading ? (
        <p className="text-[12px] text-zinc-500 py-8 text-center">Loading…</p>
      ) : !hasData ? (
        <p className="text-[12px] text-zinc-500 py-8 text-center">No calls disposed in this range.</p>
      ) : (
        <>
          <div className="flex items-center gap-4 mb-2 text-[11px]">
            {SERIES.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-zinc-400">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span className="h-0.5 w-4 rounded-full" style={{ background: CONVERTED_COLOR }} />Total Converted (right axis)
            </span>
          </div>

          <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 260 }} role="img" aria-label="Call trend">
              {leftTicks.map((t) => (
                <g key={`g${t}`}>
                  <line x1={PAD.l} x2={W - PAD.r} y1={yL(t)} y2={yL(t)} stroke="#27272a" strokeWidth="1" />
                  <text x={PAD.l - 6} y={yL(t) + 3} textAnchor="end" fontSize="9" fill="#71717a">{Math.round(t)}</text>
                </g>
              ))}
              {rightTicks.map((t) => (
                <text key={`r${t}`} x={W - PAD.r + 6} y={yR(t) + 3} fontSize="9" fill={CONVERTED_COLOR}>{Math.round(t)}</text>
              ))}

              {series.map((b, i) => (
                <g
                  key={b.bucket}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                >
                  {/* Full-height catcher so the tooltip follows the whole column, not just the bars */}
                  <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={plotH} fill="transparent" />
                  {hover === i && <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={plotH} fill="#ffffff" opacity="0.04" />}
                  {SERIES.map((s, si) => (
                    <rect
                      key={s.key}
                      x={cx(i) - barW - 1 + si * (barW + 2)}
                      y={yL(b[s.key])}
                      width={barW}
                      height={Math.max(0, PAD.t + plotH - yL(b[s.key]))}
                      fill={s.color}
                      rx="1.5"
                    />
                  ))}
                  {i % labelStep === 0 && (
                    <text x={cx(i)} y={H - 12} textAnchor="middle" fontSize="9" fill="#71717a">{b.label}</text>
                  )}
                </g>
              ))}

              <path d={linePath} fill="none" stroke={CONVERTED_COLOR} strokeWidth="2" strokeLinejoin="round" />
              {series.map((b, i) => (
                <circle key={`d${b.bucket}`} cx={cx(i)} cy={yR(b.converted)} r={hover === i ? 3.5 : 2.5} fill={CONVERTED_COLOR} />
              ))}
            </svg>

            {hover !== null && series[hover] && (
              // Positioned in percent of the plot area rather than pixels, so it tracks the
              // column at any container width - the SVG itself is scaled by its viewBox.
              <div
                className="absolute -translate-x-1/2 -translate-y-full pointer-events-none bg-[#18181b] border border-zinc-700 rounded-lg px-2.5 py-1.5 text-[11px] shadow-xl whitespace-nowrap"
                style={{ left: `${(cx(hover) / W) * 100}%`, top: '28%' }}
              >
                <div className="font-semibold text-zinc-200 mb-0.5">{series[hover].label}</div>
                {SERIES.map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5 text-zinc-400">
                    <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                    {s.label}: <span className="text-zinc-200 font-medium">{series[hover][s.key]}</span>
                  </div>
                ))}
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: CONVERTED_COLOR }} />
                  Converted: <span className="text-zinc-200 font-medium">{series[hover].converted}</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
