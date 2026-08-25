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
//
// Motion follows the Apple house style: one shared easing curve, entry that grows from the
// baseline the bars actually sit on, and every animation suppressed under prefers-reduced-motion.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MultiSelectDropdown } from '../_calling/ui';
import { buildSeries, niceMax, axisTicks } from '../../api/_lib/trendChart';

// indigo-500/cyan-600 rather than the lighter 400-shade this card used when it had a near-black
// background: this app carries one theme only (see globals.css's "One theme, always"), and a
// pastel 400 shade drawn on white - especially as small bold value-label text - reads as low
// contrast rather than as an accent color.
const SERIES = [
  { key: 'dialled', label: 'Total Dialled', color: '#6366f1', grad: 'ctDialled' },  // indigo-500
  { key: 'connected', label: 'Total Connects', color: '#0891b2', grad: 'ctConnect' }, // cyan-600
];
const CONVERTED_COLOR = '#f59e0b'; // amber-500 - the accent the table above already uses
const GRAINS = [{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }];

// IST day key. The server buckets in IST (CONVERT_TZ in getCallingCallTrend), so the range the
// user picks has to be expressed in the same day the data was bucketed into, not the browser's.
function istDayKey(date) {
  const ist = new Date(date.getTime() + (5.5 * 60 + date.getTimezoneOffset()) * 60000);
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
}
function daysAgoKey(n) {
  return istDayKey(new Date(Date.now() - n * 86400000));
}
const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : '--');
const compact = (n) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString('en-IN'));

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
  const svgRef = useRef(null);

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
  const totals = useMemo(() => series.reduce(
    (a, b) => ({ dialled: a.dialled + b.dialled, connected: a.connected + b.connected, converted: a.converted + b.converted }),
    { dialled: 0, connected: 0, converted: 0 },
  ), [series]);

  // Two independent ceilings - that is the whole point of the secondary axis.
  const leftMax = niceMax(Math.max(0, ...series.map((b) => Math.max(b.dialled, b.connected))));
  const rightMax = niceMax(Math.max(0, ...series.map((b) => b.converted)));
  const leftTicks = axisTicks(leftMax, 4);
  const rightTicks = axisTicks(rightMax, 4);

  // viewBox coordinates, not pixels: the SVG scales to its container, so the chart stays
  // readable on a narrow screen without a resize listener.
  const W = 900;
  const H = 280;
  const PAD = { t: 20, r: 52, b: 38, l: 50 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const n = Math.max(1, series.length);
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(20, slot * 0.3));
  const base = PAD.t + plotH;
  const yL = (v) => base - (v / leftMax) * plotH;
  const yR = (v) => base - (v / rightMax) * plotH;
  const cx = (i) => PAD.l + slot * i + slot / 2;
  const pts = series.map((b, i) => `${cx(i).toFixed(1)},${yR(b.converted).toFixed(1)}`);
  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p}`).join(' ');
  // Area sits under the converted line only when there is more than one point to enclose.
  const areaPath = pts.length > 1 ? `${linePath} L${cx(n - 1).toFixed(1)},${base} L${cx(0).toFixed(1)},${base} Z` : '';
  // Cap at ~12 x labels: past that they overlap into an unreadable smear, so drop every kth.
  const labelStep = Math.ceil(n / 12);
  // Value labels on top of the bars only survive at low bucket counts - past ~10 columns the
  // numbers collide with their neighbours and the chart reads as noise.
  const showBarValues = n <= 10;
  const showPointValues = n <= 16;
  // Remounting on this key restarts the entry animation whenever the data set actually changes,
  // which is what makes a grain switch or a date change read as a redraw rather than a swap.
  const animKey = `${grain}|${from}|${to}|${agentParam}|${n}`;

  // Hover follows the pointer across the whole plot instead of per-column mouseenter: one
  // listener, and the highlighted column tracks continuously rather than firing at each edge.
  const trackPointer = useCallback((e) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r?.width) return;
    const x = ((e.clientX - r.left) / r.width) * W - PAD.l;
    const i = Math.floor(x / slot);
    setHover(x >= 0 && i >= 0 && i < n ? i : null);
  }, [slot, n, PAD.l]);

  const h = hover !== null ? series[hover] : null;
  // Flip the tooltip to the other side of the column near the edges so it never clips out of
  // the card, and keep the vertical anchor above the tallest mark in that column.
  const hoverPct = h ? (cx(hover) / W) * 100 : 0;
  const hoverSide = hoverPct > 78 ? -100 : hoverPct < 22 ? 0 : -50;

  return (
    // bg-zinc-900/60 + rounded-xl, not the bg-[#111113]/rounded-2xl this card shipped with - an
    // arbitrary hex literal is invisible to globals.css's light-theme overrides (they match
    // .bg-zinc-900/60 etc by class name), so this card was the one surface on the page that
    // stayed permanently dark. Every sibling card on this tab already uses this exact class.
    <div className="relative bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-5 overflow-hidden">
      <style>{`
        @keyframes ct-grow { from { transform: scaleY(0); opacity: .35 } to { transform: scaleY(1); opacity: 1 } }
        @keyframes ct-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
        @keyframes ct-pop { from { transform: scale(0); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        @keyframes ct-rise { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes ct-fade { from { opacity: 0 } to { opacity: 1 } }
        /* One easing curve for the whole card - Apple's standard "ease out, settle late" ramp. */
        .ct-bar { transform-box: fill-box; transform-origin: bottom; animation: ct-grow .62s cubic-bezier(.32,.72,0,1) both }
        .ct-line { animation: ct-draw .9s cubic-bezier(.32,.72,0,1) both }
        .ct-dot { transform-box: fill-box; transform-origin: center; animation: ct-pop .4s cubic-bezier(.32,.72,0,1) both }
        .ct-area { animation: ct-rise .8s cubic-bezier(.32,.72,0,1) both }
        .ct-tip { animation: ct-fade .18s cubic-bezier(.32,.72,0,1) both }
        .ct-num { animation: ct-fade .35s cubic-bezier(.32,.72,0,1) .45s both }
        .ct-tile { animation: ct-rise .5s cubic-bezier(.32,.72,0,1) both }
        .ct-bar rect, .ct-swatch { transition: opacity .22s cubic-bezier(.32,.72,0,1) }
        .ct-seg { transition: transform .42s cubic-bezier(.32,.72,0,1) }
        @media (prefers-reduced-motion: reduce) {
          .ct-bar, .ct-line, .ct-dot, .ct-area, .ct-tip, .ct-tile, .ct-seg, .ct-num { animation: none !important; transition: none !important }
        }
      `}</style>
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-zinc-100 tracking-[-0.01em] flex items-center gap-2">
            <span className="grid place-items-center h-6 w-6 rounded-lg bg-indigo-500/15 text-[12px]">📈</span>
            Call Trend
          </h3>
          <p className="text-[11px] leading-relaxed text-zinc-500 mt-1 max-w-2xl">
            Counted on the date each lead was DISPOSED, in IST - the same three definitions as the table above.
            Converted sits on its own right-hand axis, so its shape stays readable next to a much larger dialled count.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Segmented control rather than a dropdown: three fixed options, all worth seeing at
              once, and the sliding pill shows which way the switch moved. */}
          <div className="relative flex items-center h-8 p-0.5 rounded-[10px] bg-zinc-900/80 border border-zinc-800">
            {/* The sliding pill needs its own light-appropriate color: bg-zinc-700 has no
                light-theme override anywhere in globals.css (only its :hover variant does), so
                left as the plain Tailwind class it would stay dark-gray-on-white forever. */}
            <div
              className="ct-seg absolute top-0.5 bottom-0.5 left-0.5 rounded-lg bg-white shadow-sm ring-1 ring-black/5"
              style={{ width: `calc((100% - 4px) / ${GRAINS.length})`, transform: `translateX(${GRAINS.findIndex((g) => g.value === grain) * 100}%)` }}
            />
            {GRAINS.map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => changeGrain(g.value)}
                aria-pressed={grain === g.value}
                className={`relative z-10 px-3 h-7 rounded-lg text-[12px] font-medium active:scale-[.97] ${grain === g.value ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <input
            type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            style={{ colorScheme: 'light' }}
            className="h-8 px-2 bg-zinc-900/80 border border-zinc-800 rounded-[10px] text-[12px] text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
          />
          <span className="text-zinc-600 text-xs">to</span>
          <input
            type="date" value={to} min={from} max={daysAgoKey(0)} onChange={(e) => setTo(e.target.value)}
            style={{ colorScheme: 'light' }}
            className="h-8 px-2 bg-zinc-900/80 border border-zinc-800 rounded-[10px] text-[12px] text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
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

      {error ? (
        <p className="text-[12px] text-rose-400 py-12 text-center">{error}</p>
      ) : loading ? (
        <div className="py-12 grid place-items-center gap-2">
          <span className="h-5 w-5 rounded-full border-2 border-zinc-200 border-t-indigo-500 animate-spin" />
          <p className="text-[12px] text-zinc-500">Loading trend…</p>
        </div>
      ) : !hasData ? (
        <p className="text-[12px] text-zinc-500 py-12 text-center">No calls disposed in this range.</p>
      ) : (
        <>
          {/* Totals for the visible window. The chart shows shape; these show size, which is the
              first question anyone asks of a trend and used to need the table above to answer. */}
          <div className="relative grid grid-cols-3 gap-2 mt-4">
            {[
              { label: 'Total Dialled', value: totals.dialled, sub: `${(totals.dialled / n).toFixed(0)} avg / ${grain}`, color: SERIES[0].color },
              { label: 'Total Connects', value: totals.connected, sub: `${pct(totals.connected, totals.dialled)} of dialled`, color: SERIES[1].color },
              { label: 'Total Converted', value: totals.converted, sub: `${pct(totals.converted, totals.connected)} of connects`, color: CONVERTED_COLOR },
            ].map((t, i) => (
              <div
                key={t.label}
                className="ct-tile rounded-xl bg-zinc-900/60 border border-zinc-800/70 px-3 py-2.5"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-zinc-500">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
                  {t.label}
                </div>
                <div className="text-[19px] font-semibold text-zinc-100 tracking-[-0.02em] tabular-nums leading-tight mt-0.5">
                  {t.value.toLocaleString('en-IN')}
                </div>
                <div className="text-[10.5px] text-zinc-500 tabular-nums">{t.sub}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-4 mt-4 mb-1 text-[11px]">
            {SERIES.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-zinc-400">
                <span className="ct-swatch h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />{s.label}
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span className="h-0.5 w-4 rounded-full" style={{ background: CONVERTED_COLOR }} />Total Converted (right axis)
            </span>
          </div>

          <div className="relative">
            <svg
              ref={svgRef}
              key={animKey}
              viewBox={`0 0 ${W} ${H}`}
              className="w-full"
              style={{ height: 280 }}
              role="img"
              aria-label={`Call trend, ${n} ${grain} buckets: ${totals.dialled} dialled, ${totals.connected} connected, ${totals.converted} converted`}
              onPointerMove={trackPointer}
              onPointerLeave={() => setHover(null)}
            >
              <defs>
                {SERIES.map((s) => (
                  <linearGradient key={s.grad} id={s.grad} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity="1" />
                    <stop offset="100%" stopColor={s.color} stopOpacity="0.42" />
                  </linearGradient>
                ))}
                <linearGradient id="ctArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CONVERTED_COLOR} stopOpacity="0.26" />
                  <stop offset="100%" stopColor={CONVERTED_COLOR} stopOpacity="0" />
                </linearGradient>
                <filter id="ctGlow" x="-30%" y="-60%" width="160%" height="220%">
                  <feGaussianBlur stdDeviation="3.2" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>

              {/* Axis titles: the two scales differ by an order of magnitude, so which number
                  belongs to which side has to be stated, not inferred from the colours. */}
              <text x={14} y={PAD.t + plotH / 2} fontSize="8.5" fill="#52525b" letterSpacing="1.2" textAnchor="middle" transform={`rotate(-90 14 ${PAD.t + plotH / 2})`}>CALLS</text>
              <text x={W - 12} y={PAD.t + plotH / 2} fontSize="8.5" fill={CONVERTED_COLOR} fillOpacity="0.6" letterSpacing="1.2" textAnchor="middle" transform={`rotate(90 ${W - 12} ${PAD.t + plotH / 2})`}>CONVERTED</text>

              {leftTicks.map((t, i) => (
                <g key={`g${t}`}>
                  {/* Light-appropriate grid grays - the original #3f3f46/#27272a pair was tuned
                      for a near-black card and reads as heavy near-black bars on white. */}
                  <line
                    x1={PAD.l} x2={W - PAD.r} y1={yL(t)} y2={yL(t)}
                    stroke={i === 0 ? '#cbd5e1' : '#e2e8f0'} strokeWidth="1"
                    strokeDasharray={i === 0 ? undefined : '3 5'}
                  />
                  <text x={PAD.l - 8} y={yL(t) + 3} textAnchor="end" fontSize="9" fill="#71717a" className="tabular-nums">{compact(Math.round(t))}</text>
                </g>
              ))}
              {rightTicks.map((t) => (
                <text key={`r${t}`} x={W - PAD.r + 8} y={yR(t) + 3} fontSize="9" fill={CONVERTED_COLOR} fillOpacity="0.75">{compact(Math.round(t))}</text>
              ))}

              {/* Hover column sits under the marks so it reads as a lit backdrop, not an overlay.
                  Dark tint, not the original white-on-near-black wash - on a white card a white
                  fill/stroke is invisible, so this needs the opposite tone entirely. */}
              {hover !== null && (
                <>
                  <rect x={PAD.l + slot * hover} y={PAD.t} width={slot} height={plotH} fill="#0f172a" opacity="0.04" rx="6" />
                  <line x1={cx(hover)} x2={cx(hover)} y1={PAD.t} y2={base} stroke="#0f172a" strokeOpacity="0.14" strokeWidth="1" strokeDasharray="2 4" />
                </>
              )}

              {areaPath && <path className="ct-area" d={areaPath} fill="url(#ctArea)" />}

              {series.map((b, i) => (
                <g key={b.bucket} className="ct-bar" style={{ animationDelay: `${Math.min(i * 26, 420)}ms` }}>
                  {SERIES.map((s, si) => {
                    const y = yL(b[s.key]);
                    return (
                      <rect
                        key={s.key}
                        x={cx(i) - barW - 1 + si * (barW + 2)}
                        y={y}
                        width={barW}
                        height={Math.max(0, base - y)}
                        fill={`url(#${s.grad})`}
                        rx={Math.min(3, barW / 2)}
                        opacity={hover === null || hover === i ? 1 : 0.32}
                      />
                    );
                  })}
                </g>
              ))}

              {/* Bar value labels ride outside the animated group so they land at full size. */}
              {showBarValues && series.map((b, i) => SERIES.map((s, si) => (
                b[s.key] > 0 ? (
                  <text
                    key={`${b.bucket}-${s.key}`}
                    className="ct-num"
                    x={cx(i) - barW - 1 + si * (barW + 2) + barW / 2}
                    y={yL(b[s.key]) - 5}
                    textAnchor="middle" fontSize="8.5" fontWeight="600" fill={s.color}
                    fillOpacity={hover === null || hover === i ? 0.9 : 0.28}
                  >{compact(b[s.key])}</text>
                ) : null
              )))}

              {areaPath && (
                <path
                  className="ct-line" d={linePath} pathLength="1" strokeDasharray="1"
                  fill="none" stroke={CONVERTED_COLOR} strokeWidth="2.25"
                  strokeLinejoin="round" strokeLinecap="round" filter="url(#ctGlow)"
                />
              )}
              {series.map((b, i) => (
                <g key={`d${b.bucket}`} className="ct-dot" style={{ animationDelay: `${420 + Math.min(i * 26, 420)}ms` }}>
                  {hover === i && <circle cx={cx(i)} cy={yR(b.converted)} r="7" fill={CONVERTED_COLOR} opacity="0.2" />}
                  {/* fill punches a hole matching the CARD's own background so the marker reads
                      as an open ring - white now that the card is white, not the dark literal
                      this was tuned against. */}
                  <circle
                    cx={cx(i)} cy={yR(b.converted)} r={hover === i ? 4 : 2.75}
                    fill="#ffffff" stroke={CONVERTED_COLOR} strokeWidth="2"
                  />
                </g>
              ))}
              {showPointValues && series.map((b, i) => (
                b.converted > 0 ? (
                  <text
                    key={`cv${b.bucket}`} className="ct-num" x={cx(i)} y={yR(b.converted) - 10}
                    textAnchor="middle" fontSize="9" fontWeight="600" fill={CONVERTED_COLOR}
                    fillOpacity={hover === null || hover === i ? 0.95 : 0.35}
                  >{b.converted}</text>
                ) : null
              ))}

              {series.map((b, i) => (
                i % labelStep === 0 ? (
                  <text
                    key={`x${b.bucket}`} x={cx(i)} y={H - 14} textAnchor="middle" fontSize="9.5"
                    // The hover-emphasized shade was near-white (#e4e4e7), invisible on a white
                    // card - emphasis on light now means darker, not lighter.
                    fill={hover === i ? '#0f172a' : '#71717a'} fontWeight={hover === i ? 600 : 400}
                  >{b.label}</text>
                ) : null
              ))}
            </svg>

            {h && (
              // Positioned in percent of the plot area rather than pixels, so it tracks the
              // column at any container width - the SVG itself is scaled by its viewBox.
              //
              // bg-[#141417] + border-zinc-800/90, the exact floating-panel pair ui.js's
              // MultiSelectDropdown/Overlay already use - both ARE covered by globals.css's
              // light overrides (see the file's own "arbitrary bg-[#hex] literals" note), so
              // this reads as the same white popover every other dropdown/modal in the app
              // already is, rather than the dark-glass panel border-white/10 assumed.
              <div
                className="ct-tip absolute pointer-events-none rounded-xl px-3 py-2 text-[11px] shadow-2xl whitespace-nowrap
                           bg-[#141417] border border-zinc-800/90"
                style={{ left: `${hoverPct}%`, top: '30%', transform: `translate(${hoverSide}%, -100%)` }}
              >
                <div className="font-semibold text-zinc-100 mb-1 tracking-[-0.01em]">{h.label}</div>
                {SERIES.map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5 text-zinc-400">
                    <span className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />
                    {s.label}
                    <span className="ml-auto pl-3 text-zinc-100 font-semibold tabular-nums">{h[s.key].toLocaleString('en-IN')}</span>
                  </div>
                ))}
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: CONVERTED_COLOR }} />
                  Converted
                  <span className="ml-auto pl-3 text-zinc-100 font-semibold tabular-nums">{h.converted.toLocaleString('en-IN')}</span>
                </div>
                <div className="mt-1 pt-1 border-t border-zinc-800/80 text-[10px] text-zinc-500 tabular-nums">
                  Connect {pct(h.connected, h.dialled)} · Convert {pct(h.converted, h.connected)}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
