'use client';

// Delivery-Escalation's own independent workspace - modeled on app/ndr-calling/NdrCallingClient.js
// (claim a row, record a resolution, write it straight back to the sheet) but deliberately NOT
// built on the shared app/_calling/useCallingSession.js / CallingAdminPanel.js pieces every other
// process uses: this process has no Postgres-backed roster, presence, quota, business hours or
// dispositions, and no round-robin assignment robot - see api/_lib/callingProcesses.json's
// "deliveryescalation" entry for why. Access is still gated the same way everything else in this
// app is: report_tab_permissions, checked server-side by api/delivery-escalation/sheet.js.
//
// Its source data lives across two Sheet tabs, one per brand (HYPHEN, mCaffeine) - fetched
// independently and merged into a single list, with Brand (= the tab it came from) as its own
// filterable column, rather than exposing a tab switcher in the UI.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { CustomSelect, CheckIcon, XIcon, RefreshIcon, Overlay } from '../_calling/ui';
import { safeStorage } from '../_calling/util';

const SHEET_ID = '1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w';
const TABS = ['HYPHEN', 'mCaffeine'];
const CARD_KEY = 'calling';
const TAB_KEY = 'deliveryescalation';

// Same defensive tail-fetch reasoning as NDR's own fetchNdrSheet (see its comment): this sheet is
// fed by an existing ops process outside this app and keeps growing regardless of anything here,
// so an unbounded read risks the ~6MB Lambda synchronous response-payload limit. Probed on AWB
// Number (column E), not Added Date (column A) - Added Date is blank on some real rows (seen on
// the sheet itself), so it would under-count how many rows actually exist.
const MAX_ROWS_PER_TAB = 12000;
// Only columns A-Q (indices 0-16, see mapRow) are actually read out of the fetched width below -
// everything from R onward is a separate downstream process's own columns (differs between the
// two tabs; City/State/Ticket Number/etc.), not ours to read or touch.
// Agent Name / Action Date / Outcome / Remarks - the only cells this UI ever writes. Appended
// fresh after Z (not reusing anything in R:Z) because nothing in that range belongs to this app.
const COL_AGENT = 'AA', COL_ACTION_DATE = 'AB', COL_OUTCOME = 'AC', COL_REMARKS = 'AD';
const WRITE_LAST_COL = 'AD';

const OUTCOME_OPTIONS = ['Resolved', 'Escalated to Partner', 'Pending Partner Response', 'Closed'];

