'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  buildMetrics, buildRatio, buildClassTables, buildWorstTrends, buildPackagingBaseline,
  buildProductDemographicsBaseline,
} from './trendMath';

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

// Null, not "still climbing" - a courier still at its worst month within the window
// gets no note; only a genuine pull-back from a peak is worth calling out, and only
// when it's not just noise (peak has to be materially above the latest month).
function peakEaseNote(monthRates, windowMonths) {
  const present = monthRates
    .map((v, i) => [i, v])
    .filter(([, v]) => v !== null && v !== undefined);
  if (present.length < 2) return null;
  const [peakIdx, peakVal] = present.reduce((a, b) => (b[1] > a[1] ? b : a));
  const [lastIdx, lastVal] = present[present.length - 1];
  if (lastIdx === peakIdx || lastVal >= peakVal * 0.8) return null;
  return `eased from peak ${fmtPct(peakVal)} (${windowMonths[peakIdx]})`;
}

function MetricTables({ metrics, windowMonths }) {
  return (
    <div className="og-stack">
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
    <div className="og-stack">
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

// Groups items by product while preserving each product's existing category order (items
// arrives sorted by window_cases desc across every product+category pair, so a product's
// own categories stay ranked within its group too) - avoids repeating the product name
// once per category the way a flat list of items would.
function groupDemographicsByProduct(items) {
  const byProduct = new Map();
  for (const item of items) {
    if (!byProduct.has(item.product)) byProduct.set(item.product, []);
    byProduct.get(item.product).push(item);
  }
  return Array.from(byProduct.entries());
}

function ProductDemographicsSection({ demographics }) {
  return (
    <div className="og-stack">
      {demographics.map((brand) => (
        <div className="og-card" key={brand.brand}>
          <div className="og-card-title">{brand.title} — Product-Efficacy Demographics</div>
          {brand.items.length === 0 ? (
            <p className="og-note">
              {brand.pending
                ? 'Not populated yet — run the report pipeline (generate_report.py + build_trend_digest.py) to fill this section in.'
                : "No demographic breakdown available for this brand — its sheet doesn't track age/gender/skin type/first-time-vs-regular."}
            </p>
          ) : (
            groupDemographicsByProduct(brand.items).map(([product, cats]) => (
              <div className="og-sku-block" key={product}>
                <div className="og-sku-name">{product}</div>
                {cats.map((item, i) => (
                  <div key={item.category} style={{ marginTop: i === 0 ? 6 : 14 }}>
                    <div className="og-sku-meta" style={{ fontWeight: 600 }}>
                      {item.category} &middot; {fmtNum(item.window_cases)} cases in window
                    </div>
                    <ul className="og-sku-issues">
                      {Object.values(item.fields).map((f) => (
                        <li key={f.label}>
                          {f.label}: <strong>{f.top_value}</strong> &mdash; {fmtPct(f.window_share_pct)} of window
                          {f.baseline_share_pct != null && ` (was ${fmtPct(f.baseline_share_pct)} at baseline)`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

function PackagingSection({ packaging, windowMonths }) {
  return (
    <div className="og-stack">
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
                      <td className="og-rowlabel">
                        {s.product}
                        {s.issues && s.issues.length > 0 && (
                          <details className="og-issue-dropdown">
                            <summary>Top issue: {s.top_issue} ({fmtNum(s.top_issue_cases)})</summary>
                            <ul>
                              {s.issues.map((iss) => (
                                <li key={iss.issue}>{iss.issue}: {fmtNum(iss.window_cases)}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
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
          {brand.dropped && brand.dropped.length > 0 && (
            <>
              <div className="og-card-sub" style={{ marginTop: 16, fontWeight: 600 }}>Dropped off this window</div>
              <p className="og-note" style={{ marginBottom: 8 }}>
                Cleared the reporting floor at baseline but fell below it this window &mdash; confirm resolved rather than assuming fixed.
              </p>
              <div className="og-table-scroll">
                <table className="og-table">
                  <thead>
                    <tr><th>SKU</th><th>Baseline Rate</th><th>Baseline cases</th><th>Window cases</th></tr>
                  </thead>
                  <tbody>
                    {brand.dropped.map((d) => (
                      <tr key={d.product}>
                        <td className="og-rowlabel">{d.product}</td>
                        <td>{fmtPct(d.baseline_rate)}</td>
                        <td>{fmtNum(d.baseline_cases)}</td>
                        <td>{fmtNum(d.window_cases)}</td>
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
      <div className="og-card">
        <div className="og-card-title">Repeat Offenders — Couriers</div>
        <p className="og-card-sub">Window Rate = total complaint cases across the window &divide; total orders shipped in the window, per courier.</p>
        {repeat.couriers.map((brand) => (
          <div key={brand.brand} style={{ marginTop: 12 }}>
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
                      <th className="og-wrap-cell">Top Issue</th>
                      <th className="og-wrap-cell">Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brand.rows.map((r) => (
                      <tr key={r.courier}>
                        <td className="og-rowlabel">{r.courier}</td>
                        <td>{fmtPct(r.window_rate)}</td>
                        {r.months.map((n, i) => (
                          <td key={i}>{fmtNum(n)} <span className="og-card-sub">({fmtPct(r.month_rates?.[i])})</span></td>
                        ))}
                        <td className="og-wrap-cell">{r.top_issue ? `${r.top_issue} (${fmtNum(r.top_issue_cases)})` : '–'}</td>
                        <td className="og-note og-wrap-cell">{peakEaseNote(r.month_rates || [], windowMonths) || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
  );
}

// A digest built before product_demographics existed has no per-brand placeholder at all
// - without this, the section would render zero cards (not even an empty-state message)
// instead of "not populated yet" per brand, indistinguishable from a real bug.
function pendingDemographics(digest) {
  return (digest.brands || []).map((b) => ({ brand: b.brand, title: b.title, items: [], pending: true }));
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

  // Everything after the chosen baseline's last month, through the most recent month
  // available - so picking an earlier baseline end (e.g. Apr instead of the default) pulls
  // the comparison window forward to start right after it (May-Sep), rather than the
  // window staying pinned to its original fixed months regardless of the baseline picked.
  // Falls back to the fixed window when there's no raw/axis to recompute from.
  const dynamicWindowMonths = useMemo(() => {
    if (!digest || !digest.axis || !baselineRange) return windowMonths;
    return historyMonths.concat(windowMonths).slice(baselineRange.toIdx + 1);
  }, [digest, historyMonths, windowMonths, baselineRange]);

  // Old cached JSON (pre-filter deploy) has no raw/axis to recompute from - fall back to
  // the server's own precomputed default view rather than crashing until the next refresh.
  const computed = useMemo(() => {
    if (!digest) return null;
    if (!digest.raw || !digest.axis) {
      return {
        metrics: digest.metrics, ratio: digest.ratio, classTables: digest.class_tables,
        worstTrends: digest.worst_trends, packaging: digest.packaging,
        productDemographics: digest.product_demographics
          ? digest.product_demographics
          : pendingDemographics(digest),
      };
    }
    return {
      metrics: buildMetrics(digest.raw, baselineMonths, dynamicWindowMonths),
      ratio: buildRatio(digest.raw, baselineMonths, dynamicWindowMonths),
      classTables: buildClassTables(digest.raw, baselineMonths, dynamicWindowMonths),
      worstTrends: buildWorstTrends(digest.raw, baselineMonths, dynamicWindowMonths),
      // Packaging Deep Dive and Product-Efficacy Demographics stay pinned to the fixed
      // window: their item lists (SKU list, dropped-off list, top-issue/top-demographic
      // breakdown) are only computed server-side for that fixed range, so recomputing just
      // the rate/share against a different window would show numbers next to a stale item
      // list and mismatched month columns. Repeat Offenders (below) has the same limitation.
      packaging: buildPackagingBaseline(digest.raw, digest.packaging, baselineMonths, windowMonths),
      // digest.product_demographics is absent on a digest built before this field existed
      // (pre-regen) - show a per-brand "not populated yet" placeholder instead of crashing
      // or rendering nothing until the next refresh.
      productDemographics: digest.product_demographics
        ? buildProductDemographicsBaseline(digest.raw, digest.product_demographics, baselineMonths)
        : pendingDemographics(digest),
    };
  }, [digest, baselineMonths, dynamicWindowMonths, windowMonths]);

  if (error) return <p className="og-note og-error">{error}</p>;
  if (!digest || !computed) return <p className="og-note">Loading...</p>;

  return (
    <div className="og-wrap-outer">
      <button className="og-download-btn" onClick={() => window.print()}>Download PDF</button>
      <div className="og-wrap" id="printable-receipt">
      <header className="og-header">
        <span className="og-badge">Auto-refreshed</span>
        <h2>KYC Complaint Trends</h2>
        <p>
          mCaffeine &amp; Hyphen &middot; {baselineMonths[0]}&ndash;{baselineMonths[baselineMonths.length - 1]} baseline
          vs {dynamicWindowMonths[0]}&ndash;{dynamicWindowMonths[dynamicWindowMonths.length - 1]} window.
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
        {dynamicWindowMonths[0] !== windowMonths[0] && (
          <p className="og-note" style={{ marginTop: 10 }}>
            Packaging Deep Dive, Product-Efficacy Demographics and Repeat Offenders below stay
            pinned to their original {windowMonths[0]}&ndash;{windowMonths[windowMonths.length - 1]}
            {' '}window regardless of this filter.
          </p>
        )}
      </header>

      <section>
        <h3 className="og-section-title">CSAT &amp; NPS</h3>
        <MetricTables metrics={computed.metrics} windowMonths={dynamicWindowMonths} />
      </section>

      <section>
        <h3 className="og-section-title">Complaint Trend</h3>
        <RatioTable rows={computed.ratio} windowMonths={dynamicWindowMonths} />
      </section>

      <section>
        <ClassTables classTables={computed.classTables} windowMonths={dynamicWindowMonths} />
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
        <h3 className="og-section-title">Product-Efficacy Demographics</h3>
        <ProductDemographicsSection demographics={computed.productDemographics} />
      </section>

      <section>
        <h3 className="og-section-title">Repeat Offenders</h3>
        <RepeatOffenders repeat={digest.repeat_offenders} windowMonths={windowMonths} />
      </section>
      </div>
    </div>
  );
}
