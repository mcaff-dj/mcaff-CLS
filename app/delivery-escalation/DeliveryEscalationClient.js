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
// Paging, filtering, searching and per-agent scoping all happen SERVER-side (see db.js's own
// header comment). The browser holds one page of rows, never the whole table - which is what
// keeps the response inside Lambda's 6MB cap however large this table grows, and what stops a
// non-admin's response from carrying other agents' tickets at all.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
    queryCategory: row.query_category || '', whName: row.wh_name || '',
    statusAsPerAwb: row.status_as_per_awb || '', tat: row.tat || '',
    ticketNumber: row.ticket_number || '', assignedAgent: row.agent_email || '',
    actionDate: row.disposed_at ? new Date(row.disposed_at).toLocaleDateString('en-GB') : '',
    outcome: row.outcome || '', remarks: row.agent_remarks || '',
    tatBucket: row.tat_bucket || '',
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
  return { stats: d.stats || { total: 0, assigned: 0, resolved: 0, fresh: 0 }, agents: d.agents || [] };
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
  if (!r.ok) throw new Error(`Claim failed ${r.status}`);
}

async function disposeMysqlTicket(id, outcome, agentRemarks) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dispose', id, outcome, agentRemarks }),
  });
  if (!r.ok) throw new Error(`Save failed ${r.status}`);
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
  ['Query Category', 'queryCategory'], ['WH Name', 'whName'],
  ['Status as per AWB', 'statusAsPerAwb'], ['TAT', 'tat'], ['Agent Name', 'assignedAgent'],
  ['Action Date', 'actionDate'], ['Outcome', 'outcome'], ['Remarks', 'remarks'],
  ['TAT Bucket', 'tatBucket'],
];

// Downloads the CURRENT view and filters, not just the page on screen - the server returns
// every matching row (capped, see DELIVERY_ESCALATION_MAX_EXPORT) and the file is built here.
// ﻿ prefix: without a BOM Excel reads a UTF-8 CSV as ANSI and mangles non-ASCII text.
async function downloadCsv({ view, search, brand, agent }) {
  const p = filterQuery({ view, search, brand, agent });
  p.set('op', 'export');
  const d = await getJson(`/api/delivery-escalation/record?${p}`);
  const rows = (d.rows || []).map((r) => mapRow(r, view === 'resolved'));
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
  return { count: rows.length, capped: !!d.capped };
}

