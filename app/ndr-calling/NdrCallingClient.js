'use client';

// NDR Calling's own independent workspace - split out of app/rto-crm/RtoCrmClient.js (see the
// plan for splitting Calling processes into their own pages, one folder per process). Built
// entirely on the shared app/_calling/ pieces (session/presence, admin panel, page shell) so
// this file only ever contains what's actually specific to NDR: its own sheet columns, its own
// disposition-recording flow, its own lead table.
//
// Deliberately independent of app/rto-crm/RtoCrmClient.js - NDR's rules are simpler and diverge
// from RTO's, so nothing here is shared with RTO beyond the generic app/_calling/ modules both
// pages import, and the already-process-keyed Postgres tables/API routes both processes' server
// code already uses.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  XIcon, CheckIcon, PhoneIcon, CustomSelect, MultiSelectDropdown, Overlay,
} from '../_calling/ui';
import { useCallingSession, STATUS_OPTIONS, ROSTER_STATUS_OPTIONS } from '../_calling/useCallingSession';
import { useBusinessHours, CallingHoursCard, useProcessDispositions, ProcessDispositionsCard } from '../_calling/CallingAdminPanel';
import { CallingShell } from '../_calling/CallingShell';

const PROCESS_KEY = 'ndr';

// Selected-card tone classes for the Call modal's disposition picker - full literal strings,
// not built via `${tone}` interpolation, since Tailwind's build-time scanner only keeps classes
// that appear as complete substrings in the source. Reuses the exact strings RTO's own dispTkt
// modal uses for its Connected/Unreachable/outcome cards, so both modals render identically for
// the same tone.
const NDR_DISP_TONE_EMERALD = { card: 'bg-emerald-950/30 border-emerald-500/80 text-emerald-200 shadow-lg shadow-emerald-950/40 ring-1 ring-emerald-500/50', icon: 'text-emerald-400' };
const NDR_DISP_TONE_ROSE = { card: 'bg-rose-950/30 border-rose-500/80 text-rose-200 shadow-lg shadow-rose-950/40 ring-1 ring-rose-500/50', icon: 'text-rose-400' };
const NDR_DISP_TONE_INDIGO = { card: 'bg-indigo-950/40 border-indigo-500 text-indigo-100 shadow-md shadow-indigo-950/30 ring-1 ring-indigo-500/40', icon: 'text-indigo-400' };

const NDR_ATTEMPT_FILTER_OPTIONS = ['1', '2', '3', 'More than 3'];

const NDR_SHEET_ID = '12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI';
const NDR_SHEET_TAB = 'Latest NDR '; // trailing space is part of the real tab name

