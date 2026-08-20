'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';

const DATE_OPTIONS = [
  { value: 'ALL_TIME', label: 'All time' },
  { value: 'TODAY', label: 'Today' },
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: '7_DAYS', label: 'Last 7 days' },
  { value: '30_DAYS', label: 'Last 30 days' },
  { value: 'THIS_MONTH', label: 'This month' },
  { value: 'LAST_MONTH', label: 'Last month' },
  { value: 'CUSTOM', label: 'Custom range' },
];

const PAYMENT_MODE_OPTIONS = [
  { value: '', label: 'Both' },
  { value: 'Prepaid', label: 'Prepaid' },
  { value: 'COD', label: 'COD' },
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
  if (scope === 'THIS_MONTH') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { dateFrom: isoDate(from), dateTo: isoDate(today) };
  }
  if (scope === 'LAST_MONTH') {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 0);
    return { dateFrom: isoDate(from), dateTo: isoDate(to) };
  }
  if (scope === 'CUSTOM') return { dateFrom: customFrom || null, dateTo: customTo || null };
  return { dateFrom: null, dateTo: null };
}

export default function CallingOverviewClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [authed, setAuthed] = useState(false);
  const [dateScope, setDateScope] = useState('ALL_TIME');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [paymentMode, setPaymentMode] = useState('');
  const [expandedPartners, setExpandedPartners] = useState(() => new Set());

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
    if (paymentMode) params.set('paymentMode', paymentMode);
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
  }, [authed, dateFrom, dateTo, paymentMode]);

  const stats = data && data.stats;

  const togglePartner = (partner) => {
    setExpandedPartners((prev) => {
      const next = new Set(prev);
      if (next.has(partner)) next.delete(partner); else next.add(partner);
      return next;
    });
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
        <div className="co-filter-group">
          <label htmlFor="co-payment-mode">Payment mode</label>
          <select id="co-payment-mode" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
            {PAYMENT_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
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

      {data && data.partnerReasonBreakdown && (
        <div className="co-table-card">
          <h2 className="co-table-title">Delivery Partner Breakdown</h2>
          <p className="co-table-hint">Click a partner to see its RTO reason funnel.</p>
          <table className="co-table">
            <thead>
              <tr>
                <th>Delivery Partner</th>
                <th>Total Leads Assigned</th>
                <th>Total Connected</th>
                <th>Connected %</th>
                <th>Total Converted</th>
                <th>Converted %</th>
              </tr>
            </thead>
            <tbody>
              {data.partnerReasonBreakdown.map((row) => {
                const isOpen = expandedPartners.has(row.deliveryPartner);
                return (
                  <Fragment key={row.deliveryPartner}>
                    <tr className="co-table-row-expandable" onClick={() => togglePartner(row.deliveryPartner)}>
                      <td><span className="co-expand-caret">{isOpen ? '▾' : '▸'}</span>{row.deliveryPartner}</td>
                      <td>{row.totalAssigned.toLocaleString('en-IN')}</td>
                      <td>{row.totalConnected.toLocaleString('en-IN')}</td>
                      <td>{row.connectedPct}%</td>
                      <td>{row.totalConverted.toLocaleString('en-IN')}</td>
                      <td>{row.convertedPct}%</td>
                    </tr>
                    {isOpen && (
                      <tr className="co-table-subrow">
                        <td colSpan={6}>
                          <table className="co-table co-subtable">
                            <thead>
                              <tr>
                                <th>RTO Reason</th>
                                <th>Total Leads Assigned</th>
                                <th>Total Connected</th>
                                <th>Connected %</th>
                                <th>Total Converted</th>
                                <th>Converted %</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.reasons.map((r) => (
                                <tr key={r.rtoReason}>
                                  <td>{r.rtoReason}</td>
                                  <td>{r.totalAssigned.toLocaleString('en-IN')}</td>
                                  <td>{r.totalConnected.toLocaleString('en-IN')}</td>
                                  <td>{r.connectedPct}%</td>
                                  <td>{r.totalConverted.toLocaleString('en-IN')}</td>
                                  <td>{r.convertedPct}%</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!data.partnerReasonBreakdown.length && (
                <tr><td colSpan={6} className="co-table-empty">No data for this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && data.rtoReasonBreakdown && (
        <div className="co-table-card">
          <h2 className="co-table-title">RTO Reason Breakdown</h2>
          <table className="co-table">
            <thead>
              <tr>
                <th>RTO Reason</th>
                <th>Total Leads Assigned</th>
                <th>Total Connected</th>
                <th>Connected %</th>
                <th>Total Converted</th>
                <th>Converted %</th>
              </tr>
            </thead>
            <tbody>
              {data.rtoReasonBreakdown.map((row) => (
                <tr key={row.rtoReason}>
                  <td>{row.rtoReason}</td>
                  <td>{row.totalAssigned.toLocaleString('en-IN')}</td>
                  <td>{row.totalConnected.toLocaleString('en-IN')}</td>
                  <td>{row.connectedPct}%</td>
                  <td>{row.totalConverted.toLocaleString('en-IN')}</td>
                  <td>{row.convertedPct}%</td>
                </tr>
              ))}
              {!data.rtoReasonBreakdown.length && (
                <tr><td colSpan={6} className="co-table-empty">No data for this filter.</td></tr>
              )}
              {!!data.rtoReasonBreakdown.length && (() => {
                const totalAssigned = data.rtoReasonBreakdown.reduce((s, r) => s + r.totalAssigned, 0);
                const totalConnected = data.rtoReasonBreakdown.reduce((s, r) => s + r.totalConnected, 0);
                const totalConverted = data.rtoReasonBreakdown.reduce((s, r) => s + r.totalConverted, 0);
                const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
                return (
                  <tr className="co-table-total">
                    <td>Total</td>
                    <td>{totalAssigned.toLocaleString('en-IN')}</td>
                    <td>{totalConnected.toLocaleString('en-IN')}</td>
                    <td>{pct(totalConnected, totalAssigned)}%</td>
                    <td>{totalConverted.toLocaleString('en-IN')}</td>
                    <td>{pct(totalConverted, totalAssigned)}%</td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
