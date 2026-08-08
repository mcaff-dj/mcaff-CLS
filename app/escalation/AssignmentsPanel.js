// app/escalation/AssignmentsPanel.js
'use client';

import { useState, useEffect, useMemo } from 'react';

// One row per agent: currently-assigned (live, unresolved) count, resolved count, and average
// time-to-resolve. Each metric is scoped by ITS OWN timestamp (assigned_at vs resolved_at) -
// same reasoning db.js's getCallingOverviewStats comment gives for RTO's own metrics: a single
// shared date filter would silently misattribute one of the two. Client-side aggregation,
// mirroring how NDR's own Agent Performance Summary table (NdrCallingClient.js) is computed in
// the browser from raw per-lead rows rather than a single backend aggregate query.
function fmtMinutes(mins) {
  if (mins == null || !Number.isFinite(mins)) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function AssignmentsPanel({ agents }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    fetch('/api/escalation/assignments')
      .then((r) => r.json())
      .then((d) => setHistory(d.assignments || []))
      .catch(() => setError('Could not load assignment history'));
  }, []);

  const inRange = (iso) => {
    if (!iso) return false;
    const day = iso.slice(0, 10);
    if (fromDate && day < fromDate) return false;
    if (toDate && day > toDate) return false;
    return true;
  };

  const rows = useMemo(() => {
    if (!history) return [];
    const byEmail = new Map();
    const get = (email) => {
      if (!byEmail.has(email)) {
        const a = (agents || []).find((x) => x.email === email);
        byEmail.set(email, { email, name: a?.name || email, currentlyAssigned: 0, resolved: 0, totalResolveMinutes: 0 });
      }
      return byEmail.get(email);
    };
    history.forEach((r) => {
      if (!r.reassignedAwayAt && !r.resolvedAt) {
        get(r.email).currentlyAssigned += 1;
      }
      if (r.resolvedAt && inRange(r.resolvedAt)) {
        const row = get(r.email);
        row.resolved += 1;
        row.totalResolveMinutes += (new Date(r.resolvedAt) - new Date(r.assignedAt)) / 60000;
      } else if (!r.resolvedAt) {
        // ensure agents with only live (unresolved) assignments still appear
        get(r.email);
      }
    });
    return Array.from(byEmail.values())
      .map((r) => ({ ...r, avgResolveMinutes: r.resolved ? r.totalResolveMinutes / r.resolved : null }))
      .sort((a, b) => b.currentlyAssigned - a.currentlyAssigned);
  }, [history, agents, fromDate, toDate]);

  const totals = rows.reduce((acc, r) => ({
    currentlyAssigned: acc.currentlyAssigned + r.currentlyAssigned,
    resolved: acc.resolved + r.resolved,
  }), { currentlyAssigned: 0, resolved: 0 });

  return (
    <div className="overviewPanel">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Assignments</h1>
          <p className="pageSubtitle">Who's currently holding what, and resolution throughput per agent.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="srOnly" htmlFor="assign-from">Resolved from</label>
          <input id="assign-from" type="date" className="field" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <span style={{ color: 'var(--fg-muted)' }}>to</span>
          <label className="srOnly" htmlFor="assign-to">Resolved to</label>
          <input id="assign-to" type="date" className="field" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>

      {error && <div className="banner bannerError" role="alert">{error}</div>}

      <div className="card">
        {history === null ? (
          <div className="emptyState"><span className="emptyEmoji">⏳</span><div className="emptyTitle">Loading…</div></div>
        ) : rows.length === 0 ? (
          <div className="emptyState">
            <span className="emptyEmoji">📭</span>
            <div className="emptyTitle">No assignment history yet</div>
            <div className="emptyDesc">Assign an order from the queue to start building this.</div>
          </div>
        ) : (
          <table className="overviewTable">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="thNum">Currently Assigned</th>
                <th className="thNum">Resolved{(fromDate || toDate) ? ' (range)' : ''}</th>
                <th className="thNum">Avg Time to Resolve</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email}>
                  <td><strong>{r.name}</strong></td>
                  <td className="thNum">{r.currentlyAssigned}</td>
                  <td className="thNum">{r.resolved}</td>
                  <td className="thNum">{fmtMinutes(r.avgResolveMinutes)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                <td>Team Total</td>
                <td className="thNum">{totals.currentlyAssigned}</td>
                <td className="thNum">{totals.resolved}</td>
                <td className="thNum">—</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
