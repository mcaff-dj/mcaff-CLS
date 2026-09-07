'use client';

import { Fragment, useMemo, useState, useEffect } from 'react';

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTH_ABBR[+m]}'${y.slice(2)}`; };

const HORIZON_MONTHS = 12;
const EMPTY_M = new Array(HORIZON_MONTHS + 1).fill(0);

// Display order top-to-bottom, both for the group rows and the child rows within each group.
const GROUPS = [
  { key: 'promoter', label: 'Promoter', className: 'rr-good', scores: [10, 9] },
  { key: 'passive', label: 'Passive', className: 'rr-warn', scores: [8, 7] },
  { key: 'detractor', label: 'Detractor', className: 'rr-bad', scores: [6, 5, 4, 3, 2, 1, 0] },
];

function scoreClassName(s) {
  if (s >= 9) return 'rr-good';
  if (s >= 7) return 'rr-warn';
  return 'rr-bad';
}

function fmtNum(v) {
  return (v === null || v === undefined) ? '–' : v.toLocaleString('en-IN');
}
function fmtPct(v) {
  return (v === null || v === undefined) ? '–' : v.toFixed(1) + '%';
}
function sumArrays(arrs) {
  return arrs.reduce((acc, m) => acc.map((v, i) => v + m[i]), new Array(HORIZON_MONTHS + 1).fill(0));
}

function MonthCells({ m, cohort, max }) {
  return m.slice(1).map((v, i) => {
    const t = v / max;
    const pct = cohort ? (v / cohort) * 100 : null;
    const style = v === 0 ? {} : {
      background: `color-mix(in srgb, var(--accent) ${Math.round(t * 75)}%, var(--surface-card))`,
      color: t > 0.55 ? '#fff' : 'var(--text-primary)',
    };
    return (
      <td key={i} className="rr-cell" style={style}>
        <div className="rr-cell-count">{v}</div>
        <div className="rr-cell-pct">{pct === null ? '–' : pct.toFixed(1) + '%'}</div>
      </td>
    );
  });
}

