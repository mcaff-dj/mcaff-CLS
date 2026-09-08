'use client';

import { Fragment, useMemo, useState, useEffect } from 'react';

const HORIZON_MONTHS = 12;
const EMPTY_M = new Array(HORIZON_MONTHS + 1).fill(0);
const ALL_RATINGS = [5, 4, 3, 2, 1];
const BRAND_KEYS = ['mcaffeine', 'hyphen'];
// A brand/category cut needs at least this many cohort (M0) phones before its M3 retention %
// is stable enough to call out by name - a 3-phone cohort swinging from 33% to 66% on one
// extra repeat order isn't a finding.
const MIN_COHORT_FOR_INSIGHT = 150;

function m3PctAndCohort(data, brand, category, ratings) {
  let m0 = 0, m3 = 0;
  ratings.forEach((r) => {
    const arr = data.agg[`${brand}|${category}|${r}`];
    if (arr) { m0 += arr[0]; m3 += arr[3]; }
  });
  return { pct: m0 ? Math.round((m3 / m0) * 1000) / 10 : null, n: m0 };
}

// Same live-recompute approach as RepeatRateTab.js's NPS version - insights are derived from
// data.agg for the CURRENT brand/category filter, not baked in server-side, so switching a
// filter re-derives every number. M6-M12 stay out of any "does the gap persist" claim - most
// tickets are recent enough that those horizons are still mostly right-censored, not decay.
function computeInsights(data, brand, category) {
  const insights = [];
  const scopeParts = [];
  if (brand !== 'all') scopeParts.push(data.brand_labels[brand]);
  if (category !== 'all') scopeParts.push(data.category_labels[category]);
  const prefix = scopeParts.length ? `Within ${scopeParts.join(' × ')}: ` : '';

  const satisfied = m3PctAndCohort(data, brand, category, [5, 4]);
  const neutral = m3PctAndCohort(data, brand, category, [3]);
  const dissatisfied = m3PctAndCohort(data, brand, category, [2, 1]);

  if (satisfied.pct !== null && dissatisfied.pct) {
    const mult = Math.round((satisfied.pct / dissatisfied.pct) * 10) / 10;
    let recoverable = 0;
    if (neutral.pct !== null) recoverable += neutral.n * Math.max(0, satisfied.pct - neutral.pct) / 100;
    recoverable += dissatisfied.n * Math.max(0, satisfied.pct - dissatisfied.pct) / 100;
    insights.push(
      `${prefix}Satisfied ratings (4-5) repeat-purchase by M3 at ${satisfied.pct}% vs ${dissatisfied.pct}% for ` +
      `dissatisfied (1-2)` + (mult !== 1 ? ` - ${mult}x more likely to still be ordering three months later.` : '.') +
      ` If neutral and dissatisfied tickets here repeated at the satisfied rate, roughly ` +
      `${Math.round(recoverable).toLocaleString('en-IN')} more phones would have reordered by M3.`
    );
  }

  if (brand === 'all') {
    const perBrand = BRAND_KEYS.map((b) => [b, m3PctAndCohort(data, b, category, ALL_RATINGS)]);
    if (perBrand.every(([, v]) => v.pct !== null && v.n >= MIN_COHORT_FOR_INSIGHT)) {
      const sorted = [...perBrand].sort((a, b) => b[1].pct - a[1].pct);
      const [hiBrand, hi] = sorted[0];
      const [loBrand, lo] = sorted[1];
      if (hi.pct > lo.pct) {
        const brandMult = lo.pct ? Math.round((hi.pct / lo.pct) * 10) / 10 : null;
        const halfGap = Math.round(lo.n * (hi.pct - lo.pct) / 100 / 2);
        const catSuffix = category !== 'all' ? ` within ${data.category_labels[category]}` : '';
        insights.push(
          `${data.brand_labels[hiBrand]} customers repeat-purchase by M3 at ${hi.pct}%${catSuffix} vs ` +
          `${lo.pct}% for ${data.brand_labels[loBrand]}` + (brandMult ? ` (${brandMult}x)` : '') +
          ` - on ${lo.n.toLocaleString('en-IN')} respondents, closing even half that gap adds roughly ` +
          `${halfGap.toLocaleString('en-IN')} more repeat customers from ${data.brand_labels[loBrand]} alone.`
        );
      }
    }
  }

  if (category === 'all') {
    const cats = data.categories.filter((c) => c !== 'all');
    const perCat = cats.map((c) => [c, m3PctAndCohort(data, brand, c, ALL_RATINGS)]);
    const qualifying = perCat.filter(([, v]) => v.pct !== null && v.n >= MIN_COHORT_FOR_INSIGHT);
    if (qualifying.length >= 2) {
      const totalN = qualifying.reduce((s, [, v]) => s + v.n, 0);
      const biggest = qualifying.reduce((a, b) => (a[1].n > b[1].n ? a : b));
      const weakest = qualifying.reduce((a, b) => (a[1].pct < b[1].pct ? a : b));
      const [biggestCat, biggestStat] = biggest;
      const share = totalN ? Math.round((biggestStat.n / totalN) * 100) : 0;
      if (biggestCat === weakest[0]) {
        insights.push(
          `${data.category_labels[biggestCat]} is both the largest ticket category tracked ` +
          `(${biggestStat.n.toLocaleString('en-IN')}, ${share}% of the cohort) and its weakest M3 ` +
          `retention (${biggestStat.pct}%) - the single highest-leverage place to fix.`
        );
      } else {
        const [weakestCat, weakestStat] = weakest;
        insights.push(
          `${data.category_labels[biggestCat]} draws the most tickets (${biggestStat.n.toLocaleString('en-IN')}, ` +
          `${share}% of the tracked cohort) at ${biggestStat.pct}% M3 retention - the highest-leverage category ` +
          `to improve. ${data.category_labels[weakestCat]} lags furthest behind at ${weakestStat.pct}%, but on a ` +
          `much smaller base (${weakestStat.n.toLocaleString('en-IN')}) - worth investigating, lower priority today.`
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
  { key: 'satisfied', label: 'Satisfied', className: 'rr-good', ratings: [5, 4] },
  { key: 'neutral', label: 'Neutral', className: 'rr-warn', ratings: [3] },
  { key: 'dissatisfied', label: 'Dissatisfied', className: 'rr-bad', ratings: [2, 1] },
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

function CsatHeatmap({ data, brand, category }) {
  const ratingRow = (rating) => ({
    rating,
    total: (data.totals && data.totals[`${brand}|${category}|${rating}`]) || 0,
    m: data.agg[`${brand}|${category}|${rating}`] || EMPTY_M,
  });

  const groupRows = useMemo(
    () => GROUPS.map((g) => {
      const children = g.ratings.map(ratingRow);
      return {
        ...g,
        total: children.reduce((s, c) => s + c.total, 0),
        m: sumArrays(children.map((c) => c.m)),
        children,
      };
    }),
    [data, brand, category]
  );

  const [expanded, setExpanded] = useState({});
  const toggle = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  // Two separate scales: group rows (always the biggest numbers) would otherwise wash out
  // the individual-rating rows' own color range once expanded.
  const groupMax = Math.max(1, ...groupRows.flatMap((g) => g.m.slice(1)));
  const ratingMax = Math.max(1, ...groupRows.flatMap((g) => g.children.flatMap((c) => c.m.slice(1))));

  return (
    <div className="og-table-scroll">
      <table className="og-table rr-heatmap">
        <thead>
          <tr>
            <th>CSAT rating</th>
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
                    <tr key={r.rating} className="rr-child-row">
                      <td className="og-rowlabel rr-child-label">
                        <span className={`rr-score-pill ${g.className}`}>{r.rating}</span>
                      </td>
                      <td className="rr-total">{r.total}</td>
                      <td className="rr-cohort">{rCohort}</td>
                      <MonthCells m={r.m} cohort={rCohort} max={ratingMax} />
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

export default function CsatRepeatRateTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [brand, setBrand] = useState('all');
  const [category, setCategory] = useState('all');

  useEffect(() => {
    fetch('/api/report/data/csat-repeat-rate')
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${r.status})`);
        }
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load the CSAT repeat-rate analysis.'));
  }, []);

  const insights = useMemo(() => (data ? computeInsights(data, brand, category) : []), [data, brand, category]);

  if (error) return <p className="og-note og-error">{error}</p>;
  if (!data) return <p className="og-note">Loading...</p>;

  return (
    <div className="og-wrap">
      <header className="og-header">
        <span className="og-badge">Auto-refreshed nightly</span>
        <h2>CSAT Repeat rate</h2>
        <p>
          For each CSAT rating a ticket got, how many of those phones kept placing orders in the
          months after &mdash; matched by customer_phone against Item_level_data. Source:
          hyphen_tickets / mcaff_tickets, csat_rating IS NOT NULL, since 1 Jan 2026.
          &ldquo;Total responses&rdquo; is every rated ticket; &ldquo;Cohort (M0)&rdquo; narrows
          to the ones who also had an order that same month &mdash; M1-M12 track only that
          narrower group, count and % of cohort. Click Satisfied/Neutral/Dissatisfied to see the
          individual 1-5 ratings behind it.
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
        {data.categories.map((c) => (
          <button
            key={c}
            type="button"
            className={'rr-chip rr-chip-secondary' + (c === category ? ' active' : '')}
            onClick={() => setCategory(c)}
          >
            {data.category_labels[c]}
          </button>
        ))}
      </div>

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Rated tickets</div>
          <div className="kpi-value">{fmtNum(data.total_responses)}</div>
          <div className="kpi-sub">since 1 Jan 2026, both brands</div>
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
          <div className="kpi-value">{fmtPct(data.m0_m3_satisfied_pct)} <span className="rr-unit">satisfied</span></div>
          <div className="kpi-sub">vs {fmtPct(data.m0_m3_dissatisfied_pct)} for dissatisfied (1-2)</div>
        </div>
      </div>
      <p className="og-note">KPI tiles above are org-wide (not brand/category filtered); the table below is.</p>

      <section>
        <h3 className="og-section-title">Repeat-purchase retention, by CSAT rating</h3>
        <CsatHeatmap data={data} brand={brand} category={category} />
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
