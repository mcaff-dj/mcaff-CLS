'use client';

// NPS-Calling's own workspace (process key 'detractor' - see api/_lib/callingProcesses.json).
// Built on the same shared app/_calling/ pieces as RTO/NDR, but its data flow is deliberately
// simpler than either: there is no Sheet and no CSV upload, because the lead pool is the MySQL
// table nps_delivery (read-only, external) copied on-assign into CLS_NPS_calling - see
// api/_lib/db.js's getNextDetractorLead/disposeDetractorLead. So this file has no sync-from-
// sheet loop, no upload modal, and no team split (single shared queue/disposition tree for v1).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { XIcon, CheckIcon, PhoneIcon, CustomSelect, Overlay, CalendarIcon } from '../_calling/ui';
import { useCallingSession, ROSTER_STATUS_OPTIONS, STATUS_OPTIONS } from '../_calling/useCallingSession';
import { useBusinessHours, CallingHoursCard, useDefaultQuota, DefaultQuotaCard, useProcessDispositions, ProcessDispositionsCard } from '../_calling/CallingAdminPanel';
import { CallingShell } from '../_calling/CallingShell';
import { scopeToDateBounds } from '../_calling/util';

const PROCESS_KEY = 'detractor';
// Keep in sync with api/detractor/next-lead.js's own FALLBACK_QUOTA - shown in the admin card so
// "blank" reads as a real number instead of an unexplained empty field.
const FALLBACK_QUOTA = 15;

// Snapshot fields on a ticket worth showing the agent, in display order - {label, field}. Reason
// pairs are only rendered when their *_reason (or _openend) actually has text, since a detractor
// only ever fills in the area(s) relevant to their complaint.
const REASON_AREAS = [
  { label: 'Delivery', reason: 'delivery_detractor_reason', openend: 'delivery_detractor_openend' },
  { label: 'Customer Service', reason: 'cs_detractor_reason', openend: 'cs_detractor_openend' },
  { label: 'Product / Packaging', reason: 'product_packaging_detractor_reason', openend: 'product_packaging_detractor_openend' },
  { label: 'Platform', reason: 'platform_detractor_reason', openend: 'platform_detractor_openend' },
];

function isUndisposed(t) {
  return !t.disposed_at;
}

// Recursive multi-select over the admin-configured disposition tree (calling_process_
// dispositions, shared across every process - see useProcessDispositions). A detractor often
// raises more than one issue in a single call, so unlike RTO/NDR's single cascading pick, every
// leaf (no children) is its own checkbox and any number can be checked - independently, across
// categories - rather than the call being forced into one final label. A node WITH children is
// just a section header; it's never itself selectable. `selected` is the Map from
// id -> {id, path} kept in NpsCallingClient's own dispose-modal state; `ancestors` is the chain
// of labels above `nodes` in this recursion, so a checked leaf's `path` carries its whole
// breadcrumb (e.g. ['Delivery Related', 'Late delivery']) for saveDisposition to join on.
function DispositionChecklist({ nodes, selected, onToggle, ancestors = [] }) {
  if (!nodes || !nodes.length) {
    return <p className="text-[12px] text-zinc-500">No disposition options configured yet - an admin can add some under Admin Panel.</p>;
  }
  return (
    <div className="space-y-3">
      {nodes.map((n) => {
        const path = [...ancestors, n.label];
        const hasChildren = n.children && n.children.length > 0;
        if (hasChildren) {
          return (
            <div key={n.id} className="space-y-1.5">
              <p className="text-[12px] font-bold text-zinc-300">{n.label}</p>
              <div className="pl-3 border-l border-zinc-800">
                <DispositionChecklist nodes={n.children} selected={selected} onToggle={onToggle} ancestors={path} />
              </div>
            </div>
          );
        }
        const checked = selected.has(n.id);
        return (
          <label key={n.id} className="flex items-center gap-2 text-[12px] text-zinc-200 cursor-pointer" title={n.description || ''}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(n.id, path)}
              className="accent-indigo-500"
            />
            {n.label}
          </label>
        );
      })}
    </div>
  );
}

