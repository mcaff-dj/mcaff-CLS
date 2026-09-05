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

// Brand has no column of its own on CLS_RTO_calling - it's derived from Order ID, same rule
// as app/ndr-calling/NdrCallingClient.js's brandOf and scripts/assign_ndr_leads.py's brand_of
// (an order ID starting with "HYP" is Hyphen, everything else is mCaffeine).
const BRAND_OPTIONS = [
  { value: '', label: 'Both' },
  { value: 'Hyphen', label: 'Hyphen' },
  { value: 'mCaffeine', label: 'mCaffeine' },
];

const PROCESS_OPTIONS = [
  { value: 'RTO', label: 'RTO' },
  { value: 'NDR', label: 'NDR' },
];

// Shared column shape for every funnel table on this page (Delivery Partner Breakdown, RTO
// Reason Breakdown, and the per-partner RTO reason sub-table) - only the leftmost label
// column differs between them.
function funnelColumns(labelKey, labelText) {
  return [
    { key: labelKey, label: labelText, type: 'string' },
    { key: 'totalAssigned', label: 'Total Leads Assigned', type: 'number' },
    { key: 'totalConnected', label: 'Total Connected', type: 'number' },
    { key: 'connectedPct', label: 'Connected %', type: 'number' },
    { key: 'totalConverted', label: 'Total Converted', type: 'number' },
    { key: 'convertedPct', label: 'Converted %', type: 'number' },
  ];
}
const PARTNER_COLUMNS = funnelColumns('deliveryPartner', 'Delivery Partner');
function reasonColumns(processFilter) {
  return funnelColumns('rtoReason', processFilter === 'NDR' ? 'NDR Reason' : 'RTO Reason');
}
const DEFAULT_SORT = { key: 'totalAssigned', dir: 'desc' };

function sortRows(rows, sort) {
  const { key, dir } = sort;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return dir === 'asc' ? cmp : -cmp;
  });
}

// Clicking the already-active column flips its direction; clicking a new column starts it
// at a sensible default (alphabetical for the label column, highest-first for every number).
function nextSort(prev, col) {
  if (prev.key === col.key) return { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  return { key: col.key, dir: col.type === 'string' ? 'asc' : 'desc' };
}

function SortableHeaderRow({ columns, sort, onSort }) {
  return (
    <tr>
      {columns.map((col) => (
        <th key={col.key} className="co-th-sortable" onClick={() => onSort(col)}>
          {col.label}
          {sort.key === col.key && <span className="co-sort-arrow">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
        </th>
      ))}
    </tr>
  );
}

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
  const [processFilter, setProcessFilter] = useState('RTO');
  const [dateScope, setDateScope] = useState('ALL_TIME');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [paymentMode, setPaymentMode] = useState('');
  const [brand, setBrand] = useState('');
  const [expandedPartners, setExpandedPartners] = useState(() => new Set());
  const [partnerSort, setPartnerSort] = useState(DEFAULT_SORT);
  const [reasonSort, setReasonSort] = useState(DEFAULT_SORT);
  const [subtableSort, setSubtableSort] = useState(DEFAULT_SORT);

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
    params.set('process', processFilter);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (paymentMode) params.set('paymentMode', paymentMode);
    if (brand) params.set('brand', brand);
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
  }, [authed, processFilter, dateFrom, dateTo, paymentMode, brand]);

  const stats = data && data.stats;
  const REASON_COLUMNS = reasonColumns(processFilter);

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
          <label htmlFor="co-process">Process</label>
          <select id="co-process" value={processFilter} onChange={(e) => setProcessFilter(e.target.value)}>
            {PROCESS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
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
        <div className="co-filter-group">
          <label htmlFor="co-brand">Brand</label>
          <select id="co-brand" value={brand} onChange={(e) => setBrand(e.target.value)}>
            {BRAND_OPTIONS.map((o) => (
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
          {stats.totalRefunded != null && (
            <div className="kpi kpi-accent">
              <div className="kpi-label">Refunds</div>
              <div className="kpi-value">{stats.totalRefunded.toLocaleString('en-IN')}</div>
              <div className="kpi-sub">₹{stats.totalRefundAmount.toLocaleString('en-IN')}</div>
            </div>
          )}
          <div className="kpi kpi-good">
            <div className="kpi-label">Total Converted</div>
            <div className="kpi-value">{stats.totalConverted.toLocaleString('en-IN')}</div>
            <div className="kpi-sub">Reordered / accepted</div>
          </div>
        </div>
      )}

      {data && data.partnerReasonBreakdown && (
        <div className="co-table-card">
          <h2 className="co-table-title">Delivery Partner Breakdown</h2>
          <p className="co-table-hint">Click a partner to see its {processFilter === 'NDR' ? 'NDR' : 'RTO'} reason funnel.</p>
          <table className="co-table">
            <thead>
              <SortableHeaderRow
                columns={PARTNER_COLUMNS}
                sort={partnerSort}
                onSort={(col) => setPartnerSort((prev) => nextSort(prev, col))}
              />
            </thead>
            <tbody>
              {sortRows(data.partnerReasonBreakdown, partnerSort).map((row) => {
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
                              <SortableHeaderRow
                                columns={REASON_COLUMNS}
                                sort={subtableSort}
                                onSort={(col) => setSubtableSort((prev) => nextSort(prev, col))}
                              />
                            </thead>
                            <tbody>
                              {sortRows(row.reasons, subtableSort).map((r) => (
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
              {!!data.partnerReasonBreakdown.length && (() => {
                const totalAssigned = data.partnerReasonBreakdown.reduce((s, r) => s + r.totalAssigned, 0);
                const totalConnected = data.partnerReasonBreakdown.reduce((s, r) => s + r.totalConnected, 0);
                const totalConverted = data.partnerReasonBreakdown.reduce((s, r) => s + r.totalConverted, 0);
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

      {data && data.reasonBreakdown && (
        <div className="co-table-card">
          <h2 className="co-table-title">{processFilter === 'NDR' ? 'NDR' : 'RTO'} Reason Breakdown</h2>
          <table className="co-table">
            <thead>
              <SortableHeaderRow
                columns={REASON_COLUMNS}
                sort={reasonSort}
                onSort={(col) => setReasonSort((prev) => nextSort(prev, col))}
              />
            </thead>
            <tbody>
              {sortRows(data.reasonBreakdown, reasonSort).map((row) => (
                <tr key={row.rtoReason}>
                  <td>{row.rtoReason}</td>
                  <td>{row.totalAssigned.toLocaleString('en-IN')}</td>
                  <td>{row.totalConnected.toLocaleString('en-IN')}</td>
                  <td>{row.connectedPct}%</td>
                  <td>{row.totalConverted.toLocaleString('en-IN')}</td>
                  <td>{row.convertedPct}%</td>
                </tr>
              ))}
              {!data.reasonBreakdown.length && (
                <tr><td colSpan={6} className="co-table-empty">No data for this filter.</td></tr>
              )}
              {!!data.reasonBreakdown.length && (() => {
                const totalAssigned = data.reasonBreakdown.reduce((s, r) => s + r.totalAssigned, 0);
                const totalConnected = data.reasonBreakdown.reduce((s, r) => s + r.totalConnected, 0);
                const totalConverted = data.reasonBreakdown.reduce((s, r) => s + r.totalConverted, 0);
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