async function fetchNdrSheetValues(range) {
  const r = await fetch(`/api/ndr/sheet?op=values&sid=${encodeURIComponent(NDR_SHEET_ID)}&range=${encodeURIComponent(range)}`);
  // Include the response body in the thrown message - a bare status code (401 vs 403 vs 500)
  // collapses several very different failure modes (our own session/permission check vs
  // Google's own API rejecting the request vs a Lambda-level error) into one number, which cost
  // real time to debug from the console alone when this first shipped.
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Sheets API ${r.status}${body ? ': ' + body.slice(0, 300) : ''}`);
  }
  const d = await r.json();
  if (!d.values) throw new Error('No data'); return d.values;
}

// This sheet is owned by an existing CS/ops process, not by us, and it keeps growing under that
// process regardless of anything this app does. Capped the same defensive way an earlier, much
// larger fetch (against a different sheet) had to be after a real ~13MB response blew past the
// Lambda's ~6MB synchronous response-payload limit: read one cheap single-column indicator
// first to find the sheet's current size, then fetch only a bounded TAIL (most recent rows by
// sheet position).
//
// That tail-by-position choice broke a real case at 5,000: Agent Name gets assigned by
// scripts/assign_ndr_leads.py's own round-robin, which sorts by Latest NDR Date, NOT by sheet
// row position - an agent's own assigned rows can sit anywhere in the sheet, so a 5,000-row
// tail window silently excluded a real agent's real assigned leads that happened to land in the
// older rows outside it. Raised well past the sheet's size at the time - not a permanent fix,
// but a properly scalable version needs to fetch by WHO the row belongs to, not by recency.
const NDR_MAX_ROWS = 12000;
const NDR_LAST_COL = 'AB'; // Remarks - the last column this UI reads or writes
async function fetchNdrSheet() {
  const idCol = await fetchNdrSheetValues(`'${NDR_SHEET_TAB}'!A2:A1000000`);
  if (!idCol.length) return { rows: [], startRow: 2, totalRows: 0 };
  const totalRows = idCol.length;
  const lastRow = totalRows + 1;
  const startRow = Math.max(2, lastRow - NDR_MAX_ROWS + 1);
  const rows = await fetchNdrSheetValues(`'${NDR_SHEET_TAB}'!A${startRow}:${NDR_LAST_COL}${lastRow}`);
  return { rows, startRow, totalRows };
}

// Fixed positional layout, not fuzzy header matching - this sheet's own columns are stable
// (it's someone else's existing, long-running process), so a column-index map is simpler and
// correct. Only assignedAgent (S, index 18) is ever written by scripts/assign_ndr_leads.py;
// callingDate/connected/outcome/remarks (R/T/U/AB), plus V ("Did you receive any call from the
// delivery agent?", only when the agent went down the "Have you got call from Partner" branch),
// are the only ones this UI's own disposition-save writes (see saveNdrDisposition) - every
// other column here belongs to a separate downstream CS process and is deliberately not even
// read, let alone written, since we don't understand its full taxonomy well enough to touch it.
function mapNdrRow(row, rowNum) {
  const v = (i) => row[i] !== undefined ? row[i] : '';
  return {
    id: `${v(4)}-${rowNum}`, rowNum,
    orderId: v(0), customerName: v(1), customerMobile: v(3), awb: v(4), partner: v(5),
    address: v(6), pincode: v(7), city: v(8), state: v(9), status: v(12), attempts: v(14),
    latestNdrDate: v(15), latestNdrReason: v(16), callingDate: v(17), assignedAgent: v(18),
    connected: v(19), outcome: v(20), deliveryAgentCall: v(21), remarks: v(27),
  };
}

// Writes one or more cell ranges in a single batchUpdate call - the only writes this UI ever
// makes are Agent Name (claim on Call) and Calling Date/Connected/Outcome/Remarks (disposition
// save - see saveNdrDisposition), sometimes both at once (disposing a lead nobody claimed yet).
async function writeNdrCells(ranges) {
  const r = await fetch('/api/ndr/sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'batchUpdate', sid: NDR_SHEET_ID,
      data: ranges.map(({ range, values }) => ({ range: `'${NDR_SHEET_TAB}'!${range}`, values: [values] })),
    }),
  });
  if (!r.ok) throw new Error(`Sheets write ${r.status}`);
  return r.json();
}

// Mirrors a claim/disposition into ndr_lead_assignments (see api/ndr/lead-assignment.js) - a
// parallel write alongside the sheet write above, not a replacement: the sheet stays what this
// UI reads from, Postgres is the durable/queryable history side. Best-effort by design - a
// failure here must never undo or block a sheet write that already succeeded, so callers only
// log/soft-toast, never throw.
async function recordNdrLeadAssignment(body) {
  const r = await fetch('/api/ndr/lead-assignment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    console.error('recordNdrLeadAssignment failed:', d.error || r.status);
  }
}

export default function NdrCallingClient() {
  const session = useCallingSession(PROCESS_KEY, {
    // NDR has no RTO-style "My Active Queue" pending-box concept to trigger an instant
    // off-cycle assignment run with, and no per-agent date-scope filter on presence figures -
    // both are RTO-specific refinements, safe to omit (the hook treats a missing getter as
    // "no value", not an error).
    getPendingBox: undefined,
    getDateBounds: undefined,
  });
  const {
    googleUser, userRole, sessionIsAdmin, invitedProcessKeys, processPermsLoaded,
    processAgents, isProcessAdmin, saveProcessAgent, savingAgentEmail,
    agentStatus, showToast,
  } = session;

  const hours = useBusinessHours(PROCESS_KEY, { userRole, isProcessAdmin, showToast });
  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast });
  const { processDispositions } = disp;

  // Same theme setup as RtoCrmClient.js's App() - one theme, always. The "zinc-900"/"#09090b"
  // etc. Tailwind classes used throughout this file are NOT actually dark in the shipped app;
  // body.theme-light in app/globals.css repaints all of them to a light background at the CSS
  // layer. Without this class on <body>, this page renders those classes literally (dark)
  // instead of matching every other page in this app.
  useEffect(() => {
    document.documentElement.className = 'light';
    document.body.className = 'font-sans antialiased min-h-screen theme-light';
  }, []);

  const [rosterStatusFilter, setRosterStatusFilter] = useState('All');

  const [ndrTickets, setNdrTickets] = useState([]);
  // Total row count in the sheet as of the last sync, vs. ndrTickets.length (which is capped
  // at NDR_MAX_ROWS) - lets the UI say "showing most recent N of TOTAL" instead of silently
  // pretending a capped view is the whole picture.
  const [ndrTotalRows, setNdrTotalRows] = useState(0);
  const [ndrSyncing, setNdrSyncing] = useState(false);
  const [ndrLastSync, setNdrLastSync] = useState('—');
  const [ndrSyncError, setNdrSyncError] = useState(null);
  const [ndrTab, setNdrTab] = useState('overview');
  const [ndrSearch, setNdrSearch] = useState('');
  const [ndrPerPage, setNdrPerPage] = useState(50);
  const [ndrPage, setNdrPage] = useState(1);
  // Which lead's Call/disposition modal is open, and the form fields it's editing.
  const [ndrDetailTkt, setNdrDetailTkt] = useState(null);
  const [ndrDispSelection, setNdrDispSelection] = useState('');
  // The label picked at each depth (e.g. ["Not Connected", "Reattempt", "Wrong Address"]) -
  // drives which cascading card options render at ndrDispLevels' next depth. Changing a level
  // truncates everything picked below it. ndrDispSelection stays the single FINAL value
  // everything else (save, the disabled check) reads - only set once the deepest picked node
  // has no children of its own left to choose.
  const [ndrDispPath, setNdrDispPath] = useState([]);
  const [ndrDispRemarks, setNdrDispRemarks] = useState('');
  const [ndrDispSaving, setNdrDispSaving] = useState(false);
  useEffect(() => { setNdrPage(1); }, [ndrTab, ndrSearch]);
  useEffect(() => {
    if (userRole === 'Agent' && !isProcessAdmin && (ndrTab === 'admin' || ndrTab === 'predicted')) {
      setNdrTab('overview');
    }
  }, [userRole, isProcessAdmin, ndrTab]);

  const ndrSyncFailCountRef = useRef(0);
  const syncNdr = useCallback(async (silent = false) => {
    setNdrSyncing(true);
    try {
      const { rows, startRow, totalRows } = await fetchNdrSheet();
      const mapped = rows.map((row, idx) => mapNdrRow(row, startRow + idx));
      setNdrTickets(mapped);
      setNdrTotalRows(totalRows);
      setNdrLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setNdrSyncError(null);
      ndrSyncFailCountRef.current = 0;
      if (!silent) showToast(`${mapped.length.toLocaleString('en-IN')} NDR leads synced`);
    } catch (e) {
      console.error('NDR sync failed:', e);
      setNdrSyncError(e.message || 'Sync failed');
      if (!silent) showToast(e.message);
      ndrSyncFailCountRef.current = Math.min(ndrSyncFailCountRef.current + 1, 6);
      const backoffMs = Math.min(15000 * (2 ** (ndrSyncFailCountRef.current - 1)), 300000);
      const jitterMs = Math.random() * 3000;
      setTimeout(() => syncNdr(true), backoffMs + jitterMs);
    } finally {
      setNdrSyncing(false);
    }
  }, [showToast]);

  useEffect(() => { syncNdr(true); }, [syncNdr]);
  useEffect(() => {
    const t = setInterval(() => syncNdr(true), 60000);
    return () => clearInterval(t);
  }, [syncNdr]);

  // Opens the Call/disposition modal, claiming the lead first if nobody holds it yet. Same
  // "skip the claim, don't block the modal" behavior while Offline: saveNdrDisposition writes
  // assignedAgent at SAVE time if it's still blank, so the lead ends up attributed to whoever
  // disposed it either way. Prefills the form from whatever's already on the row (editable, not
  // one-shot) rather than always blank.
  const openNdrCall = async (t) => {
    let ticket = t;
    if (!t.assignedAgent && agentStatus !== 'Offline' && googleUser?.email) {
      try {
        await writeNdrCells([{ range: `S${t.rowNum}`, values: [googleUser.email] }]);
        ticket = { ...t, assignedAgent: googleUser.email };
        setNdrTickets(prev => prev.map(x => x.id === t.id ? ticket : x));
        recordNdrLeadAssignment({ action: 'claim', awbNumber: t.awb, email: googleUser.email });
      } catch (e) {
        showToast(`⚠️ Could not claim lead: ${e.message}`);
      }
    }
    setNdrDetailTkt(ticket);
    const connected = ticket.connected === 'Yes';
    setNdrDispSelection(connected ? 'Connected' : '');
    setNdrDispPath(connected ? ['Connected'] : []);
    setNdrDispRemarks(ticket.remarks || '');
  };

  // Writes exactly this sheet's own existing Calling Date/Connected/Outcome/Remarks columns -
  // never Cs Action Remark/Refund Needed/Reorder ID/Final_status/45 Days Status, which belong
  // to a separate downstream CS process this modal has no business touching. Also claims the
  // lead (Agent Name) in the same call if it's still unassigned - covers the Offline skip in
  // openNdrCall above, so disposing a lead always ends up attributing it to whoever actually
  // did the work.
  const saveNdrDisposition = async () => {
    if (!ndrDetailTkt || !ndrDispSelection) return;
    setNdrDispSaving(true);
    try {
      const now = new Date();
      const callingDate = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
      const connectedValue = ndrDispPath[0] === 'Connected' ? 'Yes' : 'No';
      // Outcome (column U) is the category picked one level under Connected/Not Connected
      // ("New order Placed", "Reattempt", "Ringing", ...) - NOT the deepest leaf, which can be
      // a generic Yes/No that means nothing without the question it answered. A leaf picked
      // directly at the top level (no children at all) falls back to path[0] itself.
      const outcomeValue = ndrDispPath[1] || ndrDispPath[0] || ndrDispSelection;
      // "Have you got call from Partner" is this sheet's own pre-existing question - column V,
      // "Did you receive any call from the delivery agent?" - so whichever leaf is picked
      // directly under a node with that exact label goes there instead of getting buried as a
      // meaningless "Yes"/"No" Outcome.
      const partnerCallValue = ndrDispPath[ndrDispPath.length - 2] === 'Have you got call from Partner'
        ? ndrDispPath[ndrDispPath.length - 1]
        : null;
      // "Mark RTO"'s own leaf (Delay in Delivery / Packaging issue / Better Pricing elsewhere /
      // Others) is the SPECIFIC RTO reason - Outcome above only ever captures "Mark RTO" itself,
      // so without this the actual reason would just be dropped. Prefixed onto the free-text
      // remarks in brackets rather than overwriting them.
      const rtoReasonValue = ndrDispPath[1] === 'Mark RTO' ? ndrDispPath[2] : null;
      const remarksValue = (rtoReasonValue ? `[${rtoReasonValue}] ` : '') + ndrDispRemarks.trim();
      const ranges = [
        { range: `R${ndrDetailTkt.rowNum}`, values: [callingDate] },
        { range: `T${ndrDetailTkt.rowNum}`, values: [connectedValue] },
        { range: `U${ndrDetailTkt.rowNum}`, values: [outcomeValue] },
        { range: `AB${ndrDetailTkt.rowNum}`, values: [remarksValue] },
      ];
      if (partnerCallValue) ranges.push({ range: `V${ndrDetailTkt.rowNum}`, values: [partnerCallValue] });
      const claimNow = !ndrDetailTkt.assignedAgent && googleUser?.email;
      if (claimNow) ranges.push({ range: `S${ndrDetailTkt.rowNum}`, values: [googleUser.email] });
      await writeNdrCells(ranges);
      setNdrTickets(prev => prev.map(x => x.id === ndrDetailTkt.id
        ? { ...x, callingDate, connected: connectedValue, outcome: outcomeValue, remarks: remarksValue,
            ...(partnerCallValue ? { deliveryAgentCall: partnerCallValue } : {}),
            ...(claimNow ? { assignedAgent: googleUser.email } : {}) }
        : x));
      if (claimNow) await recordNdrLeadAssignment({ action: 'claim', awbNumber: ndrDetailTkt.awb, email: googleUser.email });
      await recordNdrLeadAssignment({ action: 'dispose', awbNumber: ndrDetailTkt.awb, disposition: ndrDispSelection, agentRemarks: ndrDispRemarks });
      showToast('Disposition saved');
      setNdrDetailTkt(null);
    } catch (e) {
      showToast(`⚠️ Could not save disposition: ${e.message}`);
    } finally {
      setNdrDispSaving(false);
    }
  };

  // A plain Agent only sees their own leads; Admin/Team Lead/process-admin see everyone's - the
  // same scoping every other view in this app applies. Flexible substring match (not exact
  // equality) on purpose: this sheet's Agent Name values aren't all full emails - some
  // pre-existing rows from before this app touched the sheet carry a bare first name instead.
  const ndrMyScopeEmail = userRole === 'Agent' && !isProcessAdmin ? (googleUser?.email || '').toLowerCase() : '';
  const ndrInMyScope = (t) => {
    if (!ndrMyScopeEmail) return true;
    const a = (t.assignedAgent || '').toLowerCase();
    // An unassigned row (a === '') must never pass: ''.includes('') and myScopeEmail.includes('')
    // are BOTH true in JS, which would silently let every unclaimed lead count as "mine".
    return !!a && (a.includes(ndrMyScopeEmail) || ndrMyScopeEmail.includes(a));
  };

  // "Disposed" = this sheet's own Connected column being non-blank - exactly the signal
  // saveNdrDisposition itself writes, so it's self-consistent without needing a Postgres
  // round-trip just to render the UI.
  const ndrScopedTickets = useMemo(() => ndrTickets.filter(ndrInMyScope), [ndrTickets, ndrMyScopeEmail]);
  const ndrTotal = ndrScopedTickets.length;
  const ndrDisposed = useMemo(() => ndrScopedTickets.filter(t => t.connected).length, [ndrScopedTickets]);
  const ndrAssigned = useMemo(() => ndrScopedTickets.filter(t => t.assignedAgent).length, [ndrScopedTickets]);
  const ndrUnassigned = ndrTotal - ndrAssigned;
  const ndrAttemptBuckets = useMemo(() => {
    const counts = { '1': 0, '2': 0, '3': 0, 'More than 3': 0 };
    for (const t of ndrScopedTickets) {
      const n = parseInt(t.attempts, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      const bucket = n <= 3 ? String(n) : 'More than 3';
      counts[bucket] = (counts[bucket] || 0) + 1;
    }
    return counts;
  }, [ndrScopedTickets]);
  const ndrFilteredBase = useMemo(() => {
    const q = ndrSearch.trim().toLowerCase();
    if (!q) return ndrScopedTickets;
    return ndrScopedTickets.filter(t =>
      (t.awb || '').toLowerCase().includes(q) ||
      (t.orderId || '').toLowerCase().includes(q) ||
      (t.customerMobile || '').includes(q)
    );
  }, [ndrScopedTickets, ndrSearch]);
  // 'fresh' = claimed but not yet worked (assigned, no disposition) - still owes a call.
  // 'all' (tab label "Total Leads Disposed") = only leads that have actually been worked.
  // 'predicted' is NOT a filter of this data - see ndrPredicted below, a live round-robin port
  // of scripts/assign_ndr_leads.py.
  const ndrRowsForTab = useMemo(() => {
    if (ndrTab === 'fresh') return ndrFilteredBase.filter(t => t.assignedAgent && !t.connected);
    return ndrFilteredBase.filter(t => t.connected); // 'all'
  }, [ndrFilteredBase, ndrTab]);

  // Disposition list to pick from in the Call modal - the Admin Panel's own disposition list
  // (processDispositions), walked one level per cascading card section so each only ever shows
  // the PREVIOUSLY chosen node's own children, never a flat mixed list an agent has to hunt
  // through. ndrDispLevels[0] is always the top-level list; ndrDispLevels[i] (i>0) only exists
  // once ndrDispPath has a label at depth i-1 whose node actually has children - the moment a
  // picked node is a leaf, the walk stops, matching how deep this particular branch goes.
  const ndrDispLevels = [processDispositions || []];
  {
    let nodes = processDispositions || [];
    for (let i = 0; ; i++) {
      const node = ndrDispPath[i] ? nodes.find(d => d.label === ndrDispPath[i]) : null;
      if (!node || !node.children || !node.children.length) break;
      nodes = node.children;
      ndrDispLevels.push(nodes);
    }
  }

  // Live round-robin PREDICTION of what scripts/assign_ndr_leads.py would assign next -
  // read-only, writes nothing. Ported field-for-field from that script: attempt_bucket()/
  // _covers()/the pop-when-exhausted cursor.
  const ndrPredicted = useMemo(() => {
    const onlineAgents = (processAgents || [])
      .filter(a => a.status === 'Online')
      .map(a => ({
        email: a.email,
        quota: a.maxQuota != null ? a.maxQuota : 20, // DEFAULT_QUOTA in assign_ndr_leads.py
        filter: (a.attemptCountFilter || '').split(',').map(s => s.trim()).filter(Boolean),
      }));
    if (!onlineAgents.length) return { rows: [], onlineAgents: [] };

    const bucketOf = (raw) => {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n <= 3 ? String(n) : 'More than 3';
    };
    const covers = (agent, bucket) => !agent.filter.length || bucket === null || agent.filter.includes(bucket);
    // "DD-MM-YYYY" -> a sortable number, undated leads sort last (same convention as
    // scripts/assign_ndr_leads.py's own parse_latest_ndr_date).
    const parseLatestNdrDate = (raw) => {
      const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec((raw || '').trim());
      return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : Infinity;
    };

    const pool = ndrTickets
      .filter(t => !t.assignedAgent && !t.connected)
      .map(t => ({ ...t, bucket: bucketOf(t.attempts) }))
      .sort((a, b) => parseLatestNdrDate(a.latestNdrDate) - parseLatestNdrDate(b.latestNdrDate));

    const needed = new Map(onlineAgents.map(a => [a.email, a.quota]));
    let remaining = onlineAgents.filter(a => needed.get(a.email) > 0);
    const rows = [];
    let idx = 0;
    for (const t of pool) {
      if (!remaining.length) break;
      const n = remaining.length;
      let chosen = -1;
      for (let step = 0; step < n; step++) {
        const cand = (idx + step) % n;
        if (covers(remaining[cand], t.bucket)) { chosen = cand; break; }
      }
      if (chosen === -1) continue; // no online agent's filter covers this lead's bucket
      const agent = remaining[chosen];
      rows.push({ ...t, predictedAgent: agent.email });
      needed.set(agent.email, needed.get(agent.email) - 1);
      if (needed.get(agent.email) <= 0) {
        remaining = remaining.filter((_, i) => i !== chosen);
        idx = remaining.length ? chosen % remaining.length : 0;
      } else {
        idx = (chosen + 1) % remaining.length;
      }
    }
    return { rows, onlineAgents };
  }, [ndrTickets, processAgents]);
  const ndrTotalPages = Math.max(1, Math.ceil(ndrRowsForTab.length / ndrPerPage));
  const ndrPageRows = useMemo(
    () => ndrRowsForTab.slice((ndrPage - 1) * ndrPerPage, ndrPage * ndrPerPage),
    [ndrRowsForTab, ndrPage, ndrPerPage]
  );
  // Connected/Remarks are raw sheet-write plumbing, not something a plain agent needs to read
  // off the table - they already see the same info in the Call modal's own "Last called" line
  // after disposing. Admin/Team Lead/process-admin keep both columns.
  const ndrAgentView = userRole === 'Agent' && !isProcessAdmin;

  const canAdminTab = userRole === 'Admin' || userRole === 'Team Lead' || isProcessAdmin;
  const canPredictedTab = userRole === 'Admin' || isProcessAdmin;

  // Simplified roster table - unlike RTO's own (app/rto-crm/RtoCrmClient.js), there's no
  // ticket-derived agent discovery or legacy localStorage roster here: NDR's roster is exactly
  // processAgents (who's actually invited to this process, per report_tab_permissions),
  // nothing more. Inviting someone new is an Admin -> Permissions action, not a roster-table
  // shortcut, since membership genuinely comes from the database, not a browser-side list.
  const renderNdrRosterTable = () => {
    const rows = (processAgents || []).filter(a => rosterStatusFilter === 'All' || a.status === rosterStatusFilter);
    return (
      <>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-bold text-zinc-100">Team Roster</h2>
            <p className="text-[13px] text-zinc-500 mt-0.5">Everyone invited to NDR Calling, their live status, quota, and attempt-count filter.</p>
          </div>
          <CustomSelect
            value={rosterStatusFilter}
            onChange={setRosterStatusFilter}
            options={ROSTER_STATUS_OPTIONS}
            placeholder="Filter by status"
          />
        </div>
        <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 overflow-hidden">
          <div className="overflow-x-auto custom-scroll">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                <th className="py-3 px-4 text-left font-medium">Agent</th>
                <th className="py-3 px-4 text-left font-medium">Status</th>
                <th className="py-3 px-4 text-left font-medium">Quota</th>
                <th className="py-3 px-4 text-left font-medium" title="Hard filter: restricts this agent to leads whose delivery-attempt count falls in the selected bucket(s). No selection = unrestricted.">Attempts</th>
                <th className="py-3 px-4 text-center font-medium" title="Can manage this process's roster, hours, and disposition list - nothing else">Process admin</th>
              </tr></thead>
              <tbody className="divide-y divide-zinc-800/50">
                {rows.map(a => (
                  <tr key={a.email} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="py-3 px-4">
                      <p className="font-semibold text-zinc-100">{a.name}</p>
                      <p className="text-zinc-500 text-[11px] font-mono">{a.email}</p>
                    </td>
                    <td className="py-3 px-4">
                      <CustomSelect
                        value={a.status}
                        onChange={(newStatus) => session.setStatusForAgent(a.email, newStatus, a.name)}
                        options={STATUS_OPTIONS}
                      />
                    </td>
                    <td className="py-3 px-4">
                      <CustomSelect
                        value={a.maxQuota ?? ''}
                        onChange={(val) => saveProcessAgent(a.email, { maxQuota: val === '' ? null : +val })}
                        options={[
                          { value: '', label: 'Default (20)' },
                          { value: 5, label: '5 leads' },
                          { value: 10, label: '10 leads' },
                          { value: 15, label: '15 leads' },
                          { value: 20, label: '20 leads' },
                          { value: 30, label: '30 leads' },
                        ]}
                      />
                    </td>
                    <td className="py-3 px-4">
                      <MultiSelectDropdown
                        value={(a.attemptCountFilter || '').split(',').map(s => s.trim()).filter(Boolean)}
                        onChange={(next) => saveProcessAgent(a.email, { attemptCountFilter: next.join(', ') })}
                        options={NDR_ATTEMPT_FILTER_OPTIONS}
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
                          onChange={e => saveProcessAgent(a.email, { isProcessAdmin: e.target.checked })}
                          className="accent-emerald-500"
                          title={sessionIsAdmin ? 'Let this person manage this process' : 'Only a full admin can change this'}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="py-8 text-center text-zinc-500">No one invited to NDR Calling yet - grant access from Admin → Permissions.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  const renderNdrLeadsTable = () => (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <input
          value={ndrSearch}
          onChange={e => setNdrSearch(e.target.value)}
          placeholder="Search AWB, order ID, mobile…"
          className="w-64 px-3 py-1.5 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
        />
        <div className="flex items-center gap-2 text-[12px] text-zinc-500">
          <span>{ndrRowsForTab.length.toLocaleString('en-IN')} leads</span>
          <CustomSelect
            value={ndrPerPage}
            onChange={(v) => setNdrPerPage(+v)}
            options={[{ value: 25, label: '25 per page' }, { value: 50, label: '50 per page' }, { value: 100, label: '100 per page' }]}
          />
        </div>
      </div>
      <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 overflow-hidden">
        <div className="overflow-x-auto custom-scroll">
          <table className="w-full text-[13px]">
            <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
              <th className="py-3 px-4 text-left font-medium">AWB</th>
              <th className="py-3 px-4 text-left font-medium">Order ID</th>
              <th className="py-3 px-4 text-left font-medium">Customer</th>
              <th className="py-3 px-4 text-left font-medium">Mobile</th>
              <th className="py-3 px-4 text-left font-medium">Address</th>
              <th className="py-3 px-4 text-left font-medium">Partner</th>
              <th className="py-3 px-4 text-center font-medium">Attempts</th>
              <th className="py-3 px-4 text-left font-medium">Latest NDR Reason</th>
              <th className="py-3 px-4 text-left font-medium">Status</th>
              <th className="py-3 px-4 text-left font-medium">Calling Date</th>
              <th className="py-3 px-4 text-left font-medium">Agent Name</th>
              {!ndrAgentView && <th className="py-3 px-4 text-left font-medium">Connected</th>}
              {!ndrAgentView && <th className="py-3 px-4 text-left font-medium">Remarks</th>}
              <th className="py-3 px-4 text-right font-medium">Action</th>
            </tr></thead>
            <tbody className="divide-y divide-zinc-800/50">
              {ndrPageRows.map(t => (
                <tr key={t.id} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="py-2.5 px-4 font-mono text-zinc-300">{t.awb}</td>
                  <td className="py-2.5 px-4 text-zinc-300">{t.orderId}</td>
                  <td className="py-2.5 px-4 text-zinc-300">{t.customerName}</td>
                  <td className="py-2.5 px-4 text-zinc-400">{t.customerMobile}</td>
                  <td className="py-2.5 px-4 text-zinc-400">{[t.address, t.city, t.state, t.pincode].filter(Boolean).join(', ')}</td>
                  <td className="py-2.5 px-4 text-zinc-400">{t.partner}</td>
                  <td className="py-2.5 px-4 text-center text-zinc-300">{t.attempts}</td>
                  <td className="py-2.5 px-4 text-zinc-400">{t.latestNdrReason}</td>
                  <td className="py-2.5 px-4 text-zinc-400">{t.status}</td>
                  <td className="py-2.5 px-4 text-zinc-400">{t.callingDate}</td>
                  <td className="py-2.5 px-4 text-zinc-300">{t.assignedAgent || <span className="text-zinc-600">Unassigned</span>}</td>
                  {!ndrAgentView && <td className="py-2.5 px-4 text-zinc-400">{t.connected}</td>}
                  {!ndrAgentView && <td className="py-2.5 px-4 text-zinc-400">{t.remarks}</td>}
                  <td className="py-2.5 px-4 text-right">
                    <button
                      onClick={() => openNdrCall(t)}
                      className="ml-auto px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-bold flex items-center gap-1.5 shadow-md shadow-indigo-950/40 transition-all"
                    >
                      <PhoneIcon /> Call
                    </button>
                  </td>
                </tr>
              ))}
              {ndrPageRows.length === 0 && (
                <tr><td colSpan={ndrAgentView ? 12 : 14} className="py-8 text-center text-zinc-500">No leads found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {ndrTotalPages > 1 && (
        <div className="flex items-center justify-center gap-2 text-[12px] text-zinc-400">
          <button onClick={() => setNdrPage(p => Math.max(1, p - 1))} disabled={ndrPage <= 1} className="px-2 py-1 rounded bg-zinc-800 disabled:opacity-40">Prev</button>
          <span>Page {ndrPage} of {ndrTotalPages}</span>
          <button onClick={() => setNdrPage(p => Math.min(ndrTotalPages, p + 1))} disabled={ndrPage >= ndrTotalPages} className="px-2 py-1 rounded bg-zinc-800 disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  );

  // Read-only prediction table - no Action/Call column: this shows what WOULD happen next, not
  // a real queue an agent works from directly.
  const renderNdrPredictedTable = () => (
    <div className="space-y-3">
      {ndrPredicted.onlineAgents.length === 0 ? (
        <p className="text-[13px] text-zinc-500 py-8 text-center">No agents online for NDR right now - nothing to predict.</p>
      ) : (
        <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 overflow-hidden">
          <div className="overflow-x-auto custom-scroll">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                <th className="py-3 px-4 text-left font-medium">#</th>
                <th className="py-3 px-4 text-left font-medium">AWB</th>
                <th className="py-3 px-4 text-left font-medium">Order ID</th>
                <th className="py-3 px-4 text-left font-medium">Latest NDR Date</th>
                <th className="py-3 px-4 text-center font-medium">Attempts</th>
                <th className="py-3 px-4 text-left font-medium">Latest NDR Reason</th>
                <th className="py-3 px-4 text-left font-medium">Predicted Agent</th>
              </tr></thead>
              <tbody className="divide-y divide-zinc-800/50">
                {ndrPredicted.rows.map((t, i) => (
                  <tr key={t.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2.5 px-4 text-zinc-500">{i + 1}</td>
                    <td className="py-2.5 px-4 font-mono text-zinc-300">{t.awb}</td>
                    <td className="py-2.5 px-4 text-zinc-300">{t.orderId}</td>
                    <td className="py-2.5 px-4 text-zinc-400">{t.latestNdrDate}</td>
                    <td className="py-2.5 px-4 text-center text-zinc-300">{t.attempts}</td>
                    <td className="py-2.5 px-4 text-zinc-400">{t.latestNdrReason}</td>
                    <td className="py-2.5 px-4 text-indigo-300 font-medium">{t.predictedAgent}</td>
                  </tr>
                ))}
                {ndrPredicted.rows.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-zinc-500">No unassigned leads for any online agent&apos;s attempt filter right now.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  const ndrTabsList = [
    { key: 'overview', label: '📊 Overview', count: ndrTotal },
    { key: 'all', label: 'Total Leads Disposed', count: ndrDisposed },
    { key: 'fresh', label: '⚡ Fresh Leads (Assigned)', count: ndrAssigned },
    ...(canAdminTab ? [{ key: 'admin', label: 'Admin Panel & Roster', count: (processAgents || []).length }] : []),
    ...(canPredictedTab ? [{ key: 'predicted', label: '🔮 Next to Assign', count: ndrPredicted.rows.length }] : []),
  ];

  // No explicit grant on this account at all (not admin, no per-process rows including 'ndr').
  const hasAccess = sessionIsAdmin || !invitedProcessKeys || invitedProcessKeys.includes(PROCESS_KEY);

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      <CallingShell
        logoLabel="NDR"
        title="NDR Calling Agent Portal"
        lastSync={ndrLastSync}
        syncing={ndrSyncing}
        syncError={ndrSyncError}
        onSync={() => syncNdr(false)}
        session={session}
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-5 py-5 space-y-5">
        {processPermsLoaded && !hasAccess && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-8 shadow-xl backdrop-blur-md">
            <div className="max-w-2xl space-y-3">
              <h2 className="text-lg font-bold text-zinc-100">No access to NDR Calling</h2>
              <p className="text-[13px] text-zinc-400 leading-relaxed">
                This account hasn&apos;t been invited to NDR Calling yet. An admin can grant it
                from Admin &rarr; Permissions by ticking NDR Calling under the Calling card.
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
              {ndrTabsList.map(t => (
                <button
                  key={t.key}
                  onClick={() => setNdrTab(t.key)}
                  className={`relative px-4 py-2 rounded-xl text-[13px] font-bold whitespace-nowrap transition-all flex items-center gap-2.5 ${
                    ndrTab === t.key
                      ? 'text-white bg-indigo-600 shadow-md shadow-indigo-950/50 border border-indigo-500/40'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 border border-transparent'
                  }`}
                >
                  {t.label}
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-md ${ndrTab === t.key ? 'bg-white/20' : 'bg-zinc-800'}`}>{t.count}</span>
                </button>
              ))}
            </nav>
            <div className="p-4">
              {ndrSyncError && (
                <div className="mb-3 text-[12px] text-rose-400">⚠ {ndrSyncError} — retrying…</div>
              )}
              {ndrTotalRows > ndrTotal && (
                <div className="mb-3 text-[12px] text-amber-400">
                  ⚠ Showing the most recent {ndrTotal.toLocaleString('en-IN')} of {ndrTotalRows.toLocaleString('en-IN')} total leads in the sheet - older rows aren&apos;t loaded (payload size cap).
                </div>
              )}
              {ndrTab === 'overview' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-4">
                      <div className="text-[11px] text-zinc-500 uppercase font-medium">Total Leads</div>
                      <div className="text-2xl font-bold text-zinc-100 mt-1">{ndrTotal.toLocaleString('en-IN')}</div>
                    </div>
                    <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-4">
                      <div className="text-[11px] text-zinc-500 uppercase font-medium">Assigned</div>
                      <div className="text-2xl font-bold text-indigo-400 mt-1">{ndrAssigned.toLocaleString('en-IN')}</div>
                    </div>
                    <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-4">
                      <div className="text-[11px] text-zinc-500 uppercase font-medium">Unassigned</div>
                      <div className="text-2xl font-bold text-amber-400 mt-1">{ndrUnassigned.toLocaleString('en-IN')}</div>
                    </div>
                    <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-4">
                      <div className="text-[11px] text-zinc-500 uppercase font-medium">Disposed</div>
                      <div className="text-2xl font-bold text-emerald-400 mt-1">{ndrDisposed.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[12px] text-zinc-500 mb-2 font-medium">Leads by Attempt Count</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {Object.entries(ndrAttemptBuckets).map(([bucket, count]) => (
                        <div key={bucket} className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-4">
                          <div className="text-[11px] text-zinc-500 uppercase font-medium">{bucket} attempt{bucket === '1' ? '' : 's'}</div>
                          <div className="text-xl font-bold text-zinc-100 mt-1">{count.toLocaleString('en-IN')}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {(ndrTab === 'all' || ndrTab === 'fresh') && renderNdrLeadsTable()}
              {ndrTab === 'predicted' && canPredictedTab && renderNdrPredictedTable()}
              {ndrTab === 'admin' && canAdminTab && (
                <div className="space-y-6">
                  {renderNdrRosterTable()}
                  <CallingHoursCard processKey={PROCESS_KEY} processLabel="NDR Calling" hours={hours} />
                  <ProcessDispositionsCard processLabel="NDR Calling" disp={disp} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ LEAD DETAILS + CALL/DISPOSITION MODAL ═══ */}
        {ndrDetailTkt && (
          <Overlay onClose={() => setNdrDetailTkt(null)}>
            <div className="w-full max-w-md bg-[#121215] border border-zinc-800/90 rounded-2xl shadow-2xl text-zinc-100">
              <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80">
                <h3 className="text-base font-bold font-mono text-zinc-100">{ndrDetailTkt.orderId || ndrDetailTkt.awb}</h3>
                <button onClick={() => setNdrDetailTkt(null)} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400"><XIcon /></button>
              </div>
              <div className="px-6 py-5 space-y-4 max-h-[68vh] overflow-y-auto text-[13px]">
                <div className="p-3.5 rounded-xl bg-zinc-900/90 border border-zinc-800/80 space-y-1">
                  <p className="text-[11px] text-zinc-500 uppercase font-medium">Agent Name</p>
                  <p className="text-zinc-100 font-bold flex items-center gap-1.5">👤 {ndrDetailTkt.assignedAgent || 'Unassigned'}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">AWB</p><p className="font-mono font-semibold text-zinc-200">{ndrDetailTkt.awb}</p></div>
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Customer</p><p className="font-semibold text-zinc-200">{ndrDetailTkt.customerName}</p></div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Partner</p><p className="font-semibold text-zinc-200">{ndrDetailTkt.partner}</p></div>
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Attempts</p><p className="font-semibold text-violet-300">{ndrDetailTkt.attempts}</p></div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Status</p><p className="font-semibold text-zinc-200">{ndrDetailTkt.status || '—'}</p></div>
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Latest NDR Date</p><p className="font-semibold text-zinc-200">{ndrDetailTkt.latestNdrDate || '—'}</p></div>
                </div>
                <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Latest NDR Reason</p><p className="text-zinc-300">{ndrDetailTkt.latestNdrReason || '—'}</p></div>
                <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Address</p><p className="text-zinc-300">{ndrDetailTkt.address}</p><p className="text-zinc-200 font-medium">{ndrDetailTkt.city}, {ndrDetailTkt.state} — {ndrDetailTkt.pincode}</p></div>

                {ndrDetailTkt.customerMobile && (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-indigo-950/30 border border-indigo-800/40">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-indigo-300">Customer Contact</p>
                      <p className="text-sm font-bold font-mono text-zinc-100 mt-0.5">{ndrDetailTkt.customerMobile}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <a
                        href={`tel:${ndrDetailTkt.customerMobile.replace(/[^0-9+]/g, '')}`}
                        className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-bold flex items-center gap-1.5 shadow-md shadow-emerald-950/40 transition-all"
                      >
                        <PhoneIcon /> Call Now
                      </a>
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard.writeText(ndrDetailTkt.customerMobile); showToast('Phone number copied!'); }}
                        className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[12px] font-medium transition-colors border border-zinc-700"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-5 pt-1">
                  {/* Card-grid picker - one numbered section per depth of the admin-configurable
                      disposition tree, as many sections as this particular branch actually goes
                      (ndrDispLevels already stops growing past a leaf). Picking a card at depth
                      i resets everything picked below it. */}
                  {ndrDispLevels.map((levelOptions, i) => (
                    <div key={i}>
                      <p className="text-[12px] font-bold uppercase tracking-wider text-zinc-400 mb-2.5">
                        {i + 1}. {i === 0 ? 'Was the call connected with the customer?' : 'Select reason'}
                      </p>
                      <div className={`grid gap-2 ${i === 0 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 max-h-52 overflow-y-auto custom-scroll pr-1'}`}>
                        {levelOptions.map(d => {
                          const isSel = ndrDispPath[i] === d.label;
                          const tone = d.label === 'Connected' ? NDR_DISP_TONE_EMERALD
                            : d.label === 'Not Connected' ? NDR_DISP_TONE_ROSE
                            : NDR_DISP_TONE_INDIGO;
                          return (
                            <button
                              key={d.id}
                              type="button"
                              onClick={() => {
                                const newPath = ndrDispPath.slice(0, i);
                                newPath[i] = d.label;
                                setNdrDispPath(newPath);
                                setNdrDispSelection(d.children && d.children.length ? '' : newPath.join(' - '));
                              }}
                              className={`p-3 rounded-xl border text-left transition-all flex items-start gap-3 ${isSel ? tone.card : 'bg-zinc-900/80 border-zinc-800 text-zinc-300 hover:border-zinc-700'}`}
                            >
                              <span className="text-base shrink-0">{d.label === 'Connected' ? '📞' : d.label === 'Not Connected' ? '📵' : '🏷️'}</span>
                              <div className="min-w-0 flex-1">
                                <p className="text-[13px] font-bold truncate flex items-center justify-between gap-2">
                                  {d.label}
                                  {isSel && <CheckIcon className={`${tone.icon} shrink-0`} />}
                                </p>
                                {d.description && <p className="text-[11px] text-zinc-500 mt-0.5">{d.description}</p>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <div>
                    <p className="text-[11px] text-zinc-500 uppercase font-medium mb-1.5">Agent Remarks</p>
                    <textarea
                      value={ndrDispRemarks}
                      onChange={e => setNdrDispRemarks(e.target.value)}
                      placeholder="Remarks (optional)"
                      rows={3}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 resize-none"
                    />
                  </div>
                  {ndrDetailTkt.callingDate && (
                    <p className="text-[11px] text-zinc-500">Last called {ndrDetailTkt.callingDate} - Connected: {ndrDetailTkt.connected || '—'} - Outcome: {ndrDetailTkt.outcome || '—'}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-zinc-800/80">
                <button onClick={() => setNdrDetailTkt(null)} className="px-4 py-2 rounded-xl text-[13px] text-zinc-400">Close</button>
                <button
                  onClick={saveNdrDisposition}
                  disabled={!ndrDispSelection || ndrDispSaving}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-semibold disabled:opacity-50"
                >
                  {ndrDispSaving ? 'Saving…' : 'Save Disposition'}
                </button>
              </div>
            </div>
          </Overlay>
        )}
      </main>
    </div>
  );
}
