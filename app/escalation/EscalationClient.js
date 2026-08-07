'use client';

// Ported from the separately-deployed standalone app in the top-level "NDR Calling"
// folder. Despite that folder's name this is the Escalation desk, not NDR Calling -
// see api/_lib/callingProcesses.json. Changes made while porting:
//   - client component, mounted ssr:false via EscalationClientLoader.js
//   - /api/orders/* -> /api/escalation/* (one dynamic-segment handler, session-gated)
//   - stylesheet scoped under .escalation-page so it cannot bleed into globals.css;
//     data-theme therefore lives on that wrapper, not document.documentElement, and
//     keyframes are prefixed esc- (see scripts/scope_escalation_css.js)
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './escalation.css';
import { useCallingSession } from '../_calling/useCallingSession';
import { initials } from './escalationHelpers';

/* ============================================================
   Constants
   ============================================================ */
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'rto', label: 'RTO' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'in transit', label: 'In Transit' },
  { value: 'pending', label: 'Pending' },
];

const PRIORITY_FILTER_OPTIONS = [
  { value: '', label: 'All Priorities' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

// Each type declares whether it needs new order ID / AWB, and if it can be bulk-applied
const RESOLVE_TYPES = [
  { value: 'Delivered',          label: 'Delivered — no replacement needed', needsOrder: false, needsAwb: false, isBulkable: true,  group: 'No Replacement' },
  { value: 'Lost in Transit',    label: 'Lost in Transit',                   needsOrder: true,  needsAwb: true,  isBulkable: false, group: 'Replacement' },
  { value: 'Cancelled',          label: 'Cancelled',                         needsOrder: true,  needsAwb: true,  isBulkable: false, group: 'Replacement' },
  { value: 'Reshipped',          label: 'Reshipped',                         needsOrder: true,  needsAwb: true,  isBulkable: false, group: 'Replacement' },
  { value: 'Replacement Sent',   label: 'Replacement Sent',                  needsOrder: true,  needsAwb: true,  isBulkable: false, group: 'Replacement' },
];

const BULK_STATUSES = RESOLVE_TYPES.filter((t) => t.isBulkable);

// Escalation tags — mark who raised a ticket so escalations can be filtered by source.
// `color` maps to a CSS variable family (danger / accent / warning).
const TAGS = [
  { key: 'sos',    label: 'SOS',              emoji: '🆘', color: 'danger'  },
  { key: 'social', label: 'Social Media',     emoji: '📢', color: 'accent'  },
  { key: 'ceo',    label: 'Founder / MD / CEO', emoji: '⭐', color: 'warning' },
];
const TAG_BY_KEY = Object.fromEntries(TAGS.map((t) => [t.key, t]));

const TAG_FILTER_OPTIONS = [
  { value: '', label: 'All Tags' },
  ...TAGS.map((t) => ({ value: t.key, label: t.label })),
];

// Availability states an agent can broadcast — matches useCallingSession's real vocabulary
// exactly (STATUS_OPTIONS in app/_calling/useCallingSession.js), not an Escalation-local set,
// since this now writes real presence RTO/NDR's own tooling reads too.
const AGENT_STATUSES = [
  { key: 'Online',  label: 'Online',   color: 'success', desc: 'Available for new tickets' },
  { key: 'OnCall',  label: 'Busy',     color: 'danger',  desc: 'On a call — do not disturb' },
  { key: 'Busy',    label: 'On Break', color: 'warning', desc: 'Away for a short while' },
  { key: 'Offline', label: 'Offline',  color: 'muted',   desc: 'Not working right now' },
];
const STATUS_BY_KEY = Object.fromEntries(AGENT_STATUSES.map((s) => [s.key, s]));

// Human-readable breadcrumb labels for each internal view.
const VIEW_LABELS = {
  queue:    'RTO Queue',
  overview: 'Overview',
  agents:   'Agent Management',
  assigns:  'Assignments',
  settings: 'Settings',
};

/* ============================================================
   Priority helper
   ============================================================ */
function getPriority(raw) {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0)  return { level: 'low',    label: 'Low',    n: 0 };
  if (n >= 3)              return { level: 'high',   label: 'High',   n };
  if (n === 2)             return { level: 'medium', label: 'Medium', n };
  return                          { level: 'low',    label: 'Low',    n };
}

// Raw call-count as a number (0 when blank/non-numeric). Used for granular sorting
// so that any difference in call counts visibly reorders the table.
function callCount(raw) {
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

/* ============================================================
   SVG Icon helper
   ============================================================ */
function Icon({ path, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d={path} />
    </svg>
  );
}

const I = {
  menu:     'M4 6h16M4 12h16M4 18h16',
  search:   'M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z',
  refresh:  'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  chevL:    'M15 18l-6-6 6-6',
  chevR:    'M9 18l6-6-6-6',
  chevUp:   'M18 15l-6-6-6 6',
  chevDown: 'M6 9l6 6 6-6',
  x:        'M18 6L6 18M6 6l12 12',
  inbox:    'M22 12h-4l-3 9L9 3l-3 9H2',
  users:    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  alert:    'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  assign:   'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  zap:      'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  flag:     'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  check:    'M20 6L9 17l-5-5',
  sort:     'M3 6h18M7 12h10M11 18h2',
  autoAssign: 'M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2zm0 12c-5.33 0-8 2.67-8 4v2h16v-2c0-1.33-2.67-4-8-4z',
  sun:      'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  moon:     'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload:   'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  file:     'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  tag:      'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  plus:     'M12 5v14M5 12h14',
};

/* ============================================================
   Priority Badge
   ============================================================ */
function PriorityBadge({ value, showCount = true }) {
  const p = getPriority(value);
  const map = {
    high:   { bg: 'var(--danger-muted)',  color: 'var(--danger)',  border: 'rgba(248,81,73,0.2)' },
    medium: { bg: 'var(--warning-muted)', color: 'var(--warning)', border: 'rgba(210,153,34,0.2)' },
    low:    { bg: 'var(--success-muted)', color: 'var(--success)', border: 'rgba(63,185,80,0.2)' },
  };
  const s = map[p.level];
  return (
    <span className="badge" title={`Called ${p.n} time${p.n !== 1 ? 's' : ''}`}
      style={{ background: s.bg, color: s.color, borderColor: s.border }}>
      {p.label}
      {showCount && p.n > 0 && (
        <span style={{ opacity: 0.6, marginLeft: 4, fontSize: 10 }}>×{p.n}</span>
      )}
    </span>
  );
}

/* ============================================================
   Overview Panel — agent performance dashboard (admin only)
   ============================================================ */
function OverviewPanel({ overview, agents, loading, resolvedCount }) {
  const { perAgent, priority, tagCounts, escalations, assignedTotal, busiest, avgLoad } = overview;
  return (
    <div className="overviewPanel">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Performance Overview</h1>
          <p className="pageSubtitle">
            Real-time agent workload, queue health, and escalation metrics
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="statsGrid">
        <StatCard variant="assigned" icon="📊" value={loading ? null : assignedTotal}
          label="Assigned Orders" sub={`${agents.length} active agents`} />
        <StatCard variant="resolved" icon="✅" value={resolvedCount}
          label="Resolved" sub="This session" />
        <StatCard variant="pending" icon="🚨" value={loading ? null : priority.high}
          label="High Priority" sub="Needs attention" />
        <StatCard variant="unassigned" icon="⚠️" value={loading ? null : escalations}
          label="Escalations" sub={`${Object.keys(tagCounts).length} tags active`} />
      </div>

      {/* Agent workload table */}
      <div className="overviewSection">
        <div className="overviewSectionHeader">
          <h2 className="overviewSectionTitle">Agent Workload Distribution</h2>
          <span className="overviewSectionMeta">
            Avg: <strong>{avgLoad}</strong> orders/agent
            {busiest && <> · Busiest: <strong>{busiest.name}</strong> ({busiest.load})</>}
          </span>
        </div>
        <div className="card">
          {loading ? (
            <SkeletonRows count={5} />
          ) : perAgent.length === 0 ? (
            <div className="emptyState">
              <span className="emptyEmoji">👥</span>
              <div className="emptyTitle">No agents</div>
              <div className="emptyDesc">Agent data unavailable.</div>
            </div>
          ) : (
            <table className="overviewTable">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Email</th>
                  <th className="thNum">Assigned</th>
                  <th className="thNum">Share</th>
                  <th>Load</th>
                </tr>
              </thead>
              <tbody>
                {perAgent.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="userAvatar" style={{ fontSize: 10, width: 24, height: 24 }}>
                          {a.avatar}
                        </div>
                        <strong>{a.name}</strong>
                      </div>
                    </td>
                    <td style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{a.email}</td>
                    <td className="thNum"><strong>{a.load}</strong></td>
                    <td className="thNum" style={{ color: 'var(--fg-muted)' }}>{a.share}%</td>
                    <td>
                      <div className="loadBar">
                        <div className="loadBarFill" style={{ width: `${a.share}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Priority distribution */}
      <div className="overviewSection">
        <div className="overviewSectionHeader">
          <h2 className="overviewSectionTitle">Queue Priority Breakdown</h2>
        </div>
        <div className="priorityGrid">
          <div className="priorityCard priorityCard--high">
            <div className="priorityCardIcon">🔥</div>
            <div className="priorityCardValue">{priority.high}</div>
            <div className="priorityCardLabel">High Priority</div>
          </div>
          <div className="priorityCard priorityCard--medium">
            <div className="priorityCardIcon">⚡</div>
            <div className="priorityCardValue">{priority.medium}</div>
            <div className="priorityCardLabel">Medium Priority</div>
          </div>
          <div className="priorityCard priorityCard--low">
            <div className="priorityCardIcon">📋</div>
            <div className="priorityCardValue">{priority.low}</div>
            <div className="priorityCardLabel">Low Priority</div>
          </div>
        </div>
      </div>

      {/* Tag/escalation summary */}
      {Object.keys(tagCounts).length > 0 && (
        <div className="overviewSection">
          <div className="overviewSectionHeader">
            <h2 className="overviewSectionTitle">Active Escalations & Tags</h2>
          </div>
          <div className="card">
            <div className="tagSummary">
              {Object.entries(tagCounts).map(([key, count]) => {
                const tag = TAG_BY_KEY[key];
                if (!tag) return null;
                return (
                  <div key={key} className="tagSummaryItem">
                    <span className={`tagBadge tagBadge--${tag.color}`}>
                      <span aria-hidden="true">{tag.emoji}</span> {tag.label}
                    </span>
                    <span className="tagSummaryCount">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Sidebar
   ============================================================ */
function Sidebar({ collapsed, isAdmin, pendingCount, view, onViewChange, user }) {
  const navItems = [
    { id: 'queue',    icon: I.inbox,    label: 'RTO Queue',        badge: pendingCount },
    ...(isAdmin ? [
      { id: 'overview', icon: I.zap,     label: 'Overview',         badge: null },
      { id: 'agents',   icon: I.users,   label: 'Agent Management', badge: null },
      { id: 'assigns',  icon: I.assign,  label: 'Assignments',      badge: null },
      { id: 'settings', icon: I.settings, label: 'Settings',        badge: null },
    ] : []),
  ];
  return (
    <aside className="sidebar">
      <div className="sidebarLogo">
        <div className="sidebarLogoMark">E</div>
        <div className="sidebarLogoText">
          <div className="sidebarLogoTitle">Escalation</div>
          <div className="sidebarLogoSub">Operations Hub</div>
        </div>
      </div>
      <nav className="sidebarNav">
        {isAdmin && <div className="navSection">Admin</div>}
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`navItem${view === item.id ? ' active' : ''}`}
            onClick={() => onViewChange(item.id)}
            title={item.label}
          >
            <span className="navItemIcon"><Icon path={item.icon} size={14} /></span>
            <span className="navItemLabel">{item.label}</span>
            {item.badge > 0 && <span className="navBadge">{item.badge > 99 ? '99+' : item.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebarFooter">
        <div className="sidebarUser">
          <div className="userAvatar">{initials(user?.name)}</div>
          <div className="userInfo">
            <div className="userName">{user?.name || 'Signed out'}</div>
            <div className="userRole">{isAdmin ? 'Administrator' : 'Support Agent'}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ============================================================
   Stat Card
   ============================================================ */
function StatCard({ variant, icon, value, label, sub }) {
  return (
    <div className={`statCard statCard--${variant}`}>
      <div className="statCardHeader">
        <span className="statCardLabel">{label}</span>
        <div className="statCardIcon">{icon}</div>
      </div>
      <div className="statCardValue">{value === null ? '—' : value}</div>
      {sub && <div className="statCardTrend">{sub}</div>}
    </div>
  );
}

/* ============================================================
   Skeleton Loader
   ============================================================ */
function SkeletonRows({ count = 7 }) {
  return (
    <div className="skeletonWrap">
      <div className="skeletonHead" />
      {Array.from({ length: count }).map((_, i) => <div key={i} className="skeletonRow" />)}
    </div>
  );
}

/* ============================================================
   Bulk Action Bar
   ============================================================ */
function BulkActionBar({ count, onApply, onClear, loading }) {
  const [bulkStatus, setBulkStatus] = useState('');

  return (
    <div className="bulkBar">
      <div className="bulkBarLeft">
        <span className="bulkCount">{count} selected</span>
        <span className="bulkDivider" />
        <span className="bulkHint">Bulk update only works for statuses that need no replacement order.</span>
      </div>
      <div className="bulkBarRight">
        <select
          className="filterSelect"
          value={bulkStatus}
          onChange={(e) => setBulkStatus(e.target.value)}
          style={{ height: 32, fontSize: 12 }}
        >
          <option value="">Select status…</option>
          {BULK_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn btnSm btnPrimary"
          disabled={!bulkStatus || loading}
          onClick={() => { onApply(bulkStatus); setBulkStatus(''); }}
        >
          {loading ? <span className="spinner" /> : <Icon path={I.check} size={12} />}
          {loading ? 'Applying…' : 'Apply'}
        </button>
        <button type="button" className="btn btnSm btnGhost" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   Import (Bulk Upload) Modal
   ============================================================ */
function ImportModal({ onClose, onImported, onToast }) {
  const [file,    setFile]    = useState(null);
  const [csvText, setCsvText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  function readFile(f) {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) {
      onToast('error', 'Please choose a .csv file');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result || '')); setFile(f); setResult(null); };
    reader.onerror = () => onToast('error', 'Could not read file');
    reader.readAsText(f);
  }

  async function handleUpload() {
    if (!csvText.trim()) { onToast('error', 'No CSV content to upload'); return; }
    setLoading(true); setResult(null);
    try {
      const res = await fetch('/api/escalation/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setResult(data);
      if (data.updated > 0) {
        onToast('success', `${data.updated} order${data.updated !== 1 ? 's' : ''} updated from CSV`);
        onImported(data.rowNumbers || []);
      } else {
        onToast('error', 'No rows matched — nothing was updated');
      }
    } catch (err) {
      onToast('error', err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalCard" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Bulk upload">
        <div className="modalHeader">
          <div className="modalTitle"><Icon path={I.upload} size={15} /> Bulk Upload</div>
          <button type="button" className="btn btnXs btnGhost" onClick={onClose} aria-label="Close"><Icon path={I.x} size={13} /></button>
        </div>

        <div className="modalBody">
          <p className="modalHint">
            Upload a CSV to resolve orders in bulk. Rows are matched by <strong>HYP_Parent_OrderID</strong> (and AWB_Number when present).
            The <strong>Status_2</strong> column is written back as the resolution status, along with New Order ID, New AWB, and Notes.
          </p>
          <a href="/api/escalation/sample" className="sampleLink" download>
            <Icon path={I.file} size={12} /> Download sample template
          </a>

          <div
            className={`dropZone${dragOver ? ' dragOver' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files?.[0]); }}
          >
            <Icon path={I.upload} size={22} />
            <div className="dropZoneText">
              {file ? file.name : 'Click to choose a CSV or drag it here'}
            </div>
            {file && <div className="dropZoneSub">Ready to upload · {(file.size / 1024).toFixed(1)} KB</div>}
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => readFile(e.target.files?.[0])}
            />
          </div>

          {result && (
            <div className="importResult">
              <div className="importResultRow">
                <span className="importStat importStatOk">{result.updated} updated</span>
                <span className="importStat importStatSkip">{result.skipped} skipped</span>
                <span className="importStat">{result.total} rows read</span>
              </div>
              {result.errors?.length > 0 && (
                <div className="importErrors">
                  {result.errors.map((e, i) => (
                    <div key={i} className="importErrorItem">
                      Line {e.line}{e.order ? ` (${e.order})` : ''}: {e.reason}
                    </div>
                  ))}
                  {result.skipped > result.errors.length && (
                    <div className="importErrorItem muted">…and {result.skipped - result.errors.length} more</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modalFooter">
          <button type="button" className="btn btnSm btnGhost" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </button>
          <button type="button" className="btn btnSm btnPrimary" onClick={handleUpload} disabled={!csvText.trim() || loading}>
            {loading ? <span className="spinner" /> : <Icon path={I.upload} size={12} />}
            {loading ? 'Uploading…' : 'Upload & Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Tag Cell — visible on main table for all rows
   ============================================================ */
function TagCell({ rowNumber, tags, onToggle }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const activeTags = TAGS.filter((t) => tags && tags.has(t.key));

  return (
    <div className="tagCell" ref={ref}>
      {activeTags.length > 0 && (
        <div className="tagList">
          {activeTags.map((t) => (
            <span key={t.key} className={`tagBadge tagBadge--${t.color}`} title={t.label}>
              <span aria-hidden="true">{t.emoji}</span>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn btnXs btnGhost tagToggle"
        onClick={() => setMenuOpen(!menuOpen)}
        title="Add or remove tags"
        aria-label="Toggle tags"
      >
        <Icon path={I.tag} size={11} />
      </button>
      {menuOpen && (
        <div className="tagMenu">
          <div className="tagMenuHeader">Mark Ticket</div>
          {TAGS.map((t) => {
            const active = tags && tags.has(t.key);
            return (
              <button
                key={t.key}
                type="button"
                className={`tagMenuItem${active ? ' tagMenuItemActive' : ''}`}
                onClick={() => {
                  onToggle(rowNumber, t.key, !active);
                  setMenuOpen(false);
                }}
              >
                <span className="tagMenuItemIcon">
                  <Icon path={active ? I.check : I.plus} size={12} />
                </span>
                <span className={`tagBadge tagBadge--${t.color}`}>
                  <span aria-hidden="true">{t.emoji}</span> {t.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Status Control — agent availability picker in the topbar
   ============================================================ */
function StatusControl({ status, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = STATUS_BY_KEY[status] || AGENT_STATUSES[0];

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="statusControl" ref={ref}>
      <button
        type="button"
        className="statusBtn"
        onClick={() => setOpen((v) => !v)}
        title={`Status: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={`statusDot statusDot--${current.color}`} />
        <span className="statusBtnLabel">{current.label}</span>
        <Icon path={I.chevDown} size={11} />
      </button>
      {open && (
        <div className="statusMenu" role="menu">
          <div className="statusMenuHeader">Set your status</div>
          {AGENT_STATUSES.map((s) => (
            <button
              key={s.key}
              type="button"
              role="menuitemradio"
              aria-checked={s.key === status}
              className={`statusMenuItem${s.key === status ? ' statusMenuItemActive' : ''}`}
              onClick={() => { onChange(s.key); setOpen(false); }}
            >
              <span className={`statusDot statusDot--${s.color}`} />
              <span className="statusMenuItemText">
                <span className="statusMenuItemLabel">{s.label}</span>
                <span className="statusMenuItemDesc">{s.desc}</span>
              </span>
              {s.key === status && <Icon path={I.check} size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Order Row
   ============================================================ */
let toastIdSeq = 1;

function OrderRow({
  order, expanded, onToggle, onSaved, onToast,
  isAdmin, agents, assignment, onAssign,
  selected, onSelect,
  tags, onToggleTag,
}) {
  const [resType,    setResType]    = useState('');
  const [newOrderId, setNewOrderId] = useState('');
  const [newAwb,     setNewAwb]     = useState('');
  const [notes,      setNotes]      = useState('');
  const [saving,     setSaving]     = useState(false);
  const [justSaved,  setJustSaved]  = useState(false);
  const [error,      setError]      = useState('');
  const [assigning,  setAssigning]  = useState(false);
  const firstRef = useRef(null);
  const fId = `row-${order.rowNumber}`;

  const resolveTypeDef = RESOLVE_TYPES.find((t) => t.value === resType);
  const needsOrder = resolveTypeDef?.needsOrder ?? false;
  const needsAwb   = resolveTypeDef?.needsAwb   ?? false;

  const canSave = resType &&
    (!needsOrder || newOrderId.trim()) &&
    (!needsAwb   || newAwb.trim()) &&
    !saving;

  const priority = getPriority(order.totalTimesConsumerReached);

  useEffect(() => {
    if (expanded && firstRef.current) firstRef.current.focus();
  }, [expanded]);

  // Reset form when collapsed
  useEffect(() => {
    if (!expanded) {
      setResType(''); setNewOrderId(''); setNewAwb(''); setNotes(''); setError('');
    }
  }, [expanded]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/escalation/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rowNumber: order.rowNumber,
          parentOrder: order.parentOrder,
          newOrderId: needsOrder ? newOrderId.trim() : '-',
          newAwb:     needsAwb   ? newAwb.trim()     : '-',
          newStatus: resType,
          notes: notes.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setJustSaved(true);
      onToast('success', `Resolved — ${order.parentOrder || 'row'} synced to sheet`);
      setTimeout(() => onSaved(order.rowNumber), 600);
    } catch (err) {
      setError(err.message);
      onToast('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAssign(e) {
    const agentId = e.target.value;
    const agent = agents.find((a) => a.email === agentId);
    setAssigning(true);
    try {
      await fetch('/api/escalation/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNumber: order.rowNumber, parentOrder: order.parentOrder, agentId: agentId || null }),
      });
      onAssign(order.rowNumber, agentId ? { agentId } : null);
      onToast('success', agentId ? `Assigned to ${agent?.name || agentId}` : 'Assignment cleared');
    } catch {
      onToast('error', 'Failed to save assignment');
    } finally { setAssigning(false); }
  }

  const loc    = [order.city, order.state].filter(Boolean).join(', ');
  const isRto  = (order.statusAsPerAwb || '').toLowerCase().includes('rto');
  const queryCat = order.queryCategory || '';
  const rowTags   = tags || new Set();
  const escalated = rowTags.has('social');

  const rowClass = [
    'dataRow',
    justSaved  ? 'saved'     : '',
    escalated  ? 'escalated' : '',
    selected   ? 'selected'  : '',
    expanded   ? 'expanded'  : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      <tr className={rowClass}>
        {/* Checkbox */}
        <td className="tdCheck">
          <input
            type="checkbox"
            className="rowCheckbox"
            checked={selected}
            onChange={(e) => onSelect(order.rowNumber, e.target.checked)}
            aria-label={`Select order ${order.parentOrder}`}
          />
        </td>

        {/* Order ID */}
        <td className="cellText cellPrimary" title={order.parentOrder}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {escalated && (
              <span className="escalationDot" title="Social media escalation" />
            )}
            {order.parentOrder || <span className="muted">—</span>}
          </div>
        </td>

        {/* Query Category */}
        <td className="cellText" title={queryCat}>
          {queryCat || <span className="muted">—</span>}
        </td>

        {/* Priority */}
        <td><PriorityBadge value={order.totalTimesConsumerReached} /></td>

        {/* Status */}
        <td>
          <span className={`badge${isRto ? ' badgeRto' : ''}`}>
            {order.statusAsPerAwb || '—'}
          </span>
        </td>

        {/* Tags — visible on the main table for agents and admins */}
        <td>
          <TagCell
            rowNumber={order.rowNumber}
            tags={rowTags}
            onToggle={onToggleTag}
          />
        </td>

        {/* Location */}
        <td className="locCell">{loc || <span className="muted">—</span>}</td>

        {/* Assigned To (admin only) */}
        {isAdmin && (
          <td>
            {assigning ? <span className="spinner spinnerMuted" /> : assignment ? (
              <span className="assignChip">
                <span className="assignChipAvatar">
                  {initials(agents.find((a) => a.email === assignment.agentId)?.name)}
                </span>
                {agents.find((a) => a.email === assignment.agentId)?.name || assignment.agentId}
              </span>
            ) : (
              <select className="assignDropdown" value="" onChange={handleAssign} aria-label="Assign agent">
                <option value="">Assign…</option>
                {agents.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
              </select>
            )}
          </td>
        )}

        {/* Action */}
        <td className="tdAction">
          {justSaved ? (
            <span className="badge badgeSuccess">Resolved ✓</span>
          ) : (
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' }}>
              {/* Clear assignment (admin) */}
              {isAdmin && assignment && (
                <button type="button" className="btn btnXs btnGhost"
                  onClick={() => handleAssign({ target: { value: '' } })} title="Clear assignment">
                  <Icon path={I.x} size={11} />
                </button>
              )}
              {/* Resolve toggle */}
              <button
                type="button"
                className={`btn btnSm ${expanded ? 'btnSecondary' : 'btnPrimary'}`}
                onClick={() => onToggle(!expanded)}
                aria-expanded={expanded}
              >
                {expanded ? 'Close' : 'Resolve'}
                <Icon path={expanded ? I.chevUp : I.chevDown} size={12} />
              </button>
            </div>
          )}
        </td>
      </tr>

      {/* Expanded resolve panel */}
      {expanded && !justSaved && (
        <tr className="expandRow">
          <td colSpan={isAdmin ? 9 : 8}>
            <div className="resolvePanel">
              {/* Context strip */}
              <div className="resolveContext">
                {[
                  ['Order',          order.parentOrder           || '—'],
                  ['Query Category', order.queryCategory         || '—'],
                  ['Ticket',         order.ticketNumber          || '—'],
                  ['Partner',        order.deliveryPartnerName   || '—'],
                  ['Location',       loc                         || '—'],
                  ['AWB',            order.awbNumber             || '—'],
                ].map(([lbl, val]) => (
                  <div key={lbl} className="resolveContextItem">
                    <span className="resolveContextLabel">{lbl}</span>
                    <span className="resolveContextValue">{val}</span>
                  </div>
                ))}
                <div className="resolveContextItem">
                  <span className="resolveContextLabel">Priority</span>
                  <span className="resolveContextValue">
                    <PriorityBadge value={order.totalTimesConsumerReached} showCount={false} />
                  </span>
                </div>
                {rowTags.size > 0 && (
                  <div className="resolveContextItem">
                    <span className="resolveContextLabel">Tags</span>
                    <span className="resolveContextValue">
                      <span className="tagList">
                        {TAGS.filter((t) => rowTags.has(t.key)).map((t) => (
                          <span key={t.key} className={`tagBadge tagBadge--${t.color}`}>
                            <span aria-hidden="true">{t.emoji}</span> {t.label}
                          </span>
                        ))}
                      </span>
                    </span>
                  </div>
                )}
              </div>

              {/* Form section */}
              <div className="resolvePanelHeader">Resolution Details</div>

              <form className="resolveForm" onSubmit={handleSubmit}
                onKeyDown={(e) => e.key === 'Escape' && onToggle(false)}>

                {/* Step 1: Resolution type */}
                <div className="resolveField resolveFieldType">
                  <label htmlFor={`${fId}-type`}>Resolution Type <span className="reqStar">*</span></label>
                  <select
                    id={`${fId}-type`}
                    ref={firstRef}
                    className="field"
                    value={resType}
                    onChange={(e) => { setResType(e.target.value); setNewOrderId(''); setNewAwb(''); }}
                  >
                    <option value="">Select resolution type…</option>
                    <optgroup label="— No replacement needed">
                      {RESOLVE_TYPES.filter((t) => !t.needsOrder).map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="— Replacement required">
                      {RESOLVE_TYPES.filter((t) => t.needsOrder).map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                {/* Step 2: Conditional fields — only shown when replacement needed */}
                {needsOrder && (
                  <div className="resolveField">
                    <label htmlFor={`${fId}-order`}>New Order ID <span className="reqStar">*</span></label>
                    <input
                      id={`${fId}-order`}
                      className="field"
                      value={newOrderId}
                      onChange={(e) => setNewOrderId(e.target.value)}
                      placeholder="e.g. HYP31900000"
                      disabled={saving}
                    />
                  </div>
                )}

                {needsAwb && (
                  <div className="resolveField">
                    <label htmlFor={`${fId}-awb`}>New AWB / Tracking <span className="reqStar">*</span></label>
                    <input
                      id={`${fId}-awb`}
                      className="field"
                      value={newAwb}
                      onChange={(e) => setNewAwb(e.target.value)}
                      placeholder="Replacement tracking no."
                      disabled={saving}
                    />
                  </div>
                )}

                {/* Delivered message — no extra fields */}
                {resType === 'Delivered' && (
                  <div className="resolveInfoBox">
                    <Icon path={I.check} size={12} />
                    Marking as delivered — no replacement order or AWB needed.
                  </div>
                )}

                {/* Notes — always optional */}
                <div className="resolveField resolveFieldNotes">
                  <label htmlFor={`${fId}-notes`}>
                    Notes <span style={{ opacity: 0.45, fontWeight: 400 }}>(optional)</span>
                  </label>
                  <input
                    id={`${fId}-notes`}
                    className="field"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any remarks…"
                    disabled={saving}
                  />
                </div>

                <div className="resolveActions">
                  <button type="button" className="btn btnSm btnGhost"
                    onClick={() => onToggle(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btnSm btnPrimary" disabled={!canSave}>
                    {saving && <span className="spinner" />}
                    {saving ? 'Saving…' : 'Mark Resolved'}
                  </button>
                </div>
              </form>

              {error && (
                <div className="rowError" role="alert">
                  <Icon path={I.alert} size={12} /> {error}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ============================================================
   Main Page
   ============================================================ */
export default function EscalationClient() {
  const session = useCallingSession('escalation', {});
  const {
    googleUser, sessionIsAdmin, isProcessAdmin,
    processAgents, saveProcessAgent, savingAgentEmail,
    agentStatus, serverPresence, setStatus, setStatusForAgent,
  } = session;
  const isAdmin = sessionIsAdmin || isProcessAdmin;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme,            setTheme]            = useState('light');
  const [view,             setView]             = useState('queue'); // 'queue' | 'overview' | 'agents' | 'assigns' | 'settings'

  const [orders,      setOrders]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [toasts,      setToasts]      = useState([]);

  // Filters
  const [search,         setSearch]         = useState('');
  const [filterStatus,   setFilterStatus]   = useState('');
  const [filterPartner,  setFilterPartner]  = useState('');
  const [filterAgent,    setFilterAgent]    = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterTag,      setFilterTag]      = useState('');

  // Sort
  const [sortDir, setSortDir] = useState('desc'); // 'desc'=high first, 'asc'=low first, null=off

  // Pagination
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Row state
  const [expandedRow,   setExpandedRow]   = useState(null);
  const [selectedRows,  setSelectedRows]  = useState(new Set());
  // Tags: Map<rowNumber, Set<tagKey>>. Any row carrying the 'social' tag is
  // also treated as an escalation (keeps the red row accent behaviour).
  const [taggedRows,    setTaggedRows]    = useState(new Map());

  // Data
  const [agents,       setAgents]       = useState([]);
  const [assignments,  setAssignments]  = useState({});
  const [resolvedCount, setResolvedCount] = useState(0);

  // Theme lives on this page's own wrapper, not document.documentElement — the
  // stylesheet is scoped under .escalation-page so a root attribute would have
  // nothing to match, and would leak this page's theme to the rest of the app.
  function toggleTheme() {
    setTheme((t) => t === 'dark' ? 'light' : 'dark');
  }

  // Bulk
  const [bulkLoading, setBulkLoading] = useState(false);

  // Bulk import / export
  const [showImport, setShowImport] = useState(false);
  const [exporting,  setExporting]  = useState(false);

  // Auto-assign
  const [autoAssigning, setAutoAssigning] = useState(false);

  /* --- Toasts --- */
  const showToast = useCallback((type, message) => {
    const id = toastIdSeq++;
    setToasts((p) => [...p, { id, type, message }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3500);
  }, []);

  /* --- Load --- */
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [ordersRes, assignRes] = await Promise.all([
        fetch('/api/escalation/orders'),
        fetch('/api/escalation/assign'),
      ]);
      const od = await ordersRes.json();
      const ad = await assignRes.json();
      if (!ordersRes.ok) throw new Error(od.error || 'Failed to load');
      setOrders(od.orders);
      setAssignments(ad.assignments || {});
      setSelectedRows(new Set());
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetch('/api/escalation/agents').then((r) => r.json()).then((d) => setAgents(d.agents || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  // Overview / Agent Management / Assignments / Settings are admin-only — bounce agents
  // back to the queue.
  useEffect(() => {
    if (!isAdmin && (view === 'overview' || view === 'agents' || view === 'assigns' || view === 'settings')) {
      setView('queue');
    }
  }, [isAdmin, view]);

  /* --- Handlers --- */
  function handleSaved(rowNumber) {
    setOrders((p) => p.filter((o) => o.rowNumber !== rowNumber));
    setExpandedRow(null);
    setSelectedRows((p) => { const n = new Set(p); n.delete(rowNumber); return n; });
    setResolvedCount((c) => c + 1);
  }

  function handleAssign(rowNumber, data) {
    setAssignments((p) => {
      const n = { ...p };
      if (data) n[rowNumber] = data; else delete n[rowNumber];
      return n;
    });
  }

  function handleSelect(rowNumber, checked) {
    setSelectedRows((p) => { const n = new Set(p); checked ? n.add(rowNumber) : n.delete(rowNumber); return n; });
  }

  function handleSelectAll(checked, rows) {
    setSelectedRows(checked ? new Set(rows.map((o) => o.rowNumber)) : new Set());
  }

  function handleToggleTag(rowNumber, tagKey, flag) {
    setTaggedRows((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(rowNumber) || []);
      if (flag) set.add(tagKey); else set.delete(tagKey);
      if (set.size) next.set(rowNumber, set); else next.delete(rowNumber);
      return next;
    });
    if (flag) {
      const t = TAG_BY_KEY[tagKey];
      showToast('success', `Tagged ${rowNumber} as ${t ? t.label : tagKey}`);
    }
  }

  /* --- Bulk update --- */
  async function handleBulkApply(status) {
    const items = Array.from(selectedRows).map((rowNumber) => ({
      rowNumber,
      parentOrder: orders.find((o) => o.rowNumber === rowNumber)?.parentOrder,
    }));
    setBulkLoading(true);
    try {
      const res = await fetch('/api/escalation/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk update failed');
      setOrders((p) => p.filter((o) => !selectedRows.has(o.rowNumber)));
      setResolvedCount((c) => c + items.length);
      setSelectedRows(new Set());
      showToast('success', `${data.updated} orders marked as "${status}"`);
    } catch (err) {
      showToast('error', err.message);
    } finally { setBulkLoading(false); }
  }

  /* --- Bulk download (CSV export) --- */
  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch('/api/escalation/export');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'escalation-orders.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('success', `Exported ${orders.length} orders to CSV`);
    } catch (err) {
      showToast('error', err.message);
    } finally { setExporting(false); }
  }

  /* --- Bulk upload result --- */
  function handleImported(rowNumbers) {
    if (rowNumbers?.length) {
      const done = new Set(rowNumbers.map(String));
      setOrders((p) => p.filter((o) => !done.has(String(o.rowNumber))));
      setResolvedCount((c) => c + rowNumbers.length);
      setSelectedRows((p) => {
        const n = new Set(p);
        rowNumbers.forEach((r) => n.delete(r));
        return n;
      });
    }
  }

  /* --- Auto-assign --- */
  async function handleAutoAssign() {
    if (!isAdmin && !googleUser?.email) return;

    setAutoAssigning(true);
    try {
      const unassigned = orders.filter((o) => !assignments[o.rowNumber]);
      if (unassigned.length === 0) { showToast('success', 'All orders already assigned!'); return; }

      if (!isAdmin) {
        // Assign all unassigned to self
        const updates = unassigned.map((o) =>
          fetch('/api/escalation/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowNumber: o.rowNumber, parentOrder: o.parentOrder, agentId: googleUser.email }),
          })
        );
        await Promise.all(updates);
        const newMap = {};
        unassigned.forEach((o) => { newMap[o.rowNumber] = { agentId: googleUser.email }; });
        setAssignments((p) => ({ ...p, ...newMap }));
        showToast('success', `Auto-assigned ${unassigned.length} orders to you`);
      } else {
        // Admin: round-robin across all agents
        if (agents.length === 0) { showToast('error', 'No agents available'); return; }
        const updates = unassigned.map((o, i) => {
          const agent = agents[i % agents.length];
          return fetch('/api/escalation/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowNumber: o.rowNumber, parentOrder: o.parentOrder, agentId: agent.email }),
          }).then(() => ({ rowNumber: o.rowNumber, agentId: agent.email }));
        });
        const results = await Promise.all(updates);
        const newMap = {};
        results.forEach(({ rowNumber, agentId }) => { newMap[rowNumber] = { agentId }; });
        setAssignments((p) => ({ ...p, ...newMap }));
        showToast('success', `Auto-assigned ${unassigned.length} orders (round-robin across ${agents.length} agents)`);
      }
    } catch { showToast('error', 'Auto-assign failed'); }
    finally { setAutoAssigning(false); }
  }

  /* --- Derived --- */
  const partnerOptions = useMemo(() => {
    const s = new Set(orders.map((o) => o.deliveryPartnerName).filter(Boolean));
    return Array.from(s).sort();
  }, [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = orders.filter((o) => {
      if (q) {
        const hit = [o.parentOrder, o.awbNumber, o.deliveryPartnerName, o.city, o.state, o.ticketNumber, o.queryCategory]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
        if (!hit) return false;
      }
      if (filterStatus   && !String(o.statusAsPerAwb || '').toLowerCase().includes(filterStatus)) return false;
      if (filterPartner  && o.deliveryPartnerName !== filterPartner) return false;
      if (filterPriority && getPriority(o.totalTimesConsumerReached).level !== filterPriority) return false;
      if (filterAgent) {
        const asgn = assignments[o.rowNumber];
        if (!asgn || asgn.agentId !== filterAgent) return false;
      }
      if (filterTag) {
        const tags = taggedRows.get(o.rowNumber);
        if (!tags || !tags.has(filterTag)) return false;
      }
      return true;
    });

    // Priority sort — order by the raw call-count so any difference in counts
    // visibly reorders the table (a 3-bucket rank left most rows tied).
    if (sortDir) {
      list = [...list].sort((a, b) => {
        let diff = callCount(b.totalTimesConsumerReached) - callCount(a.totalTimesConsumerReached);
        if (diff === 0) {
          // Stable tie-break: keep newest queries first so equal counts still order predictably.
          diff = String(b.queryDate || '').localeCompare(String(a.queryDate || ''));
        }
        return sortDir === 'desc' ? diff : -diff;
      });
    }
    return list;
  }, [orders, search, filterStatus, filterPartner, filterPriority, filterAgent, filterTag, taggedRows, assignments, sortDir]);

  useEffect(() => { setPage(1); }, [search, filterStatus, filterPartner, filterPriority, filterAgent, filterTag, pageSize, orders.length]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage   = Math.min(page, totalPages);
  const startIdx   = (safePage - 1) * pageSize;
  const pageItems  = filtered.slice(startIdx, startIdx + pageSize);
  const rangeStart = filtered.length === 0 ? 0 : startIdx + 1;
  const rangeEnd   = Math.min(startIdx + pageSize, filtered.length);

  // Stats
  const totalPending    = orders.length;
  const assignedCount   = Object.keys(assignments).filter((k) => orders.some((o) => String(o.rowNumber) === String(k))).length;
  const unassignedCount = totalPending - assignedCount;
  const highCount       = orders.filter((o) => getPriority(o.totalTimesConsumerReached).level === 'high').length;

  const allPageSelected = pageItems.length > 0 && pageItems.every((o) => selectedRows.has(o.rowNumber));
  const somePageSelected = pageItems.some((o) => selectedRows.has(o.rowNumber));

  /* --- Overview stats (derived from what we can actually track) --- */
  const overview = useMemo(() => {
    // Per-agent workload: count live orders currently assigned to each agent.
    const load = Object.fromEntries(agents.map((a) => [a.id, 0]));
    orders.forEach((o) => {
      const asgn = assignments[o.rowNumber];
      if (asgn && load[asgn.agentId] != null) load[asgn.agentId] += 1;
    });

    // Priority distribution across the live queue.
    const priority = { high: 0, medium: 0, low: 0 };
    orders.forEach((o) => {
      const level = getPriority(o.totalTimesConsumerReached).level;
      if (priority[level] != null) priority[level] += 1;
    });

    // Escalation / tag counts across the queue.
    const tagCounts = {};
    let escalations = 0;
    taggedRows.forEach((set) => {
      set.forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; escalations += 1; });
    });

    const assignedTotal = orders.filter((o) => assignments[o.rowNumber]).length;
    const perAgent = agents.map((a) => ({
      ...a,
      load: load[a.id] || 0,
      share: assignedTotal ? Math.round(((load[a.id] || 0) / assignedTotal) * 100) : 0,
    })).sort((x, y) => y.load - x.load);

    const busiest = perAgent[0] && perAgent[0].load > 0 ? perAgent[0] : null;
    const avgLoad = agents.length ? Math.round((assignedTotal / agents.length) * 10) / 10 : 0;

    return { perAgent, priority, tagCounts, escalations, assignedTotal, busiest, avgLoad };
  }, [agents, orders, assignments, taggedRows]);

  // Sort icon — desc = high first, asc = low first
  const SortIcon = () => (
    sortDir === 'asc'
      ? <Icon path={I.chevUp} size={11} />
      : <Icon path={I.chevDown} size={11} />
  );

  function cycleSortDir() {
    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
  }

  /* --- Active filters (visible + clearable) --- */
  const activeFilters = [];
  if (search.trim())   activeFilters.push({ key: 'search',   label: `Search: "${search.trim()}"`, clear: () => setSearch('') });
  if (filterStatus)    activeFilters.push({ key: 'status',   label: `Status: ${STATUS_FILTER_OPTIONS.find((o) => o.value === filterStatus)?.label || filterStatus}`, clear: () => setFilterStatus('') });
  if (filterPriority)  activeFilters.push({ key: 'priority', label: `Priority: ${PRIORITY_FILTER_OPTIONS.find((o) => o.value === filterPriority)?.label || filterPriority}`, clear: () => setFilterPriority('') });
  if (filterPartner)   activeFilters.push({ key: 'partner',  label: `Partner: ${filterPartner}`, clear: () => setFilterPartner('') });
  if (filterAgent)     activeFilters.push({ key: 'agent',    label: `Agent: ${agents.find((a) => a.id === filterAgent)?.name || filterAgent}`, clear: () => setFilterAgent('') });
  if (filterTag)       activeFilters.push({ key: 'tag',      label: `Tag: ${TAG_BY_KEY[filterTag]?.label || filterTag}`, clear: () => setFilterTag('') });

  function clearAllFilters() {
    setSearch(''); setFilterStatus(''); setFilterPriority(''); setFilterPartner(''); setFilterAgent(''); setFilterTag('');
  }

  return (
    // .escalation-page is the scope every rule in escalation.css hangs off. It has to
    // be its own element wrapping appShell rather than a class merged onto it, because
    // the stylesheet has `.sidebarCollapsed .sidebar`-style descendant selectors that
    // would stop matching if the two were the same node.
    <div className="escalation-page" data-theme={theme}>
    <div className={`appShell${sidebarCollapsed ? ' sidebarCollapsed' : ''}`}>
      <Sidebar collapsed={sidebarCollapsed} isAdmin={isAdmin} pendingCount={totalPending}
        view={view} onViewChange={setView} user={googleUser} />

      <div className="mainContent">
        {/* Topbar */}
        <header className="topbar">
          <div className="topbarLeft">
            <button type="button" className="collapseBtn"
              onClick={() => setSidebarCollapsed((c) => !c)} aria-label="Toggle sidebar">
              <Icon path={I.menu} size={13} />
            </button>
            <div className="breadcrumb">
              <span className="breadcrumbItem">Escalation</span>
              <span className="breadcrumbSep">/</span>
              <span className="breadcrumbCurrent">{VIEW_LABELS[view] || 'RTO Queue'}</span>
            </div>
          </div>
          <div className="topbarRight">
            {/* Availability status */}
            <StatusControl status={agentStatus} onChange={setStatus} />
            {/* Theme toggle */}
            <button type="button" className="topbarBtn themeToggle" onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              <Icon path={theme === 'dark' ? I.sun : I.moon} size={13} />
            </button>
            <button type="button" className="topbarBtn" onClick={load} disabled={loading} title="Refresh">
              {/* esc-spin, not spin — keyframes are prefixed when the stylesheet is scoped */}
              <span style={{ display: 'flex', animation: loading ? 'esc-spin 0.8s linear infinite' : 'none' }}>
                <Icon path={I.refresh} size={13} />
              </span>
            </button>
            <div className="userAvatar" style={{ cursor: 'default' }} title={googleUser?.name}>
              {initials(googleUser?.name)}
            </div>
          </div>
        </header>

        <main className="pageBody">
          {view === 'overview' ? (
            <OverviewPanel overview={overview} agents={agents} loading={loading} resolvedCount={resolvedCount} />
          ) : view === 'queue' ? (
            <>
          {/* Page header */}
          <div className="pageHeader">
            <div>
              <h1 className="pageTitle">RTO Action Queue</h1>
              <p className="pageSubtitle">
                Google Sheet-backed resolution · sorted by priority · {totalPending} orders pending
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Bulk download */}
              <button
                type="button"
                className="btn btnSecondary"
                onClick={handleExport}
                disabled={exporting || loading || orders.length === 0}
                title="Download eligible orders as CSV"
                style={{ fontSize: 12 }}
              >
                {exporting ? <span className="spinner spinnerMuted" /> : <Icon path={I.download} size={13} />}
                {exporting ? 'Exporting…' : 'Download CSV'}
              </button>
              {/* Bulk upload (admin only) */}
              {isAdmin && (
                <button
                  type="button"
                  className="btn btnSecondary"
                  onClick={() => setShowImport(true)}
                  disabled={loading}
                  title="Upload a CSV to resolve orders in bulk"
                  style={{ fontSize: 12 }}
                >
                  <Icon path={I.upload} size={13} />
                  Upload CSV
                </button>
              )}
              {/* Auto-assign button */}
              <button
                type="button"
                className="btn btnSecondary"
                onClick={handleAutoAssign}
                disabled={autoAssigning || loading || orders.length === 0}
                title={isAdmin ? 'Round-robin assign to all agents' : 'Assign all unassigned to me'}
                style={{ fontSize: 12 }}
              >
                {autoAssigning ? <span className="spinner spinnerMuted" /> : <Icon path={I.autoAssign} size={13} />}
                {autoAssigning ? 'Assigning…' : isAdmin ? 'Auto-Assign All' : 'Auto-Assign My Queue'}
              </button>
              <div className="livePill">
                <span className="pulseDot" />
                Live
              </div>
            </div>
          </div>

          {isAdmin && (
            <div className="adminBanner">
              <Icon path={I.users} size={12} />
              Admin mode — assign leads, bulk update, and manage all agents.
            </div>
          )}

          {error && (
            <div className="banner bannerError" role="alert">
              <Icon path={I.alert} size={12} /> {error}
            </div>
          )}

          {/* Stat cards */}
          <div className="statsGrid">
            <StatCard variant="pending"    icon="🚨" value={loading ? null : totalPending}    label="Total Pending"   sub="Needs resolution" />
            <StatCard variant="unassigned" icon="⏳" value={loading ? null : unassignedCount} label="Unassigned"      sub="No agent yet" />
            <StatCard variant="assigned"   icon="👤" value={loading ? null : assignedCount}   label="Assigned"        sub="In progress" />
            <StatCard variant="resolved"   icon="✅" value={resolvedCount}                    label="Resolved"        sub="This session" />
          </div>

          {/* Toolbar */}
          <div className="toolbar">
            {/* Search */}
            <div className="searchWrap">
              <span className="searchIcon"><Icon path={I.search} size={13} /></span>
              <label htmlFor="order-search" className="srOnly">Search orders</label>
              <input id="order-search" className="searchInput"
                placeholder="Search order, AWB, category, city…"
                value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (
                <button type="button" className="searchClear" onClick={() => setSearch('')} aria-label="Clear">✕</button>
              )}
            </div>

            {/* Status filter */}
            <select className={`filterSelect${filterStatus ? ' filterSelectActive' : ''}`} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} aria-label="Filter status">
              {STATUS_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            {/* Priority filter */}
            <select className={`filterSelect${filterPriority ? ' filterSelectActive' : ''}`} value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} aria-label="Filter priority">
              {PRIORITY_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            {/* Tag filter */}
            <select className={`filterSelect${filterTag ? ' filterSelectActive' : ''}`} value={filterTag} onChange={(e) => setFilterTag(e.target.value)} aria-label="Filter tag">
              {TAG_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            {/* Partner filter */}
            <select className={`filterSelect${filterPartner ? ' filterSelectActive' : ''}`} value={filterPartner} onChange={(e) => setFilterPartner(e.target.value)} aria-label="Filter partner">
              <option value="">All Partners</option>
              {partnerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>

            {/* Agent filter (admin) */}
            {isAdmin && agents.length > 0 && (
              <select className={`filterSelect${filterAgent ? ' filterSelectActive' : ''}`} value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)} aria-label="Filter agent">
                <option value="">All Agents</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}

            <span className="statPill">
              <span className="dot" />
              {loading ? '…' : `${filtered.length} of ${orders.length}`}
              {highCount > 0 && !loading && (
                <span style={{ color: 'var(--danger)', marginLeft: 6, fontSize: 10, fontWeight: 600 }}>
                  {highCount} high
                </span>
              )}
            </span>
          </div>

          {/* Active filter chips */}
          {activeFilters.length > 0 && (
            <div className="filterChips">
              <span className="filterChipsLabel">Filters:</span>
              {activeFilters.map((f) => (
                <button key={f.key} type="button" className="filterChip" onClick={f.clear} title="Remove filter">
                  {f.label}
                  <Icon path={I.x} size={10} />
                </button>
              ))}
              <button type="button" className="filterChipClear" onClick={clearAllFilters}>
                Clear all
              </button>
            </div>
          )}

          {/* Bulk action bar */}
          {selectedRows.size > 0 && (
            <BulkActionBar
              count={selectedRows.size}
              onApply={handleBulkApply}
              onClear={() => setSelectedRows(new Set())}
              loading={bulkLoading}
            />
          )}

          {/* Table card */}
          <div className="card">
            {loading ? (
              <SkeletonRows count={7} />
            ) : filtered.length === 0 ? (
              <div className="emptyState">
                <span className="emptyEmoji">{orders.length === 0 ? '✅' : '🔍'}</span>
                <div className="emptyTitle">{orders.length === 0 ? 'All clear' : 'No matches'}</div>
                <div className="emptyDesc">
                  {orders.length === 0 ? 'No orders need action right now.' : 'Try adjusting your search or filters.'}
                </div>
              </div>
            ) : (
              <>
                <div className="tableWrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col" className="thCheck">
                          <input type="checkbox" className="rowCheckbox"
                            checked={allPageSelected}
                            ref={(el) => { if (el) el.indeterminate = somePageSelected && !allPageSelected; }}
                            onChange={(e) => handleSelectAll(e.target.checked, pageItems)}
                            aria-label="Select all on page"
                          />
                        </th>
                        <th scope="col">Parent Order</th>
                        <th scope="col">Query Category</th>
                        <th scope="col" className={`thSortable${sortDir ? ' thSorted' : ''}`} onClick={cycleSortDir}
                          title={sortDir === 'asc' ? 'Sorted low → high · click for high → low' : 'Sorted high → low · click for low → high'}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            Priority <SortIcon />
                          </span>
                        </th>
                        <th scope="col">Status</th>
                        <th scope="col">Tags</th>
                        <th scope="col">Location</th>
                        {isAdmin && <th scope="col">Assigned To</th>}
                        <th scope="col" className="thAction">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageItems.map((o) => (
                        <OrderRow
                          key={o.rowNumber}
                          order={o}
                          expanded={expandedRow === o.rowNumber}
                          onToggle={(next) => setExpandedRow(next ? o.rowNumber : null)}
                          onSaved={handleSaved}
                          onToast={showToast}
                          isAdmin={isAdmin}
                          agents={agents}
                          assignment={assignments[o.rowNumber] || null}
                          onAssign={handleAssign}
                          selected={selectedRows.has(o.rowNumber)}
                          onSelect={handleSelect}
                          tags={taggedRows.get(o.rowNumber)}
                          onToggleTag={handleToggleTag}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="pagination">
                  <span className="paginationInfo">{rangeStart}–{rangeEnd} of {filtered.length} orders</span>
                  <div className="paginationControls">
                    <label htmlFor="page-size" className="srOnly">Rows per page</label>
                    <select id="page-size" className="pageSizeSelect" value={pageSize}
                      onChange={(e) => setPageSize(Number(e.target.value))}>
                      {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
                    </select>
                    <button type="button" className="btn btnSm btnIcon"
                      onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} aria-label="Previous">
                      <Icon path={I.chevL} size={12} />
                    </button>
                    <span className="paginationPage">{safePage} / {totalPages}</span>
                    <button type="button" className="btn btnSm btnIcon"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} aria-label="Next">
                      <Icon path={I.chevR} size={12} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
            </>
          ) : (
            <div className="pageHeader">
              <div>
                <h1 className="pageTitle">{VIEW_LABELS[view] || 'Coming Soon'}</h1>
                <p className="pageSubtitle">
                  {view === 'agents'   && 'Agent roster management — coming soon.'}
                  {view === 'assigns'  && 'Assignment overview — coming soon.'}
                  {view === 'settings' && 'Workspace settings — coming soon.'}
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Toasts */}
      <div className="toastStack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type === 'success' ? 'toastSuccess' : 'toastError'}`}>
            <div className="toastIndicator" />
            <div className="toastBody">
              <div className="toastTitle">{t.type === 'success' ? 'Success' : 'Error'}</div>
              <div className="toastMsg">{t.message}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Import modal */}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={handleImported}
          onToast={showToast}
        />
      )}
    </div>
    </div>
  );
}
