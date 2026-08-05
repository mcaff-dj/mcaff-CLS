'use client';

import { useEffect, useMemo, useState } from 'react';
import { buildMetrics, buildRatio, buildClassTables, buildWorstTrends, buildPackagingBaseline } from './trendMath';

function fmtPct(v) {
  if (v === null || v === undefined) return '–';
  return v.toFixed(v < 1 ? 2 : 1) + '%';
}
function fmtNum(v) {
  if (v === null || v === undefined) return '–';
  return v.toLocaleString('en-IN');
}
function fmtDelta(v, unit) {
  if (v === null || v === undefined) return '–';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(2) + (unit === 'pts' ? ' pts' : '%');
}
function fmtScore(v) {
  return (v === null || v === undefined) ? '–' : v;
}
function deltaClass(v) {
  if (v === null || v === undefined) return '';
  return v > 0 ? 'og-up' : (v < 0 ? 'og-down' : '');
}

function MetricTables({ metrics, windowMonths }) {
  return (
    <div className="og-grid-2">
      {metrics.map((brand) => (
        <div className="og-card" key={brand.brand}>
          <div className="og-card-title">{brand.title}</div>
          <div className="og-table-scroll">
            <table className="og-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Baseline Avg</th>
                  {windowMonths.map((m) => <th key={m}>{m}</th>)}
                  <th>Window Avg</th>
                  <th>Shift</th>
                </tr>
              </thead>
              <tbody>
                {brand.rows.map((r) => (
                  <tr key={r.metric}>
                    <td className="og-rowlabel">{r.metric}</td>
                    <td>{fmtScore(r.baseline)}</td>
                    {r.months.map((v, i) => <td key={i}>{fmtScore(v)}</td>)}
                    <td>{fmtScore(r.window_avg)}</td>
                    <td className={deltaClass(r.delta)}>
                      {r.delta === null ? '–' : (r.delta > 0 ? '+' : '') + r.delta + (r.unit === 'pts' ? ' pts' : '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function RatioTable({ rows, windowMonths }) {
  return (
    <div className="og-card">
      <div className="og-card-title">Order:Queries Ratio (unique tickets ÷ order volume)</div>
      <div className="og-table-scroll">
        <table className="og-table">
          <thead>
            <tr>
              <th>Brand</th>
              <th>Baseline Avg</th>
              {windowMonths.map((m) => <th key={m}>{m}</th>)}
              <th>Window Avg</th>
              <th>Shift</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.combined ? 'og-total-row' : ''}>
                <td className="og-rowlabel">{r.label}</td>
                <td>{fmtPct(r.baseline)}</td>
                {r.months.map((v, i) => <td key={i}>{fmtPct(v)}</td>)}
                <td>{fmtPct(r.window_avg)}</td>
                <td className={deltaClass(r.delta)}>{fmtDelta(r.delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClassTables({ classTables, windowMonths }) {
  return (
    <div className="og-grid-2">
      {classTables.map((brand) => (
        <div className="og-card" key={brand.brand}>
          <div className="og-card-title">{brand.title} — Query Class-Wise Comparison</div>
          <div className="og-table-scroll">
            <table className="og-table">
              <thead>
                <tr>
                  <th>Query Class</th>
                  <th>Baseline Avg</th>
                  {windowMonths.map((m) => <th key={m}>{m}</th>)}
                  <th>vs Baseline</th>
                </tr>
              </thead>
              <tbody>
                {brand.rows.map((r) => (
                  <tr key={r.label} className={r.total ? 'og-total-row' : ''}>
                    <td className="og-rowlabel">{r.label}</td>
                    <td>{fmtPct(r.baseline)}</td>
                    {r.months.map((v, i) => <td key={i}>{fmtPct(v)}</td>)}
                    <td>{r.multiplier ? `▲ ${r.multiplier}x` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

const DIMENSION_INTRO = {
  class: 'Whole query classes moving the most between the baseline and current window.',
  category: 'Specific complaint categories (within a class) moving the most.',
  courier: 'Courier x issue-type combinations moving the most.',
  sku: 'Product x issue-type combinations moving the most.',
};

function WorstTrends({ worst }) {
  if (!worst.groups.length) {
    return <p className="og-note">No trend crossed the reporting thresholds for this window.</p>;
  }
  return (
    <div className="og-card">
      <div className="og-card-title">Ranked Worst Trends</div>
      <p className="og-card-sub">
        {worst.baseline_label} baseline vs {worst.window_label} window &mdash; ranked by the largest
        swing in complaint rate, subject to a minimum ticket-volume floor per dimension.
      </p>
      {worst.groups.map((g) => (
        <div className="og-trend-group" key={g.dimension}>
          <div className="og-trend-group-title">{g.title}</div>
          <p className="og-note" style={{ marginBottom: 8 }}>{DIMENSION_INTRO[g.dimension]}</p>
          {g.by_brand.map((bb) => (
            <div className="og-trend-brand" key={bb.brand}>
              <div className="og-trend-brand-title">{bb.title}</div>
              <ol className="og-trend-list">
                {bb.items.map((it, i) => (
                  <li key={i} className={deltaClass(it.delta)}>{it.sentence}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function PackagingSection({ packaging, windowMonths }) {
  return (
    <div className="og-grid-2">
      {packaging.map((brand) => (
        <div className="og-card" key={brand.brand}>
          <div className="og-card-title">{brand.title} — Packaging Deep Dive</div>
          {brand.skus.length === 0 ? (
            <p className="og-note">No SKU crossed the packaging-issue volume floor this window.</p>
          ) : (
            <div className="og-table-scroll">
              <table className="og-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Baseline Rate</th>
                    <th>Window Rate</th>
                    <th>Shift</th>
                    {windowMonths.map((m) => <th key={m}>{m}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {brand.skus.map((s) => (
                    <tr key={s.product}>
                      <td className="og-rowlabel">{s.product}</td>
                      <td>{fmtPct(s.baseline_rate)}</td>
                      <td>{fmtPct(s.window_rate)}</td>
                      <td className={deltaClass(s.delta)}>{fmtDelta(s.delta)}</td>
                      {s.months.map((n, i) => <td key={i}>{fmtNum(n)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {brand.batches.length > 0 && (
            <>
              <div className="og-card-sub" style={{ marginTop: 16, fontWeight: 600 }}>Batch-level concentration</div>
              <div className="og-table-scroll">
                <table className="og-table">
                  <thead>
                    <tr><th>SKU</th><th>Batch</th><th>Window cases</th></tr>
                  </thead>
                  <tbody>
                    {brand.batches.map((b, i) => (
                      <tr key={i}>
                        <td className="og-rowlabel">{b.product}</td>
                        <td>{b.batch}</td>
                        <td>{fmtNum(b.window_cases)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function RepeatOffenders({ repeat, windowMonths }) {
  return (
    <>
      <div className="og-card">
        <div className="og-card-title">Repeat Offenders — Couriers</div>
        <p className="og-card-sub">Window Rate = total complaint cases across the window &divide; total orders shipped in the window, per courier.</p>
        <div className="og-grid-2">
          {repeat.couriers.map((brand) => (
            <div key={brand.brand}>
              <div className="og-card-sub" style={{ fontWeight: 600, marginBottom: 8 }}>{brand.title}</div>
              {brand.rows.length === 0 ? (
                <p className="og-note">No courier crossed the volume floor this window.</p>
              ) : (
                <div className="og-table-scroll">
                  <table className="og-table">
                    <thead>
                      <tr>
                        <th>Courier</th>
                        <th>Window Rate</th>
                        {windowMonths.map((m) => <th key={m}>{m}</th>)}
                        <th>Top Issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brand.rows.map((r) => (
                        <tr key={r.courier}>
                          <td className="og-rowlabel">{r.courier}</td>
                          <td>{fmtPct(r.window_rate)}</td>
                          {r.months.map((n, i) => <td key={i}>{fmtNum(n)}</td>)}
                          <td>{r.top_issue ? `${r.top_issue} (${fmtNum(r.top_issue_cases)})` : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="og-card">
        <div className="og-card-title">Repeat Offenders — SKUs</div>
        <p className="og-card-sub">Ranked by how many of the window&apos;s months a SKU recurred in, then by volume.</p>
        <div className="og-grid-2">
          {repeat.skus.map((brand) => (
            <div key={brand.brand}>
              <div className="og-card-sub" style={{ fontWeight: 600, marginBottom: 8 }}>{brand.title}</div>
              {brand.rows.length === 0 ? (
                <p className="og-note">No SKU crossed the volume floor this window.</p>
              ) : brand.rows.map((r) => (
                <div className="og-sku-block" key={r.product}>
                  <div className="og-sku-name">
                    {r.product}
                    <span className="og-sku-meta">
                      {fmtNum(r.window_cases)} cases &middot; {r.window_rate}% of orders &middot; recurred {r.months_recurring}/{windowMonths.length} months
                    </span>
                  </div>
                  <ul className="og-sku-issues">
                    {r.issues.map((iss, i) => (
                      <li key={i}>{iss.issue}: {fmtNum(iss.cases)} cases ({iss.months_present} months)</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function BaselineFilter({ historyMonths, fromIdx, toIdx, onFromChange, onToChange }) {
  return (
    <div className="filterbar">
      <div className="filter-group">
        <label htmlFor="og-baseline-from">Baseline from</label>
        <select id="og-baseline-from" value={fromIdx} onChange={onFromChange}>
          {historyMonths.map((m, i) => <option key={m} value={i}>{m}</option>)}
        </select>
      </div>
      <div className="filter-group">
        <label htmlFor="og-baseline-to">Baseline to</label>
        <select id="og-baseline-to" value={toIdx} onChange={onToChange}>
          {historyMonths.map((m, i) => <option key={m} value={i}>{m}</option>)}
        </select>
      </div>
    </div>
  );
}

export default function OrgKycTrendsTab() {
  const [digest, setDigest] = useState(null);
  const [error, setError] = useState(null);
  // {fromIdx, toIdx} into digest.axis.history_months - null until the digest arrives and
  // seeds it from digest.axis.default_baseline_months (same range the server itself uses
  // for the unfiltered view, so first render matches today exactly).
  const [baselineRange, setBaselineRange] = useState(null);

  useEffect(() => {
    fetch('/api/report/data/trend-digest')
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${r.status})`);
        }
        return r.json();
      })
      .then((json) => setDigest(json))
      .catch((e) => setError(e.message || 'Could not load the trend digest.'));
  }, []);

  useEffect(() => {
    if (baselineRange || !digest || !digest.axis) return;
    const hist = digest.axis.history_months;
    const def = digest.axis.default_baseline_months;
    setBaselineRange({ fromIdx: hist.indexOf(def[0]), toIdx: hist.indexOf(def[def.length - 1]) });
  }, [digest, baselineRange]);

  const historyMonths = digest && digest.axis ? digest.axis.history_months : [];
  const windowMonths = digest ? digest.window_months : [];
  const baselineMonths = useMemo(() => {
    if (!digest) return [];
    if (!digest.axis || !baselineRange) return digest.baseline_months;
    return historyMonths.slice(baselineRange.fromIdx, baselineRange.toIdx + 1);
  }, [digest, historyMonths, baselineRange]);

  // Old cached JSON (pre-filter deploy) has no raw/axis to recompute from - fall back to
  // the server's own precomputed default view rather than crashing until the next refresh.
  const computed = useMemo(() => {
    if (!digest) return null;
    if (!digest.raw || !digest.axis) {
      return {
        metrics: digest.metrics, ratio: digest.ratio, classTables: digest.class_tables,
        worstTrends: digest.worst_trends, packaging: digest.packaging,
      };
    }
    return {
      metrics: buildMetrics(digest.raw, baselineMonths, windowMonths),
      ratio: buildRatio(digest.raw, baselineMonths, windowMonths),
      classTables: buildClassTables(digest.raw, baselineMonths, windowMonths),
      worstTrends: buildWorstTrends(digest.raw, baselineMonths, windowMonths),
      packaging: buildPackagingBaseline(digest.raw, digest.packaging, baselineMonths, windowMonths),
    };
  }, [digest, baselineMonths, windowMonths]);

  if (error) return <p className="og-note og-error">{error}</p>;
  if (!digest || !computed) return <p className="og-note">Loading...</p>;

  return (
    <div className="og-wrap">
      <header className="og-header">
        <span className="og-badge">Auto-refreshed</span>
        <h2>KYC Complaint Trends</h2>
        <p>
          mCaffeine &amp; Hyphen &middot; {baselineMonths[0]}&ndash;{baselineMonths[baselineMonths.length - 1]} baseline
          vs {windowMonths[0]}&ndash;{windowMonths[windowMonths.length - 1]} window.
          Every number below is computed directly from ticket data on each refresh &mdash; no manually maintained figures.
        </p>
        {historyMonths.length > 0 && baselineRange && (
          <BaselineFilter
            historyMonths={historyMonths}
            fromIdx={baselineRange.fromIdx}
            toIdx={baselineRange.toIdx}
            onFromChange={(e) => {
              const idx = Number(e.target.value);
              setBaselineRange((r) => ({ fromIdx: idx, toIdx: Math.max(idx, r.toIdx) }));
            }}
            onToChange={(e) => {
              const idx = Number(e.target.value);
              setBaselineRange((r) => ({ fromIdx: Math.min(idx, r.fromIdx), toIdx: idx }));
            }}
          />
        )}
      </header>

      <section>
        <h3 className="og-section-title">CSAT &amp; NPS</h3>
        <MetricTables metrics={computed.metrics} windowMonths={windowMonths} />
      </section>

      <section>
        <h3 className="og-section-title">Complaint Trend</h3>
        <RatioTable rows={computed.ratio} windowMonths={windowMonths} />
      </section>

      <section>
        <ClassTables classTables={computed.classTables} windowMonths={windowMonths} />
      </section>

      <section>
        <h3 className="og-section-title">Worst Trends</h3>
        <WorstTrends worst={computed.worstTrends} />
      </section>

      <section>
        <h3 className="og-section-title">Packaging Deep Dive</h3>
        <PackagingSection packaging={computed.packaging} windowMonths={windowMonths} />
      </section>

      <section>
        <h3 className="og-section-title">Repeat Offenders</h3>
        <RepeatOffenders repeat={digest.repeat_offenders} windowMonths={windowMonths} />
      </section>
    </div>
  );
}
