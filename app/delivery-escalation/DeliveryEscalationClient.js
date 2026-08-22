'use client';

// Delivery-Escalation's own independent workspace - modeled on app/ndr-calling/NdrCallingClient.js
// (claim a row, record a resolution). Deliberately NOT built on the shared
// app/_calling/useCallingSession.js: this process has no Postgres-backed roster, presence,
// quota, business hours, or round-robin assignment robot - see
// api/_lib/callingProcesses.json's "deliveryescalation" entry for why. It DOES reuse one piece of
// app/_calling/CallingAdminPanel.js - useProcessDispositions/ProcessDispositionsCard, the same
// admin-configurable disposition tree NDR's Admin Panel uses - since an outcome list an admin can
// shape without a code change is worth the one Postgres table (calling_process_dispositions) it
// costs; CallingHoursCard and the roster table are NOT used, on purpose. Access is still gated the
// same way everything else in this app is: report_tab_permissions, checked server-side by
// api/delivery-escalation/sheet.js and api/delivery-escalation/record.js.
//
// One data source: MySQL PEP_CLS.Delivery_escalation, via api/delivery-escalation/record.js.
// Outcome blank/RTO/Escalated is Fresh, outcome Delivered is Resolved, and claim/dispose write
// straight to that row - no sheet cell involved, same model as the RTO calling process's own
// CLS_RTO_calling table. The Google Sheet is no longer read here at all: it still feeds this
// table (the 2-hourly cron mirror, scripts/sync_delivery_tickets_to_sheet.py), but nothing on
// this page depends on reading it back.
//
// Paging, filtering and searching all happen SERVER-side (see db.js's own header comment). The
// browser holds one page of rows, never the whole table - which is what keeps the response
// inside Lambda's 6MB cap however large this table grows. There is no per-agent row scoping:
// everyone invited to this process sees the whole shared desk, admin or not, since tickets are
// self-claimed from a common unassigned pool - the Agent filter narrows the view by choice.
import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { CustomSelect, CheckIcon, XIcon, RefreshIcon, Overlay } from '../_calling/ui';
import { useProcessDispositions, ProcessDispositionsCard } from '../_calling/CallingAdminPanel';
import { safeStorage } from '../_calling/util';

const BRANDS = ['HYPHEN', 'mCaffeine'];
const CARD_KEY = 'calling';
const TAB_KEY = 'deliveryescalation';

// One shared mapping for both tabs - the same SELECT backs Fresh and Resolved (see db.js's
// DE_SELECT_COLUMNS), so there's no reason for two row shapes. readOnly is the only thing that
// differs: a Resolved ticket is already Delivered, so there's nothing left to action on it.
function mapRow(row, readOnly) {
  return {
    id: row.id, mysqlId: row.id, readOnly,
    brand: row.brand, orderId: row.order_id, awb: row.awb_code || '',
    deliveryPartner: row.delivery_partner || '', queryClass: row.query_class || '',
    queryCategory: row.query_category || '',
    statusAsPerAwb: row.status_as_per_awb || '', tat: row.tat || '',
    ticketNumber: row.ticket_number || '', assignedAgent: row.agent_email || '',
    addedDate: row.added_date ? new Date(row.added_date).toLocaleDateString('en-GB') : '',
    actionDate: row.disposed_at ? new Date(row.disposed_at).toLocaleDateString('en-GB') : '',
    outcome: row.outcome || '', childDisposition: row.child_disposition || '',
    remarks: row.agent_remarks || '',
    tatBucket: row.tat_bucket || '',
    // How many tickets share this AWB, and when the customer FIRST came about it - both are
    // aggregates maintained by the sync (see scripts/delivery_escalation_contact_stats.py),
    // not properties of this row alone.
    contactCount: row.contact_count == null ? '' : row.contact_count,
    firstContactDate: row.first_added_date ? new Date(row.first_added_date).toLocaleDateString('en-GB') : '',
  };
}

// record.js's own catch puts the real exception message in the body - surface that rather than
// a bare status code, so a failure is diagnosable from the error banner alone without needing
// Lambda CloudWatch access.
async function getJson(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

// 'YYYY-MM-DD' (what op=daywise returns) -> 'Jul 10, 2026' for the day-wise TAT table.
function formatDaywiseDate(d) {
  if (!d) return d;
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The exact string checkAccess() in record.js/sheet.js sends when getSession(req) comes back
// null - a cookie that expired (7-day Max-Age; this page is the kind of tab an agent leaves
// open for days) or was cleared, NOT a permission problem. Distinguishing it matters: every
// other failure here is worth retrying (a blip, a slow query), but this one never recovers on
// its own - retrying just repeats "Not authenticated" every 15-60s forever with no way for the
// agent to tell that from a real outage. See sessionExpired below for what happens once this
// is seen.
const AUTH_ERROR_MESSAGE = 'Not authenticated';
function isSessionExpired(err) {
  return err?.message === AUTH_ERROR_MESSAGE;
}

// Sums a set of day-level {counts, total} entries (already computed server-side per day) into
// one aggregate, recomputing pct against THIS group's own total - the same "% of this row's own
// total" rule the day rows already use, just applied at whichever level is being summed.
function sumDaywiseRows(dayRows, buckets) {
  const counts = {};
  buckets.forEach((b) => { counts[b] = 0; });
  let total = 0;
  for (const r of dayRows) {
    buckets.forEach((b) => { counts[b] += r.counts[b] || 0; });
    total += r.total;
  }
  const pct = Object.fromEntries(buckets.map((b) => [b, total ? Math.round((counts[b] / total) * 100) : 0]));
  return { counts, total, pct };
}

// Groups the flat day-level rows the server returns into Month -> Week -of-month -> Day, purely
// client-side - the server keeps returning one row per real date (needed for the exact per-day
// numbers), and this just re-buckets what's already there for the drill-down UI. Week is
// "days 1-7 of the month = week 1, 8-14 = week 2, ..." rather than a calendar/ISO week
// (which can straddle two months) - it keeps every week fully nested inside one month, matching
// month -> week -> day as a strict hierarchy with no row that has two parents.
function groupDaywiseRows(dayRows, buckets) {
  const months = new Map();
  for (const r of dayRows) {
    const [y, m, d] = r.date.split('-').map(Number);
    const monthKey = `${y}-${String(m).padStart(2, '0')}`;
    const weekOfMonth = Math.ceil(d / 7);
    const weekKey = `${monthKey}-W${weekOfMonth}`;
    if (!months.has(monthKey)) months.set(monthKey, { key: monthKey, weeks: new Map() });
    const month = months.get(monthKey);
    if (!month.weeks.has(weekKey)) month.weeks.set(weekKey, { key: weekKey, weekOfMonth, days: [] });
    month.weeks.get(weekKey).days.push(r);
  }
  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key)).map((month) => {
    const weeks = [...month.weeks.values()].sort((a, b) => a.weekOfMonth - b.weekOfMonth).map((week) => {
      const days = [...week.days].sort((a, b) => a.date.localeCompare(b.date));
      return { ...week, days, ...sumDaywiseRows(days, buckets) };
    });
    const allDays = weeks.flatMap((w) => w.days);
    return { ...month, weeks, ...sumDaywiseRows(allDays, buckets) };
  });
}

function formatDaywiseMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// "Week 2 (Jul 8-14)" - the day range read off the week's own first/last day rather than a
// fixed 7-day span, since a month's final week is often shorter.
function formatDaywiseWeek(week) {
  const first = week.days[0]?.date, last = week.days[week.days.length - 1]?.date;
  const dayNum = (d) => Number(d.split('-')[2]);
  const range = first && last ? (first === last ? `${dayNum(first)}` : `${dayNum(first)}-${dayNum(last)}`) : '';
  return `Week ${week.weekOfMonth}${range ? ` (${formatDaywiseDate(first).split(' ')[0]} ${range})` : ''}`;
}

function filterQuery({ view, search, brand, agent }) {
  const p = new URLSearchParams();
  if (view) p.set('view', view);
  if (search) p.set('search', search);
  if (brand && brand !== 'ALL') p.set('brand', brand);
  if (agent && agent !== 'ALL') p.set('agent', agent);
  return p;
}

// One page of whichever tab is open, with the current filters applied server-side.
async function fetchPage({ view, page, perPage, search, brand, agent }) {
  const p = filterQuery({ view, search, brand, agent });
  p.set('page', String(page));
  p.set('perPage', String(perPage));
  const d = await getJson(`/api/delivery-escalation/record?${p}`);
  return { rows: (d.rows || []).map((r) => mapRow(r, view === 'resolved')), total: d.total || 0 };
}

// Overview's tiles + the admin Agent filter's options. Counted in SQL over the whole table,
// not derived from the loaded page.
async function fetchStats() {
  const d = await getJson('/api/delivery-escalation/record?op=stats');
  return {
    stats: d.stats || { total: 0, assigned: 0, resolved: 0, fresh: 0, forcedRto: 0 },
    agents: d.agents || [],
    repeatStats: d.repeatStats || [],
  };
}

// Overview's day-wise TAT table - unlike fetchStats above, this DOES take the page's current
// brand/agent filters (see record.js's own op=daywise comment on why).
async function fetchDaywiseStats({ brand, agent }) {
  const p = new URLSearchParams({ op: 'daywise' });
  if (brand && brand !== 'ALL') p.set('brand', brand);
  if (agent && agent !== 'ALL') p.set('agent', agent);
  const d = await getJson(`/api/delivery-escalation/record?${p}`);
  return {
    buckets: d.buckets || [],
    rows: d.rows || [],
    grandTotal: d.grandTotal || {},
    grandTotalAll: d.grandTotalAll || 0,
    missingDateCount: d.missingDateCount || 0,
  };
}

// Fresh tab's claim/resolve - MySQL-only, no sheet write at all, same model as CLS_RTO_calling's
// own claim/dispose (see api/_lib/db.js's claimDeliveryEscalationTicketById/
// disposeDeliveryEscalationTicketById). Unlike the old sheet write path these throw on failure -
// this IS the write now, not a best-effort mirror alongside one, so a failure has to surface to
// the agent instead of being silently swallowed.
async function claimMysqlTicket(id) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'claim', id }),
  });
  // Same "read the real reason out of the body" rule as getJson/bulkUploadOutcomes - a bare
  // "Claim failed 401" can't be told apart from a session expiry (AUTH_ERROR_MESSAGE) or any
  // other real failure without it.
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Claim failed (${r.status})`);
}

async function disposeMysqlTicket(id, outcome, agentRemarks) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dispose', id, outcome, agentRemarks }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Save failed (${r.status})`);
}

// Minimal CSV parser for the Fresh tab's bulk outcome upload - handles quoted fields (commas,
// escaped "" quotes) since Remarks is free text that could contain either. No library: CSV's
// quoting rule is the one thing a plain .split(',') gets wrong, and it's small enough that a
// hand-rolled parser beats a dependency for it.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Header lookup is case/space-insensitive ("AWB Number", "awb", "AWB_Number" all match) since
// this file is hand-exported by whoever's doing the bulk resolution, not machine-generated.
function rowsFromBulkCsv(text) {
  const [header, ...dataRows] = parseCsv(text);
  if (!header) return [];
  const norm = (s) => (s || '').trim().toLowerCase().replace(/[\s_]+/g, '');
  const idx = {};
  header.forEach((h, i) => { idx[norm(h)] = i; });
  const awbIdx = idx.awb ?? idx.awbnumber ?? idx.awbcode;
  const outcomeIdx = idx.outcome;
  const remarksIdx = idx.remarks;
  if (awbIdx === undefined || outcomeIdx === undefined) {
    throw new Error('CSV needs an AWB column and an Outcome column');
  }
  return dataRows
    .map((r) => ({
      awb: (r[awbIdx] || '').trim(),
      outcome: (r[outcomeIdx] || '').trim(),
      remarks: remarksIdx !== undefined ? (r[remarksIdx] || '').trim() : '',
    }))
    .filter((r) => r.awb && r.outcome);
}

// Quote a CSV field only when it needs it (comma, quote, or newline), doubling embedded quotes
// - the same rule parseCsv above reads back.
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_COLUMNS = [
  ['Brand', 'brand'], ['Order ID', 'orderId'], ['AWB', 'awb'], ['Ticket Number', 'ticketNumber'],
  ['Delivery Partner', 'deliveryPartner'], ['Query Class', 'queryClass'],
  ['Query Category', 'queryCategory'], ['Added Date', 'addedDate'],
  ['TAT', 'tat'], ['Times Contacted', 'contactCount'], ['First Contact', 'firstContactDate'],
  ['Agent Name', 'assignedAgent'],
  ['Action Date', 'actionDate'], ['Outcome', 'outcome'],
  ['Child Disposition', 'childDisposition'], ['Remarks', 'remarks'],
  ['TAT Bucket', 'tatBucket'],
];