async function fetchValues(range) {
  const r = await fetch(`/api/delivery-escalation/sheet?op=values&sid=${encodeURIComponent(SHEET_ID)}&range=${encodeURIComponent(range)}`);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Sheets API ${r.status}${body ? ': ' + body.slice(0, 300) : ''}`);
  }
  const d = await r.json();
  return d.values || [];
}

function mapRow(row, rowNum, tab) {
  const v = (i) => row[i] !== undefined ? row[i] : '';
  return {
    id: `${tab}-${v(4)}-${rowNum}`, rowNum, tab, brand: tab,
    addedDate: v(0), queryClass: v(1), queryCategory: v(2), orderId: v(3), awb: v(4),
    deliveryPartner: v(5), orderDate: v(6), orderMonth: v(7), queryDate: v(8), queryMonth: v(9),
    whName: v(10), uniqueCount: v(11), deliveredDate: v(12), statusAsPerAwb: v(13), solvDate: v(14),
    tat: v(15), logisticsUpdate: v(16),
    assignedAgent: v(26), actionDate: v(27), outcome: v(28), remarks: v(29),
  };
}

// One tab's fetch is independent of the other's - a transient failure on one (seen for real:
// mCaffeine's own tab returned a bare 503 UNAVAILABLE from Sheets while HYPHEN succeeded in the
// same run) must not blank out the tab that DID succeed. Callers use Promise.allSettled, not
// Promise.all, over this.
async function fetchTab(tab) {
  const awbCol = await fetchValues(`'${tab}'!E2:E1000000`);
  if (!awbCol.length) return { tab, rows: [], totalRows: 0 };
  const totalRows = awbCol.length;
  const lastRow = totalRows + 1;
  const startRow = Math.max(2, lastRow - MAX_ROWS_PER_TAB + 1);
  // One pass across the full width this UI cares about - the 17 source columns (A:Q) plus the
  // 4 columns it writes (AA:AD) - rather than two ranges stitched back together per row.
  const rows = await fetchValues(`'${tab}'!A${startRow}:${WRITE_LAST_COL}${lastRow}`);
  return { tab, rows: rows.map((row, idx) => mapRow(row, startRow + idx, tab)), totalRows };
}

async function writeCells(tab, ranges) {
  const r = await fetch('/api/delivery-escalation/sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'batchUpdate', sid: SHEET_ID,
      data: ranges.map(({ range, values }) => ({ range: `'${tab}'!${range}`, values: [values] })),
    }),
  });
  if (!r.ok) throw new Error(`Sheets write ${r.status}`);
  return r.json();
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

  const [tickets, setTickets] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('—');
  const [syncError, setSyncError] = useState(null);

  const syncFailCountRef = useRef(0);
  const sync = useCallback(async (silent = false) => {
    setSyncing(true);
    try {
      const settled = await Promise.allSettled(TABS.map(fetchTab));
      const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
      const failed = settled.filter(s => s.status === 'rejected');
      if (!ok.length) throw (failed[0]?.reason || new Error('Sync failed'));
      setTickets(ok.flatMap(o => o.rows));
      setTotalRows(ok.reduce((sum, o) => sum + o.totalRows, 0));
      setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      if (failed.length) {
        // Partial failure - show data from the tab(s) that succeeded, but don't hide that one
        // tab is stale/missing.
        setSyncError(`${failed.map(f => f.reason?.message || 'Sync failed').join('; ')}`);
        if (!silent) showToast(`⚠️ One tab failed to sync: ${failed[0].reason?.message || 'unknown error'}`);
      } else {
        setSyncError(null);
        syncFailCountRef.current = 0;
        if (!silent) showToast('Delivery-Escalation tickets synced');
      }
    } catch (e) {
      console.error('Delivery-Escalation sync failed:', e);
      setSyncError(e.message || 'Sync failed');
      if (!silent) showToast(e.message);
      syncFailCountRef.current = Math.min(syncFailCountRef.current + 1, 6);
      const backoffMs = Math.min(15000 * (2 ** (syncFailCountRef.current - 1)), 300000);
      const jitterMs = Math.random() * 3000;
      setTimeout(() => sync(true), backoffMs + jitterMs);
    } finally {
      setSyncing(false);
    }
  }, [showToast]);

  useEffect(() => { sync(true); }, [sync]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) sync(true); }, 60000);
    return () => clearInterval(t);
  }, [sync]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) sync(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [sync]);

  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState(() => safeStorage.getItem('de_brand_filter') || 'ALL');
  const [agentFilter, setAgentFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  useEffect(() => { setPage(1); }, [tab, search, brandFilter, agentFilter]);

  const [detailTkt, setDetailTkt] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);

  const openAction = async (t) => {
    let ticket = t;
    if (!t.assignedAgent && googleUser?.email) {
      try {
        await writeCells(t.tab, [{ range: `${COL_AGENT}${t.rowNum}`, values: [googleUser.email] }]);
        ticket = { ...t, assignedAgent: googleUser.email };
        setTickets(prev => prev.map(x => x.id === t.id ? ticket : x));
      } catch (e) {
        showToast(`⚠️ Could not claim ticket: ${e.message}`);
      }
    }
    setDetailTkt(ticket);
    setOutcome(ticket.outcome || '');
    setRemarks(ticket.remarks || '');
  };

  const saveAction = async () => {
    if (!detailTkt || !outcome) return;
    setSaving(true);
    try {
      const now = new Date();
      const actionDate = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
      const claimNow = !detailTkt.assignedAgent && googleUser?.email;
      const ranges = [
        { range: `${COL_ACTION_DATE}${detailTkt.rowNum}`, values: [actionDate] },
        { range: `${COL_OUTCOME}${detailTkt.rowNum}`, values: [outcome] },
        { range: `${COL_REMARKS}${detailTkt.rowNum}`, values: [remarks.trim()] },
      ];
      if (claimNow) ranges.push({ range: `${COL_AGENT}${detailTkt.rowNum}`, values: [googleUser.email] });
      await writeCells(detailTkt.tab, ranges);
      setTickets(prev => prev.map(x => x.id === detailTkt.id
        ? { ...x, actionDate, outcome, remarks: remarks.trim(), ...(claimNow ? { assignedAgent: googleUser.email } : {}) }
        : x));
      showToast('Resolution saved');
      setDetailTkt(null);
    } catch (e) {
      showToast(`⚠️ Could not save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // A plain (non-admin) account only ever sees tickets it has claimed - forced, not merely a
  // filter default, same as every other process in this app.
  const myScopeEmail = !sessionIsAdmin ? (googleUser?.email || '').toLowerCase() : '';
  const inMyScope = (t) => !myScopeEmail || (t.assignedAgent || '').toLowerCase() === myScopeEmail;

  const scopedTickets = useMemo(() => tickets.filter(inMyScope), [tickets, myScopeEmail]);
  const total = scopedTickets.length;
  const assigned = useMemo(() => scopedTickets.filter(t => t.assignedAgent).length, [scopedTickets]);
  const resolved = useMemo(() => scopedTickets.filter(t => t.outcome).length, [scopedTickets]);
  const freshCount = useMemo(() => scopedTickets.filter(t => t.assignedAgent && !t.outcome).length, [scopedTickets]);
  const unassignedCount = total - assigned;
  const resolutionRate = assigned > 0 ? Math.round((resolved / assigned) * 100) : 0;

  const agentOptions = useMemo(() => {
    const emails = Array.from(new Set(scopedTickets.map(t => t.assignedAgent).filter(Boolean)));
    return [{ value: 'ALL', label: 'All Agents' }, ...emails.sort().map(e => ({ value: e, label: e.split('@')[0] }))];
  }, [scopedTickets]);

  const filteredBase = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scopedTickets.filter(t => {
      if (brandFilter !== 'ALL' && t.brand !== brandFilter) return false;
      if (agentFilter !== 'ALL' && (t.assignedAgent || '') !== agentFilter) return false;
      if (!q) return true;
      return (t.awb || '').toLowerCase().includes(q) || (t.orderId || '').toLowerCase().includes(q);
    });
  }, [scopedTickets, search, brandFilter, agentFilter]);

  const rowsForTab = useMemo(() => {
    if (tab === 'fresh') return filteredBase.filter(t => t.assignedAgent && !t.outcome);
    if (tab === 'resolved') return filteredBase.filter(t => t.outcome);
    return filteredBase;
  }, [filteredBase, tab]);

  const totalPages = Math.max(1, Math.ceil(rowsForTab.length / perPage));
  const pageRows = useMemo(() => rowsForTab.slice((page - 1) * perPage, page * perPage), [rowsForTab, page, perPage]);

  const tabsList = [
    { key: 'overview', label: '📊 Overview', count: total },
    { key: 'fresh', label: '⚡ Fresh (Assigned)', count: freshCount },
    { key: 'resolved', label: '✅ Resolved', count: resolved },
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
            <button onClick={() => sync(false)} disabled={syncing} className="h-8 px-2.5 sm:px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50 shrink-0" title="Refresh Delivery-Escalation data">
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
              {totalRows > tickets.length && (
                <div className="text-[12px] text-amber-400">
                  ⚠ Showing the most recent {tickets.length.toLocaleString('en-IN')} of {totalRows.toLocaleString('en-IN')} total rows across both tabs - older rows aren&apos;t loaded (payload size cap).
                </div>
              )}

              {tab === 'overview' && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Total Tickets</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{total.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-500 mb-1">Assigned</p>
                    <p className="text-2xl font-extrabold text-indigo-400 tabular-nums">{assigned.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-amber-900/50 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-1">Unassigned</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{unassignedCount.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-emerald-900/50 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-500 mb-1">Resolved</p>
                    <p className="text-2xl font-extrabold text-emerald-500 tabular-nums">{resolved.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">{resolutionRate}% of assigned</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Awaiting Resolution</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{freshCount.toLocaleString('en-IN')}</p>
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
                        options={[{ value: 'ALL', label: 'All Brands' }, ...TABS.map(t => ({ value: t, label: t }))]}
                        placeholder="Brand"
                      />
                      {sessionIsAdmin && (
                        <CustomSelect value={agentFilter} onChange={setAgentFilter} options={agentOptions} placeholder="Agent" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                      <span>{rowsForTab.length.toLocaleString('en-IN')} tickets</span>
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
                          {tab === 'resolved' && <th className="py-3 px-4 text-left font-medium">Action Date</th>}
                          {tab === 'resolved' && <th className="py-3 px-4 text-left font-medium">Outcome</th>}
                          {tab === 'resolved' && <th className="py-3 px-4 text-left font-medium">Remarks</th>}
                          <th className="py-3 px-4 text-right font-medium">Action</th>
                        </tr></thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {pageRows.map(t => (
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
                              {tab === 'resolved' && <td className="py-3 px-4 text-zinc-400">{t.actionDate}</td>}
                              {tab === 'resolved' && <td className="py-3 px-4 text-zinc-400">{t.outcome}</td>}
                              {tab === 'resolved' && <td className="py-3 px-4 text-zinc-400 max-w-xs truncate" title={t.remarks}>{t.remarks}</td>}
                              <td className="py-3 px-4 text-right">
                                <button
                                  onClick={() => openAction(t)}
                                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-semibold transition-colors"
                                >
                                  {t.outcome ? 'View / Edit' : 'Resolve'}
                                </button>
                              </td>
                            </tr>
                          ))}
                          {pageRows.length === 0 && (
                            <tr><td colSpan={tab === 'resolved' ? 13 : 10} className="py-8 text-center text-zinc-500">No tickets in this view.</td></tr>
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
            </div>
          </div>
        )}
      </main>

      {detailTkt && (
        <Overlay onClose={() => setDetailTkt(null)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 w-full max-w-lg space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-zinc-100">Resolve Ticket</h3>
              <button onClick={() => setDetailTkt(null)} className="text-zinc-500 hover:text-zinc-300"><XIcon /></button>
            </div>
            <div className="text-[13px] text-zinc-400 space-y-1">
              <p><span className="text-zinc-500">Order ID:</span> {detailTkt.orderId} &nbsp; <span className="text-zinc-500">AWB:</span> {detailTkt.awb}</p>
              <p><span className="text-zinc-500">Brand:</span> {detailTkt.brand} &nbsp; <span className="text-zinc-500">Partner:</span> {detailTkt.deliveryPartner}</p>
              <p><span className="text-zinc-500">Query:</span> {detailTkt.queryClass} / {detailTkt.queryCategory}</p>
            </div>
            <div>
              <label className="text-[12px] font-semibold text-zinc-400 mb-1 block">Outcome</label>
              <CustomSelect
                value={outcome}
                onChange={setOutcome}
                options={OUTCOME_OPTIONS.map(o => ({ value: o, label: o }))}
                placeholder="Select outcome"
              />
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
            <div className="flex justify-end gap-2">
              <button onClick={() => setDetailTkt(null)} className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[13px] font-semibold transition-colors">Cancel</button>
              <button
                onClick={saveAction}
                disabled={!outcome || saving}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-semibold transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