function RepeatHeatmap({ data, brand, area }) {
  const scoreRow = (score) => ({
    score,
    total: (data.totals && data.totals[`${brand}|${area}|${score}`]) || 0,
    m: data.agg[`${brand}|${area}|${score}`] || EMPTY_M,
  });

  const groupRows = useMemo(
    () => GROUPS.map((g) => {
      const children = g.scores.map(scoreRow);
      return {
        ...g,
        total: children.reduce((s, c) => s + c.total, 0),
        m: sumArrays(children.map((c) => c.m)),
        children,
      };
    }),
    [data, brand, area]
  );

  const [expanded, setExpanded] = useState({});
  const toggle = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  // Two separate scales: group rows (always the biggest numbers) would otherwise wash out
  // the individual-score rows' own color range once expanded.
  const groupMax = Math.max(1, ...groupRows.flatMap((g) => g.m.slice(1)));
  const scoreMax = Math.max(1, ...groupRows.flatMap((g) => g.children.flatMap((c) => c.m.slice(1))));

  return (
    <div className="og-table-scroll">
      <table className="og-table rr-heatmap">
        <thead>
          <tr>
            <th>NPS score</th>
            <th>Total responses</th>
            <th>Cohort (M0)</th>
            {Array.from({ length: HORIZON_MONTHS }, (_, i) => <th key={i}>{`M${i + 1}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {groupRows.map((g) => {
            const cohort = g.m[0];
            const isOpen = !!expanded[g.key];
            return (
              <Fragment key={g.key}>
                <tr className="rr-group-row" onClick={() => toggle(g.key)}>
                  <td className="og-rowlabel">
                    <span className="rr-expand-arrow">{isOpen ? '▾' : '▸'}</span>
                    <span className={`rr-score-pill rr-group-pill ${g.className}`}>{g.label}</span>
                  </td>
                  <td className="rr-total">{g.total}</td>
                  <td className="rr-cohort">{cohort}</td>
                  <MonthCells m={g.m} cohort={cohort} max={groupMax} />
                </tr>
                {isOpen && g.children.map((r) => {
                  const rCohort = r.m[0];
                  return (
                    <tr key={r.score} className="rr-child-row">
                      <td className="og-rowlabel rr-child-label">
                        <span className={`rr-score-pill ${g.className}`}>{r.score}</span>
                      </td>
                      <td className="rr-total">{r.total}</td>
                      <td className="rr-cohort">{rCohort}</td>
                      <MonthCells m={r.m} cohort={rCohort} max={scoreMax} />
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RepeatDrilldown({ examples, brand, area, areaLabels }) {
  const filtered = examples.filter(
    (r) => (area === 'all' || r.area === area) && (brand === 'all' || (r.brand || '').toLowerCase() === brand)
  );
  if (!filtered.length) {
    return <p className="og-note">No example rows match this filter in this cut.</p>;
  }
  return (
    <div className="og-table-scroll">
      <table className="og-table rr-drill">
        <thead>
          <tr>
            <th>Phone</th><th>Brand</th><th>Top-rated area</th><th>NPS month</th>
            <th>Score</th><th>Order months</th><th>Total orders</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r, i) => (
            <tr key={i}>
              <td className="og-rowlabel">{r.phone}</td>
              <td>{r.brand}</td>
              <td>{r.area ? areaLabels[r.area] : '—'}</td>
              <td>{monthLabel(r.ym)}</td>
              <td><span className={`rr-score-pill rr-score-pill-sm ${scoreClassName(r.score)}`}>{r.score}</span></td>
              <td>{r.months.map(monthLabel).join(', ')}</td>
              <td>{r.months.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RepeatRateTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [brand, setBrand] = useState('all');
  const [area, setArea] = useState('all');

  useEffect(() => {
    fetch('/api/report/data/repeat-rate')
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${r.status})`);
        }
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load the repeat-rate analysis.'));
  }, []);

  if (error) return <p className="og-note og-error">{error}</p>;
  if (!data) return <p className="og-note">Loading...</p>;

  return (
    <div className="og-wrap">
      <header className="og-header">
        <span className="og-badge">Auto-refreshed nightly</span>
        <h2>Repeat Rate analysis</h2>
        <p>
          For each NPS score a respondent gave, how many of those phones kept placing orders
          in the months after &mdash; matched by customer_phone against Item_level_data.
          &ldquo;Total responses&rdquo; is everyone who gave that score; &ldquo;Cohort (M0)&rdquo;
          narrows to the ones who also had an order that same month &mdash; M1-M12 track only
          that narrower group, count and % of cohort. Later months undercount for recent
          cohorts that haven&apos;t reached that horizon yet. Click a Promoter/Passive/Detractor
          row to see the individual scores behind it.
        </p>
      </header>

      <div className="rr-chip-row">
        {data.brands.map((b) => (
          <button
            key={b}
            type="button"
            className={'rr-chip' + (b === brand ? ' active' : '')}
            onClick={() => setBrand(b)}
          >
            {data.brand_labels[b]}
          </button>
        ))}
      </div>

      <div className="rr-chip-row">
        {data.areas.map((a) => (
          <button
            key={a}
            type="button"
            className={'rr-chip rr-chip-secondary' + (a === area ? ' active' : '')}
            onClick={() => setArea(a)}
          >
            {data.area_labels[a]}
          </button>
        ))}
      </div>

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">NPS responses</div>
          <div className="kpi-value">{fmtNum(data.total_responses)}</div>
          <div className="kpi-sub">since 1 Jan 2026</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Distinct phones</div>
          <div className="kpi-value">{fmtNum(data.distinct_phones)}</div>
          <div className="kpi-sub">{fmtNum(data.phones_with_any_order)} matched an order ever</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Repeat purchasers (M0)</div>
          <div className="kpi-value">{fmtNum(data.m0_total)}</div>
          <div className="kpi-sub">had an order the same month</div>
        </div>
        <div className="kpi kpi-accent">
          <div className="kpi-label">M0 &rarr; M3 retention</div>
          <div className="kpi-value">{fmtPct(data.m0_m3_promoter_pct)} <span className="rr-unit">promoters</span></div>
          <div className="kpi-sub">vs {fmtPct(data.m0_m3_detractor_pct)} for detractors (0-6)</div>
        </div>
      </div>
      <p className="og-note">KPI tiles above are org-wide (not brand/area filtered); the table below is.</p>

      <section>
        <h3 className="og-section-title">Repeat-purchase retention, by NPS score</h3>
        <RepeatHeatmap data={data} brand={brand} area={area} />
      </section>

      <section>
        <h3 className="og-section-title">Per-customer drill-down</h3>
        <RepeatDrilldown examples={data.examples} brand={brand} area={area} areaLabels={data.area_labels} />
      </section>
    </div>
  );
}