// Fresh tab's bulk outcome upload - one call, many (awb, outcome) pairs; see
// api/_lib/db.js's bulkDisposeDeliveryEscalationByAwb for matching/scoping rules (every row
// with that AWB, but only if it's still Fresh-eligible).
async function bulkUploadOutcomes(rows) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bulkDispose', rows }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Bulk upload failed (${r.status})`);
  return d.results || [];
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
  const [stats, setStats] = useState({ total: 0, assigned: 0, resolved: 0, fresh: 0 });
  const [agents, setAgents] = useState([]);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [exporting, setExporting] = useState(false);
  const bulkFileInputRef = useRef(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('—');
  const [syncError, setSyncError] = useState(null);

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
  const listTab = tab === 'fresh' || tab === 'resolved';

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
      if (!silent) showToast(`⚠️ ${e.message}`);
    } finally {
      if (reqId === reqIdRef.current) setSyncing(false);
    }
  }, [listTab, tab, page, perPage, debouncedSearch, brandFilter, agentFilter, showToast]);

  const loadStats = useCallback(async () => {
    try {
      const { stats: s, agents: a } = await fetchStats();
      setStats(s);
      setAgents(a);
    } catch (e) {
      console.error('Delivery-Escalation stats failed:', e);
      setSyncError(e.message || 'Stats failed');
    }
  }, []);

  const refresh = useCallback(async (silent = true) => {
    await Promise.all([loadPage(silent), loadStats()]);
  }, [loadPage, loadStats]);

  useEffect(() => { loadPage(true); }, [loadPage]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) refresh(true); }, 60000);
    return () => clearInterval(t);
  }, [refresh]);
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

  // dispLevels[0] is always the top-level list; dispLevels[i] (i>0) only exists once dispPath
  // has a label at depth i-1 whose node actually has children - the walk stops the moment a
  // picked node is a leaf, matching however deep this particular branch goes.
  const dispLevels = [processDispositions || []];
  {
    let nodes = processDispositions || [];
    for (let i = 0; ; i++) {
      const node = dispPath[i] ? nodes.find(d => d.label === dispPath[i]) : null;
      if (!node || !node.children || !node.children.length) break;
      nodes = node.children;
      dispLevels.push(nodes);
    }
  }
  // "Complete" once the deepest picked node has no further children to choose - i.e. there's no
  // extra level beyond what's been picked. Save is disabled until this is true.
  const dispComplete = dispPath.length > 0 && dispLevels.length === dispPath.length;
  const pickDisp = (level, label) => setDispPath(prev => [...prev.slice(0, level), label]);

  const openAction = async (t) => {
    let ticket = t;
    if (!t.readOnly && !t.assignedAgent && googleUser?.email) {
      try {
        await claimMysqlTicket(t.mysqlId);
        ticket = { ...t, assignedAgent: googleUser.email };
        setRows(prev => prev.map(x => x.id === t.id ? ticket : x));
      } catch (e) {
        showToast(`⚠️ Could not claim ticket: ${e.message}`);
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
      showToast(`⚠️ Could not save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Fresh tab's bulk outcome upload - parses client-side (so a header/column mistake shows up
  // immediately, before any network call) then sends the whole batch in one request. Resyncs
  // after so Fresh/Resolved both reflect whatever just moved - same reasoning as saveAction's
  // own post-dispose refresh.
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
      const results = await bulkUploadOutcomes(parsed);
      const unmatched = results.filter((r) => r.matched === 0);
      const matchedCount = results.length - unmatched.length;
      setBulkResult({ total: results.length, matchedCount, unmatched });
      showToast(`Bulk upload: ${matchedCount}/${results.length} matched`);
      refresh(true);
    } catch (err) {
      showToast(`⚠️ Bulk upload failed: ${err.message}`);
    } finally {
      setBulkUploading(false);
    }
  };

  // Exports the whole current view+filters, not the page on screen - see downloadCsv.
  const handleExport = async () => {
    setExporting(true);
    try {
      const { count, capped } = await downloadCsv({
        view: tab, search: debouncedSearch, brand: brandFilter, agent: agentFilter,
      });
      showToast(capped ? `Downloaded ${count.toLocaleString('en-IN')} rows (export cap reached)` : `Downloaded ${count.toLocaleString('en-IN')} rows`);
    } catch (e) {
      showToast(`⚠️ Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  // All counts come from SQL over the whole table (see fetchStats) rather than from the loaded
  // page, and the server already scopes a non-admin to their own tickets - there's no
  // client-side filtering or scoping left to do here.
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
                {syncError && (
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
              {syncError && (
                <div className="text-[12px] text-rose-400">⚠ {syncError} — retrying…</div>
              )}
              {bulkResult && tab === 'fresh' && (
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

              {(tab === 'fresh' || tab === 'resolved') && (
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
                      {sessionIsAdmin && (
                        <CustomSelect value={agentFilter} onChange={setAgentFilter} options={agentOptions} placeholder="Agent" />
                      )}
                      {tab === 'fresh' && (
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
                            title="Bulk upload outcomes via CSV (columns: AWB, Outcome, Remarks)"
                          >
                            {bulkUploading ? 'Uploading…' : '📤 Bulk Upload'}
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
                          <th className="py-3 px-4 text-left font-medium">WH Name</th>
                          <th className="py-3 px-4 text-left font-medium">Status as per AWB</th>
                          <th className="py-3 px-4 text-left font-medium">TAT</th>
                          <th className="py-3 px-4 text-left font-medium">Agent Name</th>
                          <th className="py-3 px-4 text-left font-medium">Outcome</th>
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
                              <td className="py-3 px-4 text-zinc-400">{t.whName}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.statusAsPerAwb}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.tat}</td>
                              <td className="py-3 px-4 text-zinc-400 text-[12px]">{t.assignedAgent ? t.assignedAgent.split('@')[0] : '—'}</td>
                              <td className="py-3 px-4 text-zinc-400">{t.outcome || '—'}</td>
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
                            <tr><td colSpan={tab === 'resolved' ? 14 : 11} className="py-8 text-center text-zinc-500">
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
                <ProcessDispositionsCard processLabel="Delivery-Escalation" disp={disp} />
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
                  {dispLevels.map((nodes, level) => (
                    <div key={level} className="flex flex-wrap gap-1.5">
                      {nodes.map(d => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => pickDisp(level, d.label)}
                          title={d.description || undefined}
                          className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors ${
                            dispPath[level] === d.label
                              ? 'bg-indigo-600 border-indigo-500 text-white'
                              : 'bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
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