export default function NpsCallingClient() {
  // No date-scope filter UI in v1 (unlike RTO/NDR's Overview date picker) - Overview below is
  // roster-wide, all-time counts. getDateBounds is still wired through so Logged In At/Total
  // Break Time in the shared session hook have a sane (unbounded) answer.
  const session = useCallingSession(PROCESS_KEY, {
    getDateBounds: () => scopeToDateBounds('ALL_TIME', '', ''),
  });
  const {
    googleUser, sessionIsAdmin, invitedProcessKeys, processPermsLoaded,
    processAgents, isProcessAdmin, saveProcessAgent, savingAgentEmail,
    setStatusForAgent, showToast,
  } = session;

  const hours = useBusinessHours(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const defaultQuota = useDefaultQuota(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast });
  const { processDispositions } = disp;

  useEffect(() => {
    document.documentElement.className = 'light';
    document.body.className = 'font-sans antialiased min-h-screen theme-light';
  }, []);

  const canAdminTab = sessionIsAdmin || isProcessAdmin;
  const [tab, setTab] = useState('queue');
  useEffect(() => {
    if (tab === 'admin' && !canAdminTab) setTab('queue');
  }, [tab, canAdminTab]);
  const [rosterStatusFilter, setRosterStatusFilter] = useState('All');

  // My tickets: everything CLS_NPS_calling holds for this agent, undisposed and disposed alike -
  // split client-side (queue vs disposed) rather than two separate fetches, since one agent's
  // own row count is small.
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [lastSync, setLastSync] = useState('—');
  const fetchMyTickets = useCallback(async () => {
    setTicketsLoading(true);
    try {
      const r = await fetch('/api/detractor/tickets');
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setTickets(d.tickets || []);
        setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      } else {
        showToast(`⚠️ ${d.error || 'Could not load tickets'}`);
      }
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setTicketsLoading(false);
    }
  }, [showToast]);
  useEffect(() => { if (googleUser?.email) fetchMyTickets(); }, [googleUser, fetchMyTickets]);

  // Every agent's tickets, admin/process-admin only - Overview tab's roster-wide counts.
  const [allTickets, setAllTickets] = useState(null);
  const fetchAllTickets = useCallback(async () => {
    try {
      const r = await fetch('/api/detractor/tickets?scope=all');
      const d = await r.json().catch(() => ({}));
      if (r.ok) setAllTickets(d.tickets || []);
    } catch (e) { /* Overview falls back to own tickets below - not worth a toast */ }
  }, []);
  useEffect(() => { if (canAdminTab) fetchAllTickets(); }, [canAdminTab, fetchAllTickets]);

  const [pulling, setPulling] = useState(false);
  const pullNextLead = async () => {
    setPulling(true);
    try {
      const r = await fetch('/api/detractor/next-lead', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`⚠️ ${d.error || 'Could not pull a lead'}`); return; }
      if (!d.assigned) { showToast(d.reason || 'No lead available right now.'); return; }
      setTickets((prev) => [{ ...d.lead, agent_email: googleUser?.email, assigned_at: new Date().toISOString() }, ...prev]);
      showToast(`New lead: ${d.lead.customer_name || d.lead.response_id}`);
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setPulling(false);
    }
  };

  // Disposition modal state
  const [detailTkt, setDetailTkt] = useState(null);
  // Which reasons are checked, id -> {id, path} (path = the leaf's own breadcrumb of ancestor
  // labels + itself, e.g. ['Delivery Related', 'Late delivery']) - a Map so toggling one leaf is
  // an O(1) add/delete regardless of how many categories/reasons are in the tree. Rebuilt as a
  // fresh Map on every toggle so React sees a new reference and re-renders.
  const [selectedReasons, setSelectedReasons] = useState(new Map());
  const [dispRemarks, setDispRemarks] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [dispSaving, setDispSaving] = useState(false);

  const openDispose = (t) => {
    setDetailTkt(t);
    setSelectedReasons(new Map());
    setDispRemarks(t.agent_remarks || '');
    setAttempt(t.attempt || 1);
  };
  const closeDispose = () => setDetailTkt(null);

  // Connected/Non Connected are the tree's own two top-level branches (see
  // scripts/restructure_nps_calling_dispositions.py) and mutually exclusive by nature - a call
  // either went through or it didn't, never both. Checking a leaf from one branch drops every
  // selection from the other, so there's no separate "Connected? Yes/No" toggle to keep in sync
  // with the tree - derivedConnected below reads it straight off whichever branch is checked.
  const toggleReason = (id, path) => {
    setSelectedReasons((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      const branch = path[0];
      for (const [existingId, existing] of next) {
        if (existing.path[0] !== branch) next.delete(existingId);
      }
      next.set(id, { id, path });
      return next;
    });
  };

  // Every checked leaf's breadcrumb, joined "Category > Reason", one per selection - lets one
  // call carry several reasons (even across categories) in the single `disposition` column
  // rather than forcing the whole call into one final label.
  const joinedDisposition = useMemo(
    () => Array.from(selectedReasons.values()).map((r) => r.path.join(' > ')).join('; '),
    [selectedReasons],
  );

  // toggleReason's own exclusivity rule guarantees every selected reason shares one branch, so
  // the first one is enough to tell which.
  const derivedConnected = useMemo(() => {
    const first = selectedReasons.values().next().value;
    if (!first) return '';
    if (first.path[0] === 'Connected') return 'Yes';
    if (first.path[0] === 'Non Connected') return 'No';
    return '';
  }, [selectedReasons]);

  // Once a branch is picked, the OTHER branch's whole category list is hidden, not just
  // unselectable - showing 30-odd Connected reasons while a Non Connected reason is checked
  // is confusing (an agent could easily miss that ticking one of them would just switch
  // branches). Both branches show again once nothing is selected, so there's still a way in.
  const visibleDispositionNodes = useMemo(() => {
    if (!derivedConnected) return processDispositions;
    const wantLabel = derivedConnected === 'Yes' ? 'Connected' : 'Non Connected';
    return (processDispositions || []).filter((n) => n.label === wantLabel);
  }, [processDispositions, derivedConnected]);

  const saveDisposition = async () => {
    if (!detailTkt || !selectedReasons.size || !derivedConnected) return;
    setDispSaving(true);
    try {
      const r = await fetch('/api/detractor/lead-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dispose',
          responseId: detailTkt.response_id,
          disposition: joinedDisposition,
          agentRemarks: dispRemarks,
          connected: derivedConnected,
          attempt: Number(attempt) || 1,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`⚠️ ${d.error || 'Could not save disposition'}`); return; }
      setTickets((prev) => prev.map((t) => (
        t.response_id === detailTkt.response_id
          ? { ...t, disposed_at: new Date().toISOString(), disposition: joinedDisposition, agent_remarks: dispRemarks, connected: derivedConnected, attempt }
          : t
      )));
      showToast('Disposition saved');
      closeDispose();
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setDispSaving(false);
    }
  };

  const pendingTickets = tickets.filter(isUndisposed);
  const disposedTickets = tickets.filter((t) => !isUndisposed(t));

  const tabsList = [
    { key: 'queue', label: '📞 My Queue', count: pendingTickets.length },
    { key: 'disposed', label: 'Disposed', count: disposedTickets.length },
    { key: 'overview', label: '📊 Overview', count: (allTickets || tickets).length },
    ...(canAdminTab ? [{ key: 'admin', label: 'Admin Panel', count: (processAgents || []).length }] : []),
  ];

  const hasAccess = sessionIsAdmin || !invitedProcessKeys || invitedProcessKeys.includes(PROCESS_KEY);

  // Per-agent Assigned/Disposed/Connect % for the roster table below - computed from allTickets
  // (every CLS_NPS_calling row, admin-only fetch) rather than a dedicated endpoint, same as RTO's
  // own agentMetrics does against its Sheet-derived tickets array.
  const agentMetrics = useMemo(() => {
    const source = allTickets || [];
    return (processAgents || []).map((a) => {
      const mine = source.filter((t) => (t.agent_email || '').toLowerCase() === a.email.toLowerCase());
      const disposed = mine.filter((t) => t.disposed_at);
      const connected = disposed.filter((t) => t.connected === 'Yes');
      return {
        ...a,
        assigned: mine.length,
        disposed: disposed.length,
        connectRate: disposed.length ? Math.round((connected.length / disposed.length) * 100) : 0,
      };
    });
  }, [processAgents, allTickets]);
  const visibleAgentMetrics = agentMetrics.filter((a) => rosterStatusFilter === 'All' || a.status === rosterStatusFilter);

  const renderTicketCard = (t, { showDisposeButton }) => (
    <div key={t.response_id} className="bg-zinc-900/90 border border-zinc-800/90 rounded-xl p-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-zinc-100 truncate">{t.customer_name || 'Unknown customer'}</p>
          <p className="text-[12px] text-zinc-500 flex items-center gap-1.5 flex-wrap">
            {t.customer_phone && <span className="flex items-center gap-1"><PhoneIcon /> {t.customer_phone}</span>}
            {t.customer_email && <span>{t.customer_email}</span>}
            {t.brand && <span className="uppercase">{t.brand}</span>}
            {t.channel_order_id && <span>Order {t.channel_order_id}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
            NPS {t.nps_score ?? '—'} · {t.nps_category}
          </span>
          {t.submitted_date && (
            <span className="text-[11px] text-zinc-500 flex items-center gap-1"><CalendarIcon /> {t.submitted_date}</span>
          )}
        </div>
      </div>

      {(t.category || t.sub_category) && (
        <p className="text-[12px] text-zinc-400">{[t.category, t.sub_category].filter(Boolean).join(' · ')}</p>
      )}

      <div className="space-y-1.5">
        {REASON_AREAS.map(({ label, reason, openend }) => {
          const r = t[reason];
          const o = t[openend];
          if (!r && !o) return null;
          return (
            <p key={label} className="text-[12px] text-zinc-300">
              <span className="font-semibold text-zinc-200">{label}:</span> {[r, o].filter(Boolean).join(' — ')}
            </p>
          );
        })}
        {t.additional_feedback && (
          <p className="text-[12px] text-zinc-300"><span className="font-semibold text-zinc-200">Feedback:</span> {t.additional_feedback}</p>
        )}
      </div>

      {(t.address_city || t.address_state || t.address_pincode) && (
        <p className="text-[11px] text-zinc-500">{[t.address_city, t.address_state, t.address_pincode].filter(Boolean).join(', ')}</p>
      )}

      {t.disposed_at ? (
        <div className="text-[12px] text-emerald-400 space-y-0.5">
          {(t.disposition || '').split(';').map((s) => s.trim()).filter(Boolean).map((line, i) => (
            <p key={i} className="flex items-center gap-1.5"><CheckIcon /> {line}</p>
          ))}
          <p className="text-zinc-500">Connected: {t.connected || '—'} · Attempt {t.attempt ?? '—'}</p>
        </div>
      ) : showDisposeButton ? (
        <button
          type="button"
          onClick={() => openDispose(t)}
          className="mt-1 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
        >
          Call &amp; Dispose
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      <CallingShell
        logoLabel="NPS"
        title="NPS-Calling Agent Portal"
        lastSync={lastSync}
        syncing={ticketsLoading}
        syncError={null}
        onSync={() => fetchMyTickets()}
        session={session}
        rightSlot={
          <button
            type="button"
            onClick={pullNextLead}
            disabled={pulling}
            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-[13px] font-bold text-white transition-colors shrink-0"
          >
            {pulling ? 'Pulling…' : '📞 Pull Next Lead'}
          </button>
        }
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-5 py-5 space-y-5">
        {processPermsLoaded && !hasAccess && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-8 shadow-xl backdrop-blur-md">
            <div className="max-w-2xl space-y-3">
              <h2 className="text-lg font-bold text-zinc-100">No access to NPS-Calling</h2>
              <p className="text-[13px] text-zinc-400 leading-relaxed">
                This account hasn&apos;t been invited to NPS-Calling yet. An admin can grant it
                from Admin &rarr; Permissions by ticking NPS-Calling under the Calling card.
              </p>
              <p className="text-[13px] text-zinc-500">Signed in as {googleUser?.email || 'an unknown account'}.</p>
            </div>
          </div>
        )}

        {hasAccess && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-1.5 shadow-xl backdrop-blur-md">
            <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar w-full mb-1.5">
              {tabsList.map((t) => (
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
                  <span className="px-1.5 py-0.5 rounded-md text-[11px] bg-black/20">{t.count}</span>
                </button>
              ))}
            </nav>

            <div className="p-3">
              {tab === 'queue' && (
                <div className="space-y-3">
                  {ticketsLoading && <p className="text-[13px] text-zinc-500">Loading…</p>}
                  {!ticketsLoading && !pendingTickets.length && (
                    <p className="text-[13px] text-zinc-500">No leads in your queue. Click Pull Next Lead above.</p>
                  )}
                  {pendingTickets.map((t) => renderTicketCard(t, { showDisposeButton: true }))}
                </div>
              )}

              {tab === 'disposed' && (
                <div className="space-y-3">
                  {!disposedTickets.length && <p className="text-[13px] text-zinc-500">Nothing disposed yet.</p>}
                  {disposedTickets.map((t) => renderTicketCard(t, { showDisposeButton: false }))}
                </div>
              )}

              {tab === 'overview' && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {(() => {
                    const source = allTickets || tickets;
                    const total = source.length;
                    const disposedCount = source.filter((t) => !isUndisposed(t)).length;
                    const undisposedCount = total - disposedCount;
                    const connectedCount = source.filter((t) => t.connected === 'Yes').length;
                    const stats = [
                      { label: 'Total Leads', value: total },
                      { label: 'Disposed', value: disposedCount },
                      { label: 'Pending', value: undisposedCount },
                      { label: 'Connected', value: connectedCount },
                    ];
                    return stats.map((s) => (
                      <div key={s.label} className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-4">
                        <p className="text-[11px] text-zinc-500 font-semibold uppercase">{s.label}</p>
                        <p className="text-2xl font-extrabold text-zinc-100">{s.value}</p>
                      </div>
                    ));
                  })()}
                </div>
              )}

              {tab === 'admin' && canAdminTab && (
                <div className="space-y-5">
                  <CallingHoursCard processKey={PROCESS_KEY} processLabel="NPS-Calling" hours={hours} />
                  <DefaultQuotaCard processLabel="NPS-Calling" fallback={FALLBACK_QUOTA} quota={defaultQuota} />
                  <ProcessDispositionsCard processLabel="NPS-Calling" disp={disp} allowInputTypeControl />

                  <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between flex-wrap gap-3 p-4 pb-3">
                      <div>
                        <h3 className="text-[15px] font-bold text-zinc-100">Team Roster</h3>
                        <p className="text-[12px] text-zinc-500 mt-0.5">
                          Manage agent status and lead capacity limits. New agents appear here
                          automatically once granted NPS-Calling under Admin → Permissions.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <CustomSelect
                          value={rosterStatusFilter}
                          onChange={setRosterStatusFilter}
                          options={ROSTER_STATUS_OPTIONS}
                          placeholder="Filter by status"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm(`Mark all ${agentMetrics.length} agents Offline? This updates each agent's live status on the server.`)) return;
                            agentMetrics.forEach((a) => setStatusForAgent(a.email, 'Offline', a.email));
                            showToast('⚪ All agents marked Offline');
                          }}
                          className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[12px] font-bold transition-all shadow-xs shrink-0"
                          title="Set every agent's status to Offline (syncs to the server for each row)"
                        >
                          ⚪ Mark All Offline
                        </button>
                      </div>
                    </div>

                    {!agentMetrics.length && (
                      <p className="text-[12px] text-zinc-500 px-4 pb-4">No agents invited yet - grant access from Admin → Permissions.</p>
                    )}

                    {!!agentMetrics.length && (
                      <div className="overflow-x-auto custom-scroll">
                        <table className="w-full text-[13px]">
                          <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                            <th className="py-3 px-4 text-left font-medium">Agent</th>
                            <th className="py-3 px-4 text-left font-medium">Status</th>
                            <th className="py-3 px-4 text-center font-medium">Assigned</th>
                            <th className="py-3 px-4 text-center font-medium">Disposed</th>
                            <th className="py-3 px-4 text-center font-medium">Connect %</th>
                            <th className="py-3 px-4 text-left font-medium">Quota</th>
                            <th className="py-3 px-4 text-center font-medium" title="Can manage this process's roster and calling hours - nothing else">Process admin</th>
                          </tr></thead>
                          <tbody className="divide-y divide-zinc-800/50">
                            {visibleAgentMetrics.map((a) => (
                              <tr key={a.email} className="hover:bg-zinc-800/30 transition-colors">
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2.5">
                                    <div className="relative">
                                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white font-bold text-[11px] shadow">
                                        {a.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)}
                                      </div>
                                      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-900 ${a.status === 'Online' ? 'bg-emerald-500' : a.status === 'Busy' ? 'bg-amber-400' : a.status === 'OnCall' ? 'bg-rose-500' : 'bg-zinc-500'}`}></span>
                                    </div>
                                    <div className="min-w-0">
                                      <p className="font-semibold text-zinc-100 truncate">{a.name}</p>
                                      <p className="text-zinc-500 text-[11px] font-mono truncate">{a.email}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.status}
                                    onChange={(val) => setStatusForAgent(a.email, val, a.email)}
                                    options={STATUS_OPTIONS}
                                  />
                                </td>
                                <td className="py-3 px-4 text-center font-bold text-zinc-100 tabular-nums">{a.assigned}</td>
                                <td className="py-3 px-4 text-center font-bold text-indigo-400 tabular-nums">{a.disposed}</td>
                                <td className="py-3 px-4 text-center font-bold text-emerald-400 tabular-nums">{a.connectRate}%</td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.maxQuota ?? ''}
                                    onChange={(val) => saveProcessAgent(a.email, { maxQuota: val === '' ? null : +val })}
                                    options={[
                                      { value: '', label: 'Default (15)' },
                                      { value: 5, label: '5 leads' },
                                      { value: 10, label: '10 leads' },
                                      { value: 15, label: '15 leads' },
                                      { value: 20, label: '20 leads' },
                                      { value: 30, label: '30 leads' },
                                    ]}
                                  />
                                </td>
                                <td className="py-3 px-4 text-center">
                                  {a.isAdmin ? (
                                    <span className="text-[11px] text-zinc-500" title="Company-wide admin - already administers every process">all</span>
                                  ) : (
                                    <input
                                      type="checkbox"
                                      checked={!!a.isProcessAdmin}
                                      disabled={!sessionIsAdmin || savingAgentEmail === a.email}
                                      onChange={(e) => saveProcessAgent(a.email, { isProcessAdmin: e.target.checked })}
                                      className="accent-emerald-500"
                                      title={sessionIsAdmin ? 'Let this person manage this process' : 'Only a full admin can change this'}
                                    />
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {detailTkt && (
        <Overlay onClose={closeDispose}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold text-zinc-100">Dispose lead — {detailTkt.customer_name || detailTkt.response_id}</h3>
              <button type="button" onClick={closeDispose}><XIcon className="text-zinc-500 hover:text-zinc-200" /></button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[12px] text-zinc-400 font-semibold">Connected:</span>
              <span className={`px-3 py-1 rounded-lg text-[12px] font-bold border ${
                derivedConnected === 'Yes' ? 'bg-emerald-600 border-emerald-500 text-white'
                  : derivedConnected === 'No' ? 'bg-rose-600 border-rose-500 text-white'
                  : 'border-zinc-700 text-zinc-500'
              }`}>
                {derivedConnected || 'Pick a reason below'}
              </span>
              <span className="text-[12px] text-zinc-400 font-semibold ml-3">Attempt</span>
              <input
                type="number"
                min="1"
                value={attempt}
                onChange={(e) => setAttempt(e.target.value)}
                className="w-16 h-8 px-2 rounded-lg bg-zinc-950 border border-zinc-800 text-[12px] text-zinc-200"
              />
            </div>

            <div>
              <p className="text-[12px] text-zinc-400 font-semibold mb-1.5">
                Disposition{selectedReasons.size ? ` (${selectedReasons.size} selected)` : ''} — pick Connected or Non Connected, then check every reason that applies
              </p>
              <DispositionChecklist nodes={visibleDispositionNodes} selected={selectedReasons} onToggle={toggleReason} />
            </div>

            <textarea
              value={dispRemarks}
              onChange={(e) => setDispRemarks(e.target.value)}
              placeholder="Agent remarks"
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-200"
            />

            <button
              type="button"
              disabled={!selectedReasons.size || !derivedConnected || dispSaving}
              onClick={saveDisposition}
              className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-[13px] font-bold text-white transition-colors"
            >
              {dispSaving ? 'Saving…' : 'Save Disposition'}
            </button>
          </div>
        </Overlay>
      )}
    </div>
  );
}