// Downloads the CURRENT view and filters, not just the page on screen - every matching row,
// with no row-count ceiling. The server hands back one chunk per request (bounded so any single
// response stays inside Lambda's 6MB cap - see DELIVERY_ESCALATION_MAX_EXPORT/hasMore in
// db.js/record.js); this walks page 1, 2, 3... until a chunk comes back short, then builds one
// CSV from everything collected. onChunk reports progress for a long export.
// ﻿ prefix: without a BOM Excel reads a UTF-8 CSV as ANSI and mangles non-ASCII text.
async function downloadCsv({ view, search, brand, agent }, onChunk) {
  const rows = [];
  for (let page = 1; ; page++) {
    const p = filterQuery({ view, search, brand, agent });
    p.set('op', 'export');
    p.set('page', String(page));
    const d = await getJson(`/api/delivery-escalation/record?${p}`);
    const chunk = d.rows || [];
    for (const r of chunk) rows.push(mapRow(r, view === 'resolved'));
    onChunk?.(rows.length);
    if (!d.hasMore) break;
  }
  const lines = [EXPORT_COLUMNS.map(([label]) => csvCell(label)).join(',')];
  for (const row of rows) lines.push(EXPORT_COLUMNS.map(([, key]) => csvCell(row[key])).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `delivery-escalation-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { count: rows.length };
}

// Fresh tab's bulk outcome upload - one call, many (awb, outcome) pairs; see
// api/_lib/db.js's bulkDisposeDeliveryEscalationByAwb for matching/scoping rules (every row
// with that AWB, but only if it's still Fresh-eligible).
async function bulkUploadOutcomes(rows, view) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bulkDispose', rows, view }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Bulk upload failed (${r.status})`);
  return d.results || [];
}

// Walks the FIRST child at each level of the process's own configured disposition tree, so the
// sample template shows a real, currently-valid outcome path for THIS process rather than a
// made-up one that might not exist here. Falls back to a plain placeholder when nothing's been
// configured yet (a fresh process's tree starts empty - see callingProcesses.json's own note on
// "no seeded default").
function sampleOutcomePaths(tree) {
  const paths = [];
  for (const node of (tree || [])) {
    const labels = [node.label];
    let cur = node;
    while (cur.children && cur.children.length) {
      cur = cur.children[0];
      labels.push(cur.label);
    }
    paths.push(labels.join(' > '));
    if (paths.length >= 2) break;
  }
  return paths;
}

