'use client';

import { Fragment, useMemo, useState, useEffect } from 'react';

const HORIZON_MONTHS = 12;
const EMPTY_M = new Array(HORIZON_MONTHS + 1).fill(0);
const ALL_SCORES = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
const AREA_KEYS = ['delivery', 'cs', 'product', 'website'];
const BRAND_KEYS = ['mcaffeine', 'hyphen'];
// A brand/area cut needs at least this many cohort (M0) phones before its M3 retention % is
// stable enough to call out by name - a 3-phone cohort swinging from 33% to 66% on one extra
// repeat order isn't a finding.
const MIN_COHORT_FOR_INSIGHT = 150;

function m3PctAndCohort(data, brand, area, scores) {
  let m0 = 0, m3 = 0;
  scores.forEach((s) => {
    const arr = data.agg[`${brand}|${area}|${s}`];
    if (arr) { m0 += arr[0]; m3 += arr[3]; }
  });
  return { pct: m0 ? Math.round((m3 / m0) * 1000) / 10 : null, n: m0 };
}

// Insights are computed live from data.agg for the CURRENT brand/area filter, not baked in
// server-side - so switching a filter re-derives every number rather than showing a stale
// global read. Framed for prioritization: how many more repeat customers closing a given gap
// would add, and which cut is the highest-leverage fix once cohort volume is weighed against
// retention, not retention alone. M6-M12 stay out of any "does the gap persist" claim - most
// of this cohort responded Apr-Aug'26, so those horizons are still mostly right-censored, not
// a real decay signal (see the table's own caveat).
function computeInsights(data, brand, area) {
  const insights = [];
  const scopeParts = [];
  if (brand !== 'all') scopeParts.push(data.brand_labels[brand]);
  if (area !== 'all') scopeParts.push(data.area_labels[area]);
  const prefix = scopeParts.length ? `Within ${scopeParts.join(' × ')}: ` : '';

  const promoter = m3PctAndCohort(data, brand, area, [10, 9]);
  const passive = m3PctAndCohort(data, brand, area, [8, 7]);
  const detractor = m3PctAndCohort(data, brand, area, [6, 5, 4, 3, 2, 1, 0]);

  if (promoter.pct !== null && detractor.pct) {
    const mult = Math.round((promoter.pct / detractor.pct) * 10) / 10;
    let recoverable = 0;
    if (passive.pct !== null) recoverable += passive.n * Math.max(0, promoter.pct - passive.pct) / 100;
    recoverable += detractor.n * Math.max(0, promoter.pct - detractor.pct) / 100;
    insights.push(
      `${prefix}Promoters (9-10) repeat-purchase by M3 at ${promoter.pct}% vs ${detractor.pct}% for ` +
      `detractors (0-6) - ${mult}x more likely to still be ordering three months later. If passives ` +
      `and detractors here repeated at the promoter rate, roughly ${Math.round(recoverable).toLocaleString('en-IN')} ` +
      `more phones would have reordered by M3 - that gap, not the NPS score itself, is the retention budget worth chasing.`
    );
  }

  if (brand === 'all') {
    const perBrand = BRAND_KEYS.map((b) => [b, m3PctAndCohort(data, b, area, ALL_SCORES)]);
    if (perBrand.every(([, v]) => v.pct !== null && v.n >= MIN_COHORT_FOR_INSIGHT)) {
      const sorted = [...perBrand].sort((a, b) => b[1].pct - a[1].pct);
      const [hiBrand, hi] = sorted[0];
      const [loBrand, lo] = sorted[1];
      if (hi.pct > lo.pct) {
        const brandMult = lo.pct ? Math.round((hi.pct / lo.pct) * 10) / 10 : null;
        const halfGap = Math.round(lo.n * (hi.pct - lo.pct) / 100 / 2);
        const areaSuffix = area !== 'all' ? ` within ${data.area_labels[area]}` : '';
        insights.push(
          `${data.brand_labels[hiBrand]} customers repeat-purchase by M3 at ${hi.pct}%${areaSuffix} vs ` +
          `${lo.pct}% for ${data.brand_labels[loBrand]}` + (brandMult ? ` (${brandMult}x)` : '') +
          ` - on ${lo.n.toLocaleString('en-IN')} respondents, that's a lever worth pulling: closing even ` +
          `half the gap adds roughly ${halfGap.toLocaleString('en-IN')} more repeat customers from ${data.brand_labels[loBrand]} alone.`
        );
      }
    }
  }

  if (area === 'all') {
    const perArea = AREA_KEYS.map((a) => [a, m3PctAndCohort(data, brand, a, ALL_SCORES)]);
    const qualifying = perArea.filter(([, v]) => v.pct !== null && v.n >= MIN_COHORT_FOR_INSIGHT);
    if (qualifying.length >= 2) {
      const totalN = qualifying.reduce((s, [, v]) => s + v.n, 0);
      const biggest = qualifying.reduce((a, b) => (a[1].n > b[1].n ? a : b));
      const weakest = qualifying.reduce((a, b) => (a[1].pct < b[1].pct ? a : b));
      const [biggestArea, biggestStat] = biggest;
      const share = totalN ? Math.round((biggestStat.n / totalN) * 100) : 0;
      if (biggestArea === weakest[0]) {
        insights.push(
          `${data.area_labels[biggestArea]} is both the largest top-rated-area cohort ` +
          `(${biggestStat.n.toLocaleString('en-IN')}, ${share}% of the tracked cohort) and its weakest M3 ` +
          `retention (${biggestStat.pct}%) - the single highest-leverage place to fix, since any ` +
          `improvement compounds across the most customers.`
        );
      } else {
        const [weakestArea, weakestStat] = weakest;
        insights.push(
          `${data.area_labels[biggestArea]} draws the most respondents (${biggestStat.n.toLocaleString('en-IN')}, ` +
          `${share}% of the tracked cohort) at ${biggestStat.pct}% M3 retention - the highest-leverage area to ` +
          `improve, since even a small lift compounds across the most customers. ${data.area_labels[weakestArea]} ` +
          `lags furthest behind at ${weakestStat.pct}%, but on a much smaller base (${weakestStat.n.toLocaleString('en-IN')}) ` +
          `- worth investigating, but a lower-priority fix today.`
        );
      }
    }
  }

  if (insights.length === 0) {
    insights.push(`${prefix}Not enough volume in this cut for a reliable M3 read (needs at least ${MIN_COHORT_FOR_INSIGHT} cohort phones).`);
  }
  return insights;
}

// Display order top-to-bottom, both for the group rows and the child rows within each group.
const GROUPS = [
  { key: 'promoter', label: 'Promoter', className: 'rr-good', scores: [10, 9] },
  { key: 'passive', label: 'Passive', className: 'rr-warn', scores: [8, 7] },
  { key: 'detractor', label: 'Detractor', className: 'rr-bad', scores: [6, 5, 4, 3, 2, 1, 0] },
];

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

  const insights = useMemo(() => (data ? computeInsights(data, brand, area) : []), [data, brand, area]);

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

      {insights.length > 0 && (
        <section className="rr-insights">
          <h3 className="og-section-title">Insights</h3>
          <ul>
            {insights.map((text, i) => <li key={i}>{text}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
