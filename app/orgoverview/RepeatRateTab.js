'use client';

import { useEffect, useMemo, useState } from 'react';

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTH_ABBR[+m]}'${y.slice(2)}`; };

function scoreCategory(s) {
  if (s >= 9) return { label: 'Promoter', className: 'rr-good' };
  if (s >= 7) return { label: 'Passive', className: 'rr-warn' };
  return { label: 'Detractor', className: 'rr-bad' };
}

function fmtNum(v) {
  return (v === null || v === undefined) ? '–' : v.toLocaleString('en-IN');
}
function fmtPct(v) {
  return (v === null || v === undefined) ? '–' : v.toFixed(1) + '%';
}

const HORIZON_MONTHS = 12;
const EMPTY_M = new Array(HORIZON_MONTHS + 1).fill(0);

function RepeatHeatmap({ data, area }) {
  const rows = useMemo(
    () => data.scores.map((score) => ({
      score,
      total: (data.totals && data.totals[`${area}|${score}`]) || 0,
      m: data.agg[`${area}|${score}`] || EMPTY_M,
    })),
    [data, area]
  );
  // Color scale ignores M0/Cohort (always the largest by construction) so the M1-M12 cells
  // that actually vary aren't washed out to the palest step.
  const max = Math.max(1, ...rows.flatMap((r) => r.m.slice(1)));

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
          {rows.map((r) => {
            const cat = scoreCategory(r.score);
            const cohort = r.m[0];
            return (
              <tr key={r.score}>
                <td className="og-rowlabel">
                  <span className={`rr-score-pill ${cat.className}`}>{r.score}</span>
                  <span className="rr-cat-tag">{cat.label}</span>
                </td>
                <td className="rr-total">{r.total}</td>
                <td className="rr-cohort">{cohort}</td>
                {r.m.slice(1).map((v, i) => {
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
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RepeatDrilldown({ examples, area, areaLabels }) {
  const filtered = area === 'all' ? examples : examples.filter((r) => r.area === area);
  if (!filtered.length) {
    return <p className="og-note">No example rows tagged &ldquo;{areaLabels[area]}&rdquo; in this cut.</p>;
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
          {filtered.map((r, i) => {
            const cat = scoreCategory(r.score);
            return (
              <tr key={i}>
                <td className="og-rowlabel">{r.phone}</td>
                <td>{r.brand}</td>
                <td>{r.area ? areaLabels[r.area] : '—'}</td>
                <td>{monthLabel(r.ym)}</td>
                <td><span className={`rr-score-pill rr-score-pill-sm ${cat.className}`}>{r.score}</span></td>
                <td>{r.months.map(monthLabel).join(', ')}</td>
                <td>{r.months.length}</td>
              </tr>
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
          cohorts that haven&apos;t reached that horizon yet.
        </p>
      </header>

      <div className="rr-chip-row">
        {data.areas.map((a) => (
          <button
            key={a}
            type="button"
            className={'rr-chip' + (a === area ? ' active' : '')}
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

      <section>
        <h3 className="og-section-title">Repeat-purchase retention, by NPS score</h3>
        <RepeatHeatmap data={data} area={area} />
      </section>

      <section>
        <h3 className="og-section-title">Per-customer drill-down</h3>
        <RepeatDrilldown examples={data.examples} area={area} areaLabels={data.area_labels} />
      </section>
    </div>
  );
}