// Downloads a ready-to-fill CSV for the Bulk Upload button - same AWB/Outcome/Remarks columns
// rowsFromBulkCsv reads back, pre-populated with two example rows pulled from the process's own
// disposition tree: a plain top-level outcome, and a nested one showing the "Parent > Child"
// convention a bulk upload's Outcome column uses for a child disposition (there's no separate
// column for it - the full path IS the Outcome value, same as a single dispose's
// dispPath.join(' > ')).
function downloadBulkSampleCsv(processDispositions) {
  const [path1, path2] = sampleOutcomePaths(processDispositions);
  const outcomeTop = path1 || 'Delivered';
  const outcomeNested = path2 || (path1 && path1.includes(' > ') ? path1 : 'Escalated > Awaiting Partner');
  const lines = [
    'AWB,Outcome,Remarks',
    `SF1234567890EX,${csvCell(outcomeTop)},Optional free text`,
    `SF0987654321EX,${csvCell(outcomeNested)},`,
  ];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'delivery-escalation-bulk-upload-sample.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function DeliveryEscalationClient() {
  // Same theme setup as every other Calling page - one theme, always; body.theme-light in
  // app/globals.css repaints the "dark" Tailwind classes used throughout to a light background.
  useEffect(() => {
    document.documentElement.className = 'light';
    document.body.className = 'font-sans antialiased min-h-screen theme-light';
  }, []);

  // Minimal session: just who's signed in and whether this account is invited to this process -
  // the same server-side answer (report_tab_permissions via getSession()) every other card/tab
  // in this app already relies on. No presence/roster/quota/dispositions on top of it.
  const [googleUser, setGoogleUser] = useState(null);
  const [sessionIsAdmin, setSessionIsAdmin] = useState(false);
  const [invitedProcessKeys, setInvitedProcessKeys] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      if (d?.authenticated && d.email) {
        setGoogleUser({ name: d.name || d.email.split('@')[0], email: d.email });
        setSessionIsAdmin(!!d.isAdmin);
        const tabs = (d.tabPerms && d.tabPerms[CARD_KEY]) || null;
        setInvitedProcessKeys(Array.isArray(tabs) && tabs.length ? tabs : null);
      }
      setAuthLoaded(true);
    }).catch(() => setAuthLoaded(true));
  }, []);
  const hasAccess = sessionIsAdmin || !invitedProcessKeys || invitedProcessKeys.includes(TAB_KEY);

  const [toast, setToast] = useState(null);
  const showToast = useCallback(m => { setToast(m); setTimeout(() => setToast(null), 3000); }, []);

  // Admin-configurable disposition tree (calling_process_dispositions), the same shared piece
  // NDR's Admin Panel uses - starts empty, an admin adds whatever outcomes this process needs.
  // No CallingHoursCard / roster table here on purpose - this process has neither business
  // hours nor a roster to administer (see the module comment up top).
  const disp = useProcessDispositions(TAB_KEY, { googleUser, showToast });
  const { processDispositions } = disp;

  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState(() => safeStorage.getItem('de_brand_filter') || 'ALL');
  const [agentFilter, setAgentFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState({ total: 0, assigned: 0, resolved: 0, fresh: 0, forcedRto: 0 });
  const [agents, setAgents] = useState([]);
  const [repeatStats, setRepeatStats] = useState([]);
  const [daywise, setDaywise] = useState({ buckets: [], rows: [], grandTotal: {}, grandTotalAll: 0, missingDateCount: 0 });
  const [daywiseLoading, setDaywiseLoading] = useState(false);
  // Collapsed by default at every level - a flat list of every individual day was the whole
  // problem being fixed here. Keys are month key ('2026-07') and week key ('2026-07-W2').
  const [expandedMonths, setExpandedMonths] = useState(() => new Set());
  const [expandedWeeks, setExpandedWeeks] = useState(() => new Set());
  const toggleExpanded = (setFn, key) => setFn((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const groupedDaywise = useMemo(
    () => groupDaywiseRows(daywise.rows, daywise.buckets),
    [daywise.rows, daywise.buckets]
  );
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [exporting, setExporting] = useState(false);
  const bulkFileInputRef = useRef(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('—');
  const [syncError, setSyncError] = useState(null);
  // Sticky once true - the fix is always "sign in again", and it needs to survive whatever
  // page/tab the agent is on when it's noticed (an export failure, a background poll, a save).
  const [sessionExpired, setSessionExpired] = useState(false);

  // Typing a search shouldn't fire a query per keystroke - the value the fetch actually uses
  // lags 350ms behind the input.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Any change to what's being asked for restarts at page 1 - staying on page 12 of a filter
  // that now has 3 pages would just show an empty table.
  useEffect(() => { setPage(1); }, [tab, debouncedSearch, brandFilter, agentFilter, perPage]);

  // Guards against a slow earlier request landing after a faster later one and overwriting the
  // newer rows - only the most recent request is allowed to apply its result.
  const reqIdRef = useRef(0);
  const listTab = tab === 'fresh' || tab === 'resolved' || tab === 'forced_rto';

  const loadPage = useCallback(async (silent = false) => {
    if (!listTab) return;
    const reqId = ++reqIdRef.current;
    setSyncing(true);
    try {
      const res = await fetchPage({
        view: tab, page, perPage, search: debouncedSearch, brand: brandFilter, agent: agentFilter,
      });
      if (reqId !== reqIdRef.current) return;
      setRows(res.rows);
      setTotal(res.total);
      setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setSyncError(null);
      if (!silent) showToast('Delivery-Escalation tickets synced');
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      console.error('Delivery-Escalation load failed:', e);
      setSyncError(e.message || 'Load failed');
      if (isSessionExpired(e)) setSessionExpired(true);
      else if (!silent) showToast(`⚠️ ${e.message}`);
    } finally {
      if (reqId === reqIdRef.current) setSyncing(false);
    }
  }, [listTab, tab, page, perPage, debouncedSearch, brandFilter, agentFilter, showToast]);

  const loadStats = useCallback(async () => {
    try {
      const { stats: s, agents: a, repeatStats: rs } = await fetchStats();
      setStats(s);
      setAgents(a);
      setRepeatStats(rs);
    } catch (e) {
      console.error('Delivery-Escalation stats failed:', e);
      setSyncError(e.message || 'Stats failed');
      if (isSessionExpired(e)) setSessionExpired(true);
    }
  }, []);

  // Overview-only, and unlike loadStats DOES take the current brand/agent filters (see
  // record.js's own op=daywise comment on why) - so it has to reload when either changes, not
  // just on the same interval/visibility ticks as the rest of the page.
  const loadDaywise = useCallback(async () => {
    if (tab !== 'overview') return;
    setDaywiseLoading(true);
    try {
      setDaywise(await fetchDaywiseStats({ brand: brandFilter, agent: agentFilter }));
    } catch (e) {
      console.error('Delivery-Escalation daywise stats failed:', e);
      if (isSessionExpired(e)) setSessionExpired(true);
    } finally {
      setDaywiseLoading(false);
    }
  }, [tab, brandFilter, agentFilter]);

  const refresh = useCallback(async (silent = true) => {
    // Once the session is known expired, every one of these will just 401 again - retrying
    // is dead weight (and, unsilenced, a fresh wall of identical toasts) until the agent
    // actually reloads and signs back in.
    if (sessionExpired) return;
    await Promise.all([loadPage(silent), loadStats(), loadDaywise()]);
  }, [loadPage, loadStats, loadDaywise, sessionExpired]);

  useEffect(() => { if (!sessionExpired) loadPage(true); }, [loadPage, sessionExpired]);
  useEffect(() => { if (!sessionExpired) loadStats(); }, [loadStats, sessionExpired]);
  useEffect(() => { if (!sessionExpired) loadDaywise(); }, [loadDaywise, sessionExpired]);
  // New rows land in Fresh from OUTSIDE this page entirely - the 2-hourly cron mirror and any
  // one-off backfill script write straight to MySQL, with no way to tell an open browser tab
  // it happened. Polling is the only way this page can find out, so Fresh polls 4x faster than
  // the other tabs (15s vs 60s) - its own page fetch measures ~200ms (see api/_lib/db.js's
  // getDeliveryEscalationPage), so the extra frequency costs nothing that matters for a handful
  // of concurrent agents. This is "shows up automatically within 15s", not a push/instant
  // update - a genuinely sub-second refresh would need a websocket/SSE channel this app has
  // nowhere else, for a data source (a 2-hourly cron) where 15s is already effectively instant.
  useEffect(() => {
    const intervalMs = tab === 'fresh' ? 15000 : 60000;
    const t = setInterval(() => { if (!document.hidden) refresh(true); }, intervalMs);
    return () => clearInterval(t);
  }, [refresh, tab]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) refresh(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const [detailTkt, setDetailTkt] = useState(null);
  // The label picked at each depth of the admin-configured disposition tree, e.g.
  // ["Escalated", "Awaiting Partner"] - same cascading-pick model as NDR's own ndrDispPath.
  // Truncated whenever a shallower level is re-picked; the written Outcome is this path joined
  // with " > ", not just the leaf, so a leaf label reused under two different parents (e.g.
  // "Others") stays unambiguous when read back later.
  const [dispPath, setDispPath] = useState([]);
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);

  // dispLevels[i] = { type: 'single'|'multi'|'text', options }. Level 0 is always 'single' (the
  // top-level list has no parent to configure it); level i>0's type comes from whichever node
  // was picked at level i-1 (see api/_lib/db.js's children_input_type - Delivery-Escalation-only
  // control, see ProcessDispositionsCard's allowInputTypeControl prop below).
  //
  // multi and text are always a LEAF - picking a checkbox or typing text never drills into a
  // further level, even if the underlying option rows have children of their own (those rows
  // are simply not rendered in that case). single is the only type that keeps walking, exactly
  // like the old single-path-only behaviour this replaces.
  //
  // dispPath itself is unchanged: still one string per level - a label for 'single', a
  // ", "-joined string of checked labels for 'multi', or whatever was typed for 'text'. That's
  // deliberate: it's exactly the segment written into outcome (dispPath.join(' > ')) and read
  // back by openAction's split(' > '), so saving and re-opening needed no changes at all.
  const dispLevels = [{ type: 'single', options: processDispositions || [] }];
  {
    let nodes = processDispositions || [];
    for (let i = 0; ; i++) {
      if (dispLevels[i].type !== 'single') break; // multi/text already ended the path
      const node = dispPath[i] ? nodes.find(d => d.label === dispPath[i]) : null;
      if (!node) break;
      const childType = node.childrenInputType || 'single';
      if (childType !== 'single') {
        dispLevels.push({ type: childType, options: node.children || [] });
        break;
      }
      if (!node.children || !node.children.length) break; // true leaf, nothing further to pick
      nodes = node.children;
      dispLevels.push({ type: 'single', options: nodes });
    }
  }
  // "Complete" once every level up to the deepest one has a non-blank value - covers all three
  // types uniformly, since a 'single' pick is never blank by construction and 'multi'/'text'
  // are checked here instead of separately.
  const dispComplete = dispPath.length > 0 && dispLevels.length === dispPath.length && !!(dispPath[dispPath.length - 1] || '').trim();
  const pickDisp = (level, label) => setDispPath(prev => [...prev.slice(0, level), label]);
  const toggleMultiDisp = (level, label) => setDispPath(prev => {
    const checked = (prev[level] || '').split(', ').filter(Boolean);
    const next = checked.includes(label) ? checked.filter(l => l !== label) : [...checked, label];
    return [...prev.slice(0, level), next.join(', ')];
  });
  const setTextDisp = (level, text) => setDispPath(prev => [...prev.slice(0, level), text]);

  const openAction = async (t) => {
    let ticket = t;
    if (!t.readOnly && !t.assignedAgent && googleUser?.email) {
      try {
        await claimMysqlTicket(t.mysqlId);
        ticket = { ...t, assignedAgent: googleUser.email };
        setRows(prev => prev.map(x => x.id === t.id ? ticket : x));
      } catch (e) {
        if (isSessionExpired(e)) setSessionExpired(true);
        else showToast(`⚠️ Could not claim ticket: ${e.message}`);
      }
    }
    setDetailTkt(ticket);
    // Best-effort re-walk of a previously-saved "A > B > C" path - if the tree changed since
    // (an option renamed/removed), this just falls short of dispComplete and the agent re-picks.
    setDispPath(ticket.outcome ? ticket.outcome.split(' > ').filter(Boolean) : []);
    setRemarks(ticket.remarks || '');
  };

  const saveAction = async () => {
    if (!detailTkt || !dispComplete) return;
    setSaving(true);
    try {
      const outcome = dispPath.join(' > ');
      const trimmedRemarks = remarks.trim();
      await disposeMysqlTicket(detailTkt.mysqlId, outcome, trimmedRemarks);
      // The disposed ticket may now belong to the other tab (Delivered -> Resolved) or stay put
      // (Escalated/RTO are still Fresh) - refetch rather than guessing which, since the server
      // owns that classification.
      showToast('Resolution saved');
      setDetailTkt(null);
      refresh(true);
    } catch (e) {
      if (isSessionExpired(e)) setSessionExpired(true);
      else showToast(`⚠️ Could not save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Fresh AND Forced RTO tabs' bulk outcome upload - parses client-side (so a header/column
  // mistake shows up immediately, before any network call) then sends the whole batch in one
  // request, scoped server-side to whichever of those two tabs is open (see
  // bulkDisposeDeliveryEscalationByAwb's own view-scoping). Resyncs after so every tab reflects
  // whatever just moved - same reasoning as saveAction's own post-dispose refresh.
  const handleBulkFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file (e.g. after fixing a typo) later
    if (!file) return;
    setBulkUploading(true);
    setBulkResult(null);
    try {
      const text = await file.text();
      const parsed = rowsFromBulkCsv(text);
      if (!parsed.length) throw new Error('No valid rows found - need an AWB and an Outcome column');
      const results = await bulkUploadOutcomes(parsed, tab);
      const unmatched = results.filter((r) => r.matched === 0);
      const matchedCount = results.length - unmatched.length;
      setBulkResult({ total: results.length, matchedCount, unmatched });
      showToast(`Bulk upload: ${matchedCount}/${results.length} matched`);
      refresh(true);
    } catch (err) {
      if (isSessionExpired(err)) setSessionExpired(true);
      else showToast(`⚠️ Bulk upload failed: ${err.message}`);
    } finally {
      setBulkUploading(false);
    }
  };

  // Exports the whole current view+filters, not the page on screen, no row-count ceiling - see
  // downloadCsv. A large table means several chunk requests, so the toast updates as they land
  // rather than sitting silent until the last one.
  const handleExport = async () => {
    setExporting(true);
    try {
      const { count } = await downloadCsv(
        { view: tab, search: debouncedSearch, brand: brandFilter, agent: agentFilter },
        (soFar) => showToast(`Exporting… ${soFar.toLocaleString('en-IN')} rows so far`),
      );
      showToast(`Downloaded ${count.toLocaleString('en-IN')} rows`);
    } catch (e) {
      if (isSessionExpired(e)) setSessionExpired(true);
      else showToast(`⚠️ Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  // All counts come from SQL over the whole table (see fetchStats) rather than from the loaded
  // page - there's no client-side filtering or scoping left to do here.
  const unassignedCount = Math.max(stats.total - stats.assigned, 0);
  const resolutionRate = stats.assigned > 0 ? Math.round((stats.resolved / stats.assigned) * 100) : 0;

  const agentOptions = useMemo(
    () => [{ value: 'ALL', label: 'All Agents' }, ...agents.map(e => ({ value: e, label: e.split('@')[0] }))],
    [agents]
  );

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  // No per-process admin here (that concept comes from the roster this process doesn't have) -
  // only a company-wide admin manages the disposition list, same bar api/admin/[action].js's
  // handleDispositions enforces for POST/PUT/DELETE.
  const tabsList = [
    { key: 'overview', label: '📊 Overview', count: stats.total },
    { key: 'fresh', label: '⚡ Fresh', count: stats.fresh },
    { key: 'forced_rto', label: '↩️ Forced RTO', count: stats.forcedRto },
    { key: 'resolved', label: '✅ Resolved', count: stats.resolved },
    ...(sessionIsAdmin ? [{ key: 'admin', label: '🛡️ Admin Panel', count: (processDispositions || []).length }] : []),
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      <header className="sticky top-0 z-30 bg-[#09090b]/95 backdrop-blur-xl border-b border-zinc-800/80">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 min-h-13 py-2 flex items-center justify-between flex-wrap gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white font-extrabold text-xs shadow-md shadow-indigo-950/50">
              DE
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-extrabold text-zinc-100 tracking-tight flex items-center gap-2 truncate">
                <span className="truncate">Delivery-Escalation Agent Portal</span>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              </h1>
              <p className="text-[11px] text-zinc-500 font-mono hidden sm:flex items-center gap-1.5">
                Last sync: {lastSync}
                {syncError && !sessionExpired && (
                  <span className="text-rose-400 font-sans font-semibold" title={syncError}>
                    ⚠ Sync failed — showing cached data, retrying…
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2.5 flex-wrap justify-end">
            <button onClick={() => refresh(false)} disabled={syncing} className="h-8 px-2.5 sm:px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50 shrink-0" title="Refresh Delivery-Escalation data">
              <RefreshIcon className={syncing ? 'animate-spin text-indigo-400' : ''} />
              <span className="hidden md:inline">{syncing ? 'Syncing…' : 'Refresh'}</span>
            </button>
          </div>
        </div>
      </header>

      {toast && <div className="fixed top-16 right-5 z-50 animate-slideUp"><div className="px-4 py-2.5 rounded-xl bg-zinc-800/90 text-zinc-100 border border-zinc-700 text-[13px] shadow-2xl flex items-center gap-2.5 backdrop-blur-md"><CheckIcon className="text-emerald-400 shrink-0" />{toast}</div></div>}

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-5 py-5 space-y-5">
        {sessionExpired && (
          <div className="bg-amber-950/40 border border-amber-800/60 rounded-2xl p-5 shadow-xl backdrop-blur-md flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-[14px] font-bold text-amber-200">Your session has expired</h2>
              <p className="text-[13px] text-amber-100/80 mt-0.5">
                Reload the page and sign in again - nothing here will load or export until you do.
              </p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 text-[13px] font-semibold transition-colors shrink-0"
            >
              Reload page
            </button>
          </div>
        )}

        {authLoaded && !hasAccess && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-8 shadow-xl backdrop-blur-md">
            <div className="max-w-2xl space-y-3">
              <h2 className="text-lg font-bold text-zinc-100">No access to Delivery-Escalation</h2>
              <p className="text-[13px] text-zinc-400 leading-relaxed">
                This account hasn&apos;t been invited to Delivery-Escalation yet. An admin can grant it
                from Admin &rarr; Permissions by ticking Delivery-Escalation under the Calling card.
              </p>
              <p className="text-[13px] text-zinc-500">
                Signed in as {googleUser?.email || 'an unknown account'}.
              </p>
            </div>
          </div>
        )}

        {hasAccess && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-1.5 shadow-xl backdrop-blur-md">
            <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar w-full mb-1.5">
              {tabsList.map(t => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`relative px-4 py-2 rounded-xl text-[13px] font-bold whitespace-nowrap transition-all flex items-center gap-2.5 ${
                    tab === t.key
                      ? 'text-white bg-indigo-600 shadow-md shadow-indigo-950/50 border border-indigo-500/40'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 border border-transparent'
                  }`}
                >
                  {t.label}
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-md ${tab === t.key ? 'bg-white/20' : 'bg-zinc-800'}`}>{t.count}</span>
                </button>
              ))}
            </nav>

            <div className="p-4 space-y-4">
              {syncError && !sessionExpired && (
                <div className="text-[12px] text-rose-400">⚠ {syncError} — retrying…</div>
              )}
              {bulkResult && (tab === 'fresh' || tab === 'forced_rto') && (
                <div className="text-[12px] bg-zinc-900/70 border border-zinc-800 rounded-lg px-3 py-2 flex items-start justify-between gap-3">
                  <div>
                    <span className="text-zinc-300 font-semibold">Bulk upload: {bulkResult.matchedCount}/{bulkResult.total} matched.</span>
                    {bulkResult.unmatched.length > 0 && (
                      <div className="text-amber-400 mt-1">
                        Not matched (already resolved, or AWB not found): {bulkResult.unmatched.map(u => u.awb).join(', ')}
                      </div>
                    )}
                  </div>
                  <button onClick={() => setBulkResult(null)} className="text-zinc-500 hover:text-zinc-300 shrink-0"><XIcon /></button>
                </div>
              )}

              {tab === 'overview' && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Total Tickets</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{stats.total.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-500 mb-1">Assigned</p>
                    <p className="text-2xl font-extrabold text-indigo-400 tabular-nums">{stats.assigned.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-amber-900/50 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-1">Unassigned</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{unassignedCount.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-emerald-900/50 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-500 mb-1">Resolved</p>
                    <p className="text-2xl font-extrabold text-emerald-500 tabular-nums">{stats.resolved.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">{resolutionRate}% of assigned</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Awaiting Resolution</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{stats.fresh.toLocaleString('en-IN')}</p>
                  </div>
                </div>
              )}

              {tab === 'overview' && (
                <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                  <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                      TAT by Query Date
                    </p>
                    <div className="flex items-center gap-2">
                      {daywiseLoading && <span className="text-[11px] text-zinc-600">Loading…</span>}
                      <CustomSelect
                        value={brandFilter}
                        onChange={(v) => { setBrandFilter(v); safeStorage.setItem('de_brand_filter', v); }}
                        options={[{ value: 'ALL', label: 'All Brands' }, ...BRANDS.map(b => ({ value: b, label: b }))]}
                        placeholder="Brand"
                      />
                    </div>
                  </div>
                  <p className="text-[12px] text-zinc-500 mb-3">
                    Every parcel (distinct AWB), bucketed by days since Query Date - resolved
                    parcels use their actual resolution date, still-open parcels use today's
                    date. % is each bucket's share of that date's own total.
                    {daywise.missingDateCount > 0 && (
                      <> {daywise.missingDateCount} parcel(s) have no Query date at all and can&apos;t
                      sit under any date row - counted only in Grand Total &rarr; unresolved.</>
                    )}
                  </p>
                  <div className="rounded-xl border border-zinc-800/80 overflow-hidden">
                    <div className="overflow-x-auto custom-scroll">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-zinc-800/80 text-zinc-500">
                            <th rowSpan={2} className="py-2 px-3 text-left font-medium align-bottom whitespace-nowrap">Query date</th>
                            {daywise.buckets.map((b) => (
                              <th key={b} colSpan={2} className="py-2 px-3 text-center font-medium border-l border-zinc-800/60 whitespace-nowrap">{b}</th>
                            ))}
                            <th rowSpan={2} className="py-2 px-3 text-right font-medium align-bottom border-l border-zinc-800/60 whitespace-nowrap">Grand Total</th>
                          </tr>
                          <tr className="border-b border-zinc-800/80 text-zinc-600 text-[11px]">
                            {daywise.buckets.flatMap((b) => ([
                              <th key={`${b}-n`} className="py-1 px-3 text-right font-medium border-l border-zinc-800/60"> </th>,
                              <th key={`${b}-pct`} className="py-1 px-3 text-right font-medium">%</th>,
                            ]))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {groupedDaywise.map((month) => {
                            const monthOpen = expandedMonths.has(month.key);
                            return (
                              <Fragment key={month.key}>
                                <tr
                                  onClick={() => toggleExpanded(setExpandedMonths, month.key)}
                                  className="hover:bg-zinc-800/30 transition-colors cursor-pointer"
                                >
                                  <td className="py-2 px-3 text-zinc-200 font-semibold whitespace-nowrap">
                                    <span className="inline-block w-4 text-zinc-500">{monthOpen ? '▾' : '▸'}</span>
                                    {formatDaywiseMonth(month.key)}
                                  </td>
                                  {daywise.buckets.flatMap((b) => ([
                                    <td key={`${b}-n`} className="py-2 px-3 text-right text-zinc-200 font-semibold tabular-nums border-l border-zinc-800/60">{month.counts[b] || 0}</td>,
                                    <td key={`${b}-pct`} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">{month.pct[b] || 0}%</td>,
                                  ]))}
                                  <td className="py-2 px-3 text-right text-zinc-100 font-bold tabular-nums border-l border-zinc-800/60">{month.total.toLocaleString('en-IN')}</td>
                                </tr>
                                {monthOpen && month.weeks.map((week) => {
                                  const weekOpen = expandedWeeks.has(week.key);
                                  return (
                                    <Fragment key={week.key}>
                                      <tr
                                        onClick={() => toggleExpanded(setExpandedWeeks, week.key)}
                                        className="hover:bg-zinc-800/30 transition-colors cursor-pointer bg-zinc-950/30"
                                      >
                                        <td className="py-2 px-3 pl-8 text-zinc-300 whitespace-nowrap">
                                          <span className="inline-block w-4 text-zinc-500">{weekOpen ? '▾' : '▸'}</span>
                                          {formatDaywiseWeek(week)}
                                        </td>
                                        {daywise.buckets.flatMap((b) => ([
                                          <td key={`${b}-n`} className="py-2 px-3 text-right text-zinc-300 tabular-nums border-l border-zinc-800/60">{week.counts[b] || 0}</td>,
                                          <td key={`${b}-pct`} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">{week.pct[b] || 0}%</td>,
                                        ]))}
                                        <td className="py-2 px-3 text-right text-zinc-100 font-semibold tabular-nums border-l border-zinc-800/60">{week.total.toLocaleString('en-IN')}</td>
                                      </tr>
                                      {weekOpen && week.days.map((r) => (
                                        <tr key={r.date} className="hover:bg-zinc-800/30 transition-colors">
                                          <td className="py-2 px-3 pl-14 text-zinc-400 whitespace-nowrap">{formatDaywiseDate(r.date)}</td>
                                          {daywise.buckets.flatMap((b) => ([
                                            <td key={`${b}-n`} className="py-2 px-3 text-right text-zinc-400 tabular-nums border-l border-zinc-800/60">{r.counts[b] || 0}</td>,
                                            <td key={`${b}-pct`} className="py-2 px-3 text-right text-zinc-600 tabular-nums text-[12px]">{r.pct[b] || 0}%</td>,
                                          ]))}
                                          <td className="py-2 px-3 text-right text-zinc-300 tabular-nums border-l border-zinc-800/60">{r.total.toLocaleString('en-IN')}</td>
                                        </tr>
                                      ))}
                                    </Fragment>
                                  );
                                })}
                              </Fragment>
                            );
                          })}
                          {groupedDaywise.length === 0 && (
                            <tr><td colSpan={daywise.buckets.length * 2 + 2} className="py-8 text-center text-zinc-500">
                              {daywiseLoading ? 'Loading…' : 'No data.'}
                            </td></tr>
                          )}
                        </tbody>
                        {daywise.rows.length > 0 && (
                          <tfoot>
                            <tr className="border-t border-zinc-800/80 bg-zinc-950/40 font-semibold">
                              <td className="py-2 px-3 text-zinc-200 whitespace-nowrap">Grand Total</td>
                              {daywise.buckets.flatMap((b) => ([
                                <td key={`${b}-n`} className="py-2 px-3 text-right text-zinc-100 tabular-nums border-l border-zinc-800/60">{(daywise.grandTotal[b] || 0).toLocaleString('en-IN')}</td>,
                                <td key={`${b}-pct`} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">
                                  {daywise.grandTotalAll ? Math.round(((daywise.grandTotal[b] || 0) / daywise.grandTotalAll) * 100) : 0}%
                                </td>,
                              ]))}
                              <td className="py-2 px-3 text-right text-zinc-100 tabular-nums border-l border-zinc-800/60">{daywise.grandTotalAll.toLocaleString('en-IN')}</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'overview' && repeatStats.length > 0 && (
                <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">
                    Repeat contacts on unresolved complaints
                  </p>
                  <p className="text-[12px] text-zinc-500 mb-3">
                    Customers counted once per AWB, still waiting on a delivery.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {repeatStats.map(({ bucket, customers }) => (
                      <div key={bucket} className="bg-zinc-950/60 rounded-xl px-4 py-3 border border-zinc-800/80">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">
                          Came {bucket}
                        </p>
                        <p className="text-xl font-extrabold text-zinc-100 tabular-nums">
                          {customers.toLocaleString('en-IN')}
                        </p>
                        <p className="text-[11px] text-zinc-500 font-medium mt-0.5">customers</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-3">
                    Total unresolved customers:{' '}
                    <span className="text-zinc-300 font-semibold tabular-nums">
                      {repeatStats.reduce((sum, r) => sum + r.customers, 0).toLocaleString('en-IN')}
                    </span>
                  </p>
                </div>
              )}

              {listTab && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search AWB, order ID…"
                        className="w-64 px-3 py-1.5 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                      />
                      <CustomSelect
                        value={brandFilter}
                        onChange={(v) => { setBrandFilter(v); safeStorage.setItem('de_brand_filter', v); }}
                        options={[{ value: 'ALL', label: 'All Brands' }, ...BRANDS.map(b => ({ value: b, label: b }))]}
                        placeholder="Brand"
                      />
                      {/* Everyone with access gets this - it is how an agent narrows the shared
                          desk down to their own tickets now that nothing is hidden from them. */}
                      <CustomSelect value={agentFilter} onChange={setAgentFilter} options={agentOptions} placeholder="Agent" />
                      {(tab === 'fresh' || tab === 'forced_rto') && (
                        <>
                          <input
                            ref={bulkFileInputRef}
                            type="file"
                            accept=".csv,text/csv"
                            className="hidden"
                            onChange={handleBulkFile}
                          />
                          <button
                            onClick={() => bulkFileInputRef.current?.click()}
                            disabled={bulkUploading}
                            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                            title="Bulk upload outcomes via CSV (columns: AWB, Outcome, Remarks). For a child disposition, put the full path in Outcome, e.g. Escalated > Awaiting Partner."
                          >
                            {bulkUploading ? 'Uploading…' : '📤 Bulk Upload'}
                          </button>
                          <button
                            onClick={() => downloadBulkSampleCsv(processDispositions)}
                            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors"
                            title="Download a sample CSV in the format Bulk Upload expects, including how to write a child disposition"
                          >
                            📋 Sample CSV
                          </button>
                        </>
                      )}
                      <button
                        onClick={handleExport}
                        disabled={exporting || total === 0}
                        className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                        title="Download every ticket matching the current filters as CSV"
                      >
                        {exporting ? 'Preparing…' : '⬇️ Download CSV'}
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                      <span>{total.toLocaleString('en-IN')} tickets</span>
                      <CustomSelect
                        value={perPage}
                        onChange={(v) => setPerPage(+v)}
                        options={[{ value: 25, label: '25 per page' }, { value: 50, label: '50 per page' }, { value: 100, label: '100 per page' }]}
                      />
                    </div>
                  </div>

                  <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 overflow-hidden">
                    <div className="overflow-x-auto custom-scroll">
                      <table className="w-full text-[13px]">
                        <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                          <th className="py-3 px-4 text-left font-medium">Brand</th>
                          <th className="py-3 px-4 text-left font-medium">Order ID</th>
                          <th className="py-3 px-4 text-left font-medium">AWB</th>
                          <th className="py-3 px-4 text-left font-medium">Delivery Partner</th>
                          <th className="py-3 px-4 text-left font-medium">Query Category</th>
                          <th className="py-3 px-4 text-left font-medium">Added Date</th>
                          <th className="py-3 px-4 text-left font-medium">TAT</th>
                          <th className="py-3 px-4 text-left font-medium">Times Contacted</th>
                          <th className="py-3 px-4 text-left font-medium">First Contact</th>
                          <th className="py-3 px-4 text-left font-medium">Agent Name</th>
                          <th className="py-3 px-4 text-left font-medium">Outcome</th>
                          <th className="py-3 px-4 text-left font-medium">Child Disposition</th>
                          {tab === 'resolved' && <th className="py-3 px-4 text-left font-medium">Action Date</th>}
                          {tab === 'resolved' && <th className="py-3 px-4 text-left font-medium">Remarks</th>}
                          {tab === 'resolved' && <th className="py-3 px-4 text-left font-medium">TAT Bucket</th>}
                          <th className="py-3 px-4 text-right font-medium">Action</th>
                        </tr></thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {rows.map(t => (
                            <tr key={t.id} className="hover:bg-zinc-800/30 transition-colors">
                              <td className="py-3 px-4 text-zinc-300">{t.brand}</td>
                              <td className="py-3 px-4 text-zinc-300 font-mono text-[12px]">{t.orderId}</td>
                              <td className="py-3 px-4 text-zinc-300 font-mono text-[12px]">{t.awb}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.deliveryPartner}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.queryCategory}</td>
                              <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">{t.addedDate || '—'}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.tat}</td>
                              <td className="py-3 px-4 text-zinc-400 tabular-nums">
                                {t.contactCount === '' ? '—' : (
                                  <span className={t.contactCount > 1 ? 'text-amber-400 font-semibold' : ''}>
                                    {t.contactCount}{t.contactCount > 1 ? '×' : ''}
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-4 text-zinc-400">{t.firstContactDate || '—'}</td>
                              <td className="py-3 px-4 text-zinc-400 text-[12px]">{t.assignedAgent ? t.assignedAgent.split('@')[0] : '—'}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.outcome || '—'}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.childDisposition || '—'}</td>
                              {tab === 'resolved' && <td className="py-3 px-4 text-zinc-400">{t.actionDate}</td>}
                              {tab === 'resolved' && <td className="py-3 px-4 text-zinc-400 max-w-xs truncate" title={t.remarks}>{t.remarks}</td>}
                              {tab === 'resolved' && <td className="py-3 px-4 text-zinc-400">{t.tatBucket}</td>}
                              <td className="py-3 px-4 text-right">
                                <button
                                  onClick={() => openAction(t)}
                                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-semibold transition-colors"
                                >
                                  {t.readOnly ? 'View' : t.outcome ? 'View / Edit' : 'Resolve'}
                                </button>
                              </td>
                            </tr>
                          ))}
                          {rows.length === 0 && (
                            <tr><td colSpan={tab === 'resolved' ? 16 : 13} className="py-8 text-center text-zinc-500">
                              {syncing ? 'Loading…' : 'No tickets in this view.'}
                            </td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 text-[12px] text-zinc-400">
                      <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 rounded-lg bg-zinc-900/90 border border-zinc-800 disabled:opacity-40">Prev</button>
                      <span>Page {page} of {totalPages}</span>
                      <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1 rounded-lg bg-zinc-900/90 border border-zinc-800 disabled:opacity-40">Next</button>
                    </div>
                  )}
                </div>
              )}

              {tab === 'admin' && sessionIsAdmin && (
                <ProcessDispositionsCard processLabel="Delivery-Escalation" disp={disp} allowInputTypeControl />
              )}
            </div>
          </div>
        )}
      </main>

      {detailTkt && (
        <Overlay onClose={() => setDetailTkt(null)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 w-full max-w-lg space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-zinc-100">{detailTkt.readOnly ? 'Ticket Details' : 'Resolve Ticket'}</h3>
              <button onClick={() => setDetailTkt(null)} className="text-zinc-500 hover:text-zinc-300"><XIcon /></button>
            </div>
            <div className="text-[13px] text-zinc-400 space-y-1">
              <p><span className="text-zinc-500">Order ID:</span> {detailTkt.orderId} &nbsp; <span className="text-zinc-500">AWB:</span> {detailTkt.awb}</p>
              <p><span className="text-zinc-500">Brand:</span> {detailTkt.brand} &nbsp; <span className="text-zinc-500">Partner:</span> {detailTkt.deliveryPartner}</p>
              <p><span className="text-zinc-500">Query:</span> {detailTkt.queryClass} / {detailTkt.queryCategory}</p>
            </div>
            {detailTkt.readOnly ? (
              <div className="text-[13px] text-zinc-300 space-y-1 bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-2">
                <p><span className="text-zinc-500">Outcome:</span> {detailTkt.outcome || '—'}</p>
                <p><span className="text-zinc-500">Action Date:</span> {detailTkt.actionDate || '—'}</p>
                <p><span className="text-zinc-500">Agent:</span> {detailTkt.assignedAgent || '—'}</p>
                <p><span className="text-zinc-500">Remarks:</span> {detailTkt.remarks || '—'}</p>
              </div>
            ) : (
            <>
            <div>
              <label className="text-[12px] font-semibold text-zinc-400 mb-1 block">Outcome</label>
              {(processDispositions || []).length === 0 ? (
                <p className="text-[12px] text-amber-400 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
                  No outcomes configured yet - an admin adds them from Admin Panel &rarr; Disposition List.
                </p>
              ) : (
                <div className="space-y-2">
                  {dispLevels.map((lvl, level) => (
                    <div key={level}>
                      {lvl.type === 'text' ? (
                        <input
                          type="text"
                          value={dispPath[level] || ''}
                          onChange={(e) => setTextDisp(level, e.target.value)}
                          placeholder="Type the reason…"
                          className="w-full px-3 py-1.5 text-[12px] bg-zinc-950/60 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                        />
                      ) : (
                        <>
                        {lvl.type === 'multi' && (
                          <p className="text-[11px] text-zinc-500 mb-1">Select one or more:</p>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          {lvl.options.map(d => {
                            const checked = lvl.type === 'multi'
                              ? (dispPath[level] || '').split(', ').filter(Boolean).includes(d.label)
                              : dispPath[level] === d.label;
                            return (
                              <button
                                key={d.id}
                                type="button"
                                onClick={() => lvl.type === 'multi' ? toggleMultiDisp(level, d.label) : pickDisp(level, d.label)}
                                title={d.description || undefined}
                                className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors ${
                                  checked
                                    ? 'bg-indigo-600 border-indigo-500 text-white'
                                    : 'bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                                }`}
                              >
                                {d.label}
                              </button>
                            );
                          })}
                        </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="text-[12px] font-semibold text-zinc-400 mb-1 block">Remarks</label>
              <textarea
                value={remarks}
                onChange={e => setRemarks(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 bg-zinc-950/60 border border-zinc-800 rounded-lg text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                placeholder="Notes on what was done…"
              />
            </div>
            </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDetailTkt(null)} className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[13px] font-semibold transition-colors">{detailTkt.readOnly ? 'Close' : 'Cancel'}</button>
              {!detailTkt.readOnly && (
                <button
                  onClick={saveAction}
                  disabled={!dispComplete || saving}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-semibold transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
