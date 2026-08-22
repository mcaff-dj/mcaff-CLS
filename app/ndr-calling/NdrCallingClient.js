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
  CalendarIcon, DownloadIcon,
} from '../_calling/ui';
import { useCallingSession, STATUS_OPTIONS, ROSTER_STATUS_OPTIONS } from '../_calling/useCallingSession';
import { useBusinessHours, CallingHoursCard, useProcessDispositions, ProcessDispositionsCard } from '../_calling/CallingAdminPanel';
import { CallingShell } from '../_calling/CallingShell';
import {
  safeStorage, parseDate, isDateInScope, isLeadDateInScope, scopeToDateBounds, normalizeOrderKey,
  istMinutesSinceMidnightClient, istDayKeyClient, formatTimeOfDay, formatBreakMinutes, formatFrt, formatPct,
} from '../_calling/util';

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

// Brand isn't its own sheet column - it's derived from Order ID, same rule
// scripts/assign_ndr_leads.py's brand_of uses: an order ID starting with "HYP" is Hyphen,
// everything else (including a blank/unreadable one) is mCaffeine.
const brandOf = (orderId) => (String(orderId || '').toUpperCase().startsWith('HYP') ? 'Hyphen' : 'mCaffeine');

// The four HARD filters scripts/assign_ndr_leads.py applies to decide whether a given lead may
// reach a given agent, ported field-for-field from that script (attempt_bucket, _covers,
// reason_covers, payment_mode_covers, brand_covers). At module scope rather than inside a
// single useMemo's closure because TWO things need them now: the Next-to-Assign prediction
// (ndrPredicted) and the roster's per-agent match count (ndrFilterMatchCounts). Hoisting
// beats duplicating - a second hand-written copy is exactly how a filter rule silently drifts
// from what the cron actually does.
//
// `agent` here is the normalized shape ndrAgentFilters builds, NOT a raw processAgents row.
const ndrBucketOf = (raw) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 3 ? String(n) : 'More than 3';
};
const ndrAttemptCovers = (agent, bucket) =>
  !agent.filter.length || bucket === null || agent.filter.includes(bucket);
// Case-insensitive substring match against the lead's own latestNdrReason - an agent with no
// reasonFilter values is unrestricted (fails open); an agent WITH filter values excludes any
// reason that doesn't contain one of them, including a blank/unreadable reason (this one does
// not fail open the way an unparseable attempt bucket does above).
const ndrReasonCovers = (agent, latestNdrReason) => {
  if (!agent.reasonFilter.length) return true;
  const reason = (latestNdrReason || '').toLowerCase();
  return agent.reasonFilter.some(r => reason.includes(r.toLowerCase()));
};
// Exact, case-insensitive match - a fixed value set ('Prepaid'/'COD'), unlike reasonCovers'
// free-text substrings above.
const ndrPaymentModeCovers = (agent, paymentMode) =>
  !agent.paymentModeFilter
  || String(paymentMode || '').trim().toLowerCase() === agent.paymentModeFilter.toLowerCase();
// brand is already normalized to exactly 'Hyphen'/'mCaffeine' by brandOf, same as brandFilter
// itself (the roster CustomSelect only ever writes those two strings or ''), so a plain
// equality check is enough - no case-folding needed.
const ndrBrandCovers = (agent, brand) => !agent.brandFilter || brand === agent.brandFilter;

// All four at once: can this lead EVER reach this agent? Quota and round-robin position are
// deliberately not consulted - this answers "is this agent's filter set satisfiable at all",
// which is what a 0 here means and why it is worth showing in the roster.
const ndrFiltersCoverLead = (agent, lead) =>
  ndrAttemptCovers(agent, ndrBucketOf(lead.attempts))
  && ndrReasonCovers(agent, lead.latestNdrReason)
  && ndrPaymentModeCovers(agent, lead.paymentMode)
  && ndrBrandCovers(agent, lead.brand);

// processAgents row -> the normalized filter shape the covers helpers above expect. '' / absent
// means unrestricted throughout, matching assign_ndr_leads.py's "absent means no restriction".
const ndrAgentFilters = (a) => ({
  email: a.email,
  quota: a.maxQuota != null ? a.maxQuota : 20, // DEFAULT_QUOTA in assign_ndr_leads.py
  filter: (a.attemptCountFilter || '').split(',').map(s => s.trim()).filter(Boolean),
  reasonFilter: (a.ndrReasonFilter || '').split(',').map(s => s.trim()).filter(Boolean),
  paymentModeFilter: a.ndrPaymentModeFilter || '',
  brandFilter: a.ndrBrandFilter || '',
});

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
    address: v(6), pincode: v(7), city: v(8), state: v(9), paymentMode: v(11), status: v(12), attempts: v(14),
    latestNdrDate: v(15), latestNdrReason: v(16), callingDate: v(17), assignedAgent: v(18),
    connected: v(19), outcome: v(20), deliveryAgentCall: v(21), remarks: v(27),
    brand: brandOf(v(0)),
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
    // off-cycle assignment run with - safe to omit (the hook treats a missing getter as "no
    // value", not an error). getDateBounds IS wired (see ndrDateScope below, declared further
    // down this function) so Logged In At/Total Break Time in the Agent Performance Summary
    // table follow the same date-scope filter as everything else in it - same
    // temporal-dead-zone-safe getter-closure pattern RTO's own call uses.
    getPendingBox: undefined,
    getDateBounds: () => scopeToDateBounds(ndrDateScope, ndrCustomDateFrom, ndrCustomDateTo),
  });
  const {
    googleUser, userRole, sessionIsAdmin, invitedProcessKeys, processPermsLoaded,
    processAgents, isProcessAdmin, saveProcessAgent, savingAgentEmail,
    agentStatus, serverPresence, showToast,
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

  // All Leads/Fresh Leads tabs' own agent filter (renderNdrLeadsTable, shared by both tabs) -
  // separate from ndrDateScope below, which those same tabs' stat cards also reuse (same
  // page-wide date filter as the Overview tab, not a tab-local one - matches RTO's own
  // agentPerf/pend, which read the page-wide dateScope too).
  const [ndrLeadAgentFilter, setNdrLeadAgentFilter] = useState('ALL');

  // Executive Overview date-scope filter - same options/semantics as RTO's own (see
  // app/rto-crm/RtoCrmClient.js's dateOptions), namespaced localStorage keys since this is a
  // separate page, not a shared one. Drives the KPI tiles, the Agent Performance Summary table,
  // and (via getDateBounds above) Logged In At/Total Break Time.
  const [ndrDateScope, setNdrDateScope] = useState(() => safeStorage.getItem('ndr_date_scope') || 'ALL_TIME');
  const [ndrCustomDateFrom, setNdrCustomDateFrom] = useState(() => safeStorage.getItem('ndr_custom_date_from') || '');
  const [ndrCustomDateTo, setNdrCustomDateTo] = useState(() => safeStorage.getItem('ndr_custom_date_to') || '');
  const [ndrHeatmapMetric, setNdrHeatmapMetric] = useState(() => safeStorage.getItem('ndr_heatmap_metric') || 'dialled');
  const [ndrHeatmapIntervalMinutes, setNdrHeatmapIntervalMinutes] = useState(() => Number(safeStorage.getItem('ndr_heatmap_interval')) || 30);

  // Every live NDR lead's real {assignedAt, disposedAt} (see getAllNdrLeadDates in db.js), keyed
  // by AWB - NDR's own equivalent of RTO's leadDates, needed so the Agent Performance Summary
  // table below can scope its Assigned-flavored columns by real assignment date and its
  // Disposed/Connected-flavored columns by real disposal date, same two-universe design as
  // RTO's computeTableAgentMetrics (a lead assigned yesterday and disposed today counts toward
  // today's Disposed number even though it doesn't count toward today's Assigned one).
  const [ndrLeadDates, setNdrLeadDates] = useState({});
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/auth/leadDates?process=ndr').then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.leadDates) setNdrLeadDates(d.leadDates); })
      .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

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
    const t = setInterval(() => {
      if (!document.hidden) syncNdr(true);
    }, 60000);
    return () => clearInterval(t);
  }, [syncNdr]);
  // Catches up a long-backgrounded tab immediately on return, instead of waiting up to a full
  // 60s tick for the next poll to happen to fire.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) syncNdr(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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
      // MySQL writes go first: neither depends on the Sheets round trip below, so making the
      // agent's disposal wait on Sheets before it even reaches the DB is pure added latency.
      if (claimNow) await recordNdrLeadAssignment({ action: 'claim', awbNumber: ndrDetailTkt.awb, email: googleUser.email });
      await recordNdrLeadAssignment({ action: 'dispose', awbNumber: ndrDetailTkt.awb, disposition: ndrDispSelection, agentRemarks: ndrDispRemarks });
      await writeNdrCells(ranges);
      setNdrTickets(prev => prev.map(x => x.id === ndrDetailTkt.id
        ? { ...x, callingDate, connected: connectedValue, outcome: outcomeValue, remarks: remarksValue,
            ...(partnerCallValue ? { deliveryAgentCall: partnerCallValue } : {}),
            ...(claimNow ? { assignedAgent: googleUser.email } : {}) }
        : x));
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
  // Assigned but not yet disposed - what the 'fresh' tab's own filter actually shows
  // (t.assignedAgent && !t.connected, see ndrRowsForTab below). ndrAssigned counts every lead
  // ever assigned, disposed or not, so using it for the Fresh Leads tab's badge overstated what
  // that tab actually contains once most assigned leads had already been worked.
  const ndrFreshCount = useMemo(() => ndrScopedTickets.filter(t => t.assignedAgent && !t.connected).length, [ndrScopedTickets]);
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
      .map(ndrAgentFilters);
    if (!onlineAgents.length) return { rows: [], onlineAgents: [] };

    // "DD-MM-YYYY" -> a sortable number, undated leads sort last (same convention as
    // scripts/assign_ndr_leads.py's own parse_latest_ndr_date).
    const parseLatestNdrDate = (raw) => {
      const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec((raw || '').trim());
      return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : Infinity;
    };

    const pool = ndrTickets
      .filter(t => !t.assignedAgent && !t.connected)
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
        if (ndrFiltersCoverLead(remaining[cand], t)) { chosen = cand; break; }
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

  // How many of the currently-unassigned leads each roster agent's HARD filters could ever
  // reach - {poolSize, byEmail: Map<email, count>}. Surfaced in the Team Roster table beside
  // the filter controls themselves, because a combination that matches NOTHING is otherwise
  // completely silent: the agent sees an empty queue, the robot correctly assigns them nothing,
  // and no error appears anywhere. Ashar sat idle ~20h on 2026-08-20/21 with
  // Payment Mode=COD + Brand=mCaffeine, a pair that matched 0 of 905 waiting leads because
  // every COD lead was Hyphen and every mCaffeine lead was Prepaid.
  //
  // Deliberately NOT quota- or round-robin-aware, unlike ndrPredicted above: this answers
  // "is this filter set satisfiable at all", which stays true whether or not the agent happens
  // to be at quota, and is the only question a 0 needs to answer. Computed for EVERY roster
  // agent, not just Online ones, so a filter can be fixed while On Break/Offline.
  const ndrFilterMatchCounts = useMemo(() => {
    const pool = ndrTickets.filter(t => !t.assignedAgent && !t.connected);
    const byEmail = new Map();
    for (const a of (processAgents || [])) {
      const filters = ndrAgentFilters(a);
      byEmail.set(a.email, pool.reduce((n, t) => n + (ndrFiltersCoverLead(filters, t) ? 1 : 0), 0));
    }
    return { poolSize: pool.length, byEmail };
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
  // Free-text hard filter, save-on-blur (unlike the Attempts MultiSelectDropdown, there's no
  // fixed option list to pick from - courier NDR-reason strings aren't a small enumerable set).
  // Local draft state so typing doesn't fire a save per keystroke; commits only on blur, and
  // only if the value actually changed.
  const NdrReasonFilterInput = ({ value, onSave }) => {
    const [draft, setDraft] = useState(value || '');
    useEffect(() => { setDraft(value || ''); }, [value]);
    return (
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft !== (value || '')) onSave(draft); }}
        placeholder="e.g. Customer not available, Address issue"
        className="w-56 h-8 px-3 py-1 bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 rounded-lg text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
      />
    );
  };

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
                <th className="py-3 px-4 text-left font-medium" title="Hard filter: restricts this agent to leads whose Latest NDR Reason contains any of these (case-insensitive), comma-separated. No text = unrestricted.">Latest NDR Reason</th>
                <th className="py-3 px-4 text-left font-medium" title="Hard filter: restricts this agent to leads of the selected payment mode only. No restriction = unrestricted.">Payment Mode</th>
                <th className="py-3 px-4 text-left font-medium" title="Hard filter: restricts this agent to leads of the selected brand only (derived from Order ID). No restriction = unrestricted.">Brand</th>
                <th className="py-3 px-4 text-left font-medium" title="How many of the currently-unassigned leads these four filters could ever reach, ignoring quota. 0 means this combination matches nothing waiting right now - the agent will receive no leads at all until a filter is relaxed.">Matches</th>
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
                    <td className="py-3 px-4">
                      <NdrReasonFilterInput
                        value={a.ndrReasonFilter}
                        onSave={(next) => saveProcessAgent(a.email, { ndrReasonFilter: next })}
                      />
                    </td>
                    <td className="py-3 px-4">
                      <CustomSelect
                        value={a.ndrPaymentModeFilter || ''}
                        onChange={(val) => saveProcessAgent(a.email, { ndrPaymentModeFilter: val })}
                        options={[
                          { value: '', label: 'No restriction' },
                          { value: 'Prepaid', label: 'Prepaid only' },
                          { value: 'COD', label: 'COD only' },
                        ]}
                      />
                    </td>
                    <td className="py-3 px-4">
                      <CustomSelect
                        value={a.ndrBrandFilter || ''}
                        onChange={(val) => saveProcessAgent(a.email, { ndrBrandFilter: val })}
                        options={[
                          { value: '', label: 'No restriction' },
                          { value: 'Hyphen', label: 'Hyphen only' },
                          { value: 'mCaffeine', label: 'mCaffeine only' },
                        ]}
                      />
                    </td>
                    <td className="py-3 px-4">
                      {(() => {
                        const n = ndrFilterMatchCounts.byEmail.get(a.email);
                        const total = ndrFilterMatchCounts.poolSize;
                        // Nothing is waiting for anyone - a 0 here says nothing about this
                        // agent's filters, so it must not be dressed up as their problem.
                        if (total === 0) return <span className="text-[11px] text-zinc-500" title="No unassigned leads in the sheet at all right now">no leads waiting</span>;
                        if (n === undefined) return <span className="text-zinc-500">—</span>;
                        if (n === 0) {
                          return (
                            <span
                              className="inline-block px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] font-semibold"
                              title={`These filters match 0 of the ${total} unassigned leads waiting - this agent will receive nothing until one is relaxed.`}
                            >
                              0 of {total} · no match
                            </span>
                          );
                        }
                        return (
                          <span className="text-[12px] text-zinc-300" title={`${n} of the ${total} unassigned leads waiting can reach this agent (quota not considered).`}>
                            {n} <span className="text-zinc-500">of {total}</span>
                          </span>
                        );
                      })()}
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
                  <tr><td colSpan={9} className="py-8 text-center text-zinc-500">No one invited to NDR Calling yet - grant access from Admin → Permissions.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  // Connected/Remarks are always blank on the Fresh Leads tab (assigned but not yet disposed
  // - see saveNdrDisposition, the only place either column gets written), so hidden there for
  // every role, not just plain agents.
  const ndrShowConnectedRemarks = !ndrAgentView && ndrTab !== 'fresh';
  const ndrLeadsTableColCount = 10 + (ndrAgentView ? 0 : 2) + (ndrShowConnectedRemarks ? 2 : 0);

  const renderNdrLeadsTable = () => (
    <div className="space-y-3">
      {/* Stats header cards, date-scoped/agent-filtered same as the Overview tab above */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-500 mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Connected Calls
          </p>
          <p className="text-2xl font-extrabold text-emerald-500 tabular-nums tracking-tight">{ndrLeadConnectedCalls.toLocaleString('en-IN')}</p>
          <p className="text-[11px] text-zinc-500 font-medium mt-1">{ndrLeadConnectRate}% connect rate</p>
        </div>
        <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-500 mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500"></span> Reorders Converted
          </p>
          <p className="text-2xl font-extrabold text-indigo-500 tabular-nums tracking-tight">{ndrLeadReordersConverted.toLocaleString('en-IN')}</p>
          <p className="text-[11px] text-zinc-500 font-medium mt-1">{ndrLeadReorderRate}% conversion rate</p>
        </div>
        <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-rose-500 mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500"></span> Mark RTO
          </p>
          <p className="text-2xl font-extrabold text-rose-500 tabular-nums tracking-tight">{ndrLeadMarkedRto.toLocaleString('en-IN')}</p>
          <p className="text-[11px] text-zinc-500 font-medium mt-1">Recommended for RTO</p>
        </div>
        <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400"></span> Active Pending Box
          </p>
          <p className="text-2xl font-extrabold text-zinc-100 tabular-nums tracking-tight">{ndrLeadPending.toLocaleString('en-IN')}</p>
          <p className="text-[11px] text-zinc-500 font-medium mt-1">{userRole === 'Agent' && !isProcessAdmin ? 'My Active Queue' : (ndrLeadAgentFilter !== 'ALL' ? ndrLeadAgentFilter.split('@')[0] : 'All agents')}</p>
        </div>
        <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400"></span> Fresh Unassigned
          </p>
          <p className="text-2xl font-extrabold text-zinc-100 tabular-nums tracking-tight">{ndrLeadFreshUnassigned.toLocaleString('en-IN')}</p>
          <p className="text-[11px] text-zinc-500 font-medium mt-1">Ready to claim</p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={ndrSearch}
            onChange={e => setNdrSearch(e.target.value)}
            placeholder="Search AWB, order ID, mobile…"
            className="w-64 px-3 py-1.5 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
          />
          {userRole !== 'Agent' && (
            <CustomSelect
              value={ndrLeadAgentFilter}
              onChange={setNdrLeadAgentFilter}
              options={ndrLeadAgentOptions}
              placeholder="Agent Filter"
            />
          )}
          <CustomSelect
            value={ndrDateScope}
            onChange={(val) => { setNdrDateScope(val); safeStorage.setItem('ndr_date_scope', val); }}
            options={ndrDateOptions}
            icon={CalendarIcon}
            placeholder="Date Scope"
          />
          {ndrDateScope === 'CUSTOM' && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={ndrCustomDateFrom}
                onChange={(e) => { setNdrCustomDateFrom(e.target.value); safeStorage.setItem('ndr_custom_date_from', e.target.value); }}
                className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
              <span className="text-zinc-500 text-[12px]">to</span>
              <input
                type="date"
                value={ndrCustomDateTo}
                onChange={(e) => { setNdrCustomDateTo(e.target.value); safeStorage.setItem('ndr_custom_date_to', e.target.value); }}
                className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>
          )}
        </div>
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
              {!ndrAgentView && <th className="py-3 px-4 text-left font-medium">Calling Date</th>}
              {!ndrAgentView && <th className="py-3 px-4 text-left font-medium">Agent Name</th>}
              {/* Fresh Leads = assigned but not yet disposed, so Connected/Remarks are always
                  blank there regardless of role - hidden on that tab, not just for agents. */}
              {ndrShowConnectedRemarks && <th className="py-3 px-4 text-left font-medium">Connected</th>}
              {ndrShowConnectedRemarks && <th className="py-3 px-4 text-left font-medium">Remarks</th>}
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
                  {!ndrAgentView && <td className="py-2.5 px-4 text-zinc-400">{t.callingDate}</td>}
                  {!ndrAgentView && <td className="py-2.5 px-4 text-zinc-300">{t.assignedAgent || <span className="text-zinc-600">Unassigned</span>}</td>}
                  {ndrShowConnectedRemarks && <td className="py-2.5 px-4 text-zinc-400">{t.connected}</td>}
                  {ndrShowConnectedRemarks && <td className="py-2.5 px-4 text-zinc-400">{t.remarks}</td>}
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
                <tr><td colSpan={ndrLeadsTableColCount} className="py-8 text-center text-zinc-500">No leads found.</td></tr>
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

  // ═══ EXECUTIVE OVERVIEW & AGENTS PERFORMANCE ═══
  // Adapted port of RTO's own Overview tab (app/rto-crm/RtoCrmClient.js) - same two designs:
  // (1) KPI tiles scope by the sheet's own Calling Date (ndrKpiInScope), (2) the Agent
  // Performance Summary table scopes Assigned-flavored columns by real assigned_at and
  // Disposed/Connected-flavored columns by real disposed_at (ndrLeadDates, from
  // ndr_lead_assignments) - two independent universes of the same agent's tickets, not one
  // funnel, same reasoning as RTO's computeTableAgentMetrics doc comment. NDR has no payment
  // mode/refund data at all, so every Prepaid/COD/Refund column RTO has is replaced here with
  // NDR's own equivalents: Reorders Converted (outcome 'New order Placed'), Mark RTO Count
  // (outcome 'Mark RTO'), and High-Attempt Assigned (3+ delivery attempts).
  const ndrIsAssignedTo = (t, email) => {
    const e = (email || '').toLowerCase();
    const a = (t.assignedAgent || '').toLowerCase();
    return !!a && (a.includes(e) || e.includes(a));
  };
  const ndrMyEmailLower = (googleUser?.email || '').toLowerCase();
  const ndrIsMyAgentRow = (ag) => ndrMyEmailLower && ag.email.toLowerCase() === ndrMyEmailLower;
  const ndrOverviewRoster = (userRole === 'Agent' && !isProcessAdmin)
    ? (processAgents || []).filter(ndrIsMyAgentRow) : (processAgents || []);

  // KPI tiles - scoped by Calling Date/ndrDateScope, same single-scope shape as RTO's
  // computeAgentMetrics (deliberately separate from the table below's two-universe scoping).
  const ndrKpiInScope = (t) => isDateInScope(parseDate(t.callingDate), ndrDateScope, ndrCustomDateFrom, ndrCustomDateTo);
  const ndrAgentMetrics = ndrOverviewRoster.map(ag => {
    const assigned = ndrTickets.filter(t => ndrIsAssignedTo(t, ag.email) && ndrKpiInScope(t));
    const disposed = assigned.filter(t => t.connected);
    const connected = disposed.filter(t => t.connected === 'Yes');
    return { ...ag, assigned: assigned.length, disposed: disposed.length, connected: connected.length };
  });
  const ndrKpiTotalAssigned = ndrAgentMetrics.reduce((s, a) => s + a.assigned, 0);
  const ndrKpiTotalDisposed = ndrAgentMetrics.reduce((s, a) => s + a.disposed, 0);
  const ndrKpiTotalConnected = ndrAgentMetrics.reduce((s, a) => s + a.connected, 0);
  const ndrKpiTotalPending = ndrKpiTotalAssigned - ndrKpiTotalDisposed;
  const ndrKpiAvgConnectRate = ndrKpiTotalDisposed > 0 ? Math.round((ndrKpiTotalConnected / ndrKpiTotalDisposed) * 100) : 0;
  const ndrKpiTotalReordersConverted = ndrTickets.filter(t =>
    ndrOverviewRoster.some(ag => ndrIsAssignedTo(t, ag.email)) && t.outcome === 'New order Placed' && ndrKpiInScope(t)
  ).length;
  // Unscoped by role (matches RTO's own freshUnassignedInScope) - an unassigned lead isn't
  // "assigned to" any agent, so per-agent roster scoping doesn't apply to it either way.
  const ndrKpiFreshUnassigned = ndrTickets.filter(t => !t.assignedAgent && ndrKpiInScope(t)).length;
  const ndrOnlineCount = (processAgents || []).filter(a => a.status === 'Online').length;

  // Agent Performance Summary table - real-date two-universe scoping via ndrLeadDates.
  const ndrAssignedDateInScope = (t) => isLeadDateInScope(
    ndrLeadDates[normalizeOrderKey(t.awb)]?.assignedAt, ndrDateScope, ndrCustomDateFrom, ndrCustomDateTo
  );
  const ndrDisposedDateInScope = (t) => isLeadDateInScope(
    ndrLeadDates[normalizeOrderKey(t.awb)]?.disposedAt, ndrDateScope, ndrCustomDateFrom, ndrCustomDateTo
  );
  const computeNdrTableAgentMetrics = (ag) => {
    const assignedByDate = ndrTickets.filter(t => ndrIsAssignedTo(t, ag.email) && ndrAssignedDateInScope(t));
    const highAttempt = assignedByDate.filter(t => { const n = parseInt(t.attempts, 10); return Number.isFinite(n) && n > 3; });

    const disposedByDate = ndrTickets.filter(t => ndrIsAssignedTo(t, ag.email) && t.connected && ndrDisposedDateInScope(t));
    const connected = disposedByDate.filter(t => t.connected === 'Yes');
    const reordersConverted = disposedByDate.filter(t => t.outcome === 'New order Placed');
    const markedRto = disposedByDate.filter(t => t.outcome === 'Mark RTO');

    // First Called At / FRT - per active IST day, same averaging as RTO's own
    // computeTableAgentMetrics: earliest disposal each day, then averaged across active days.
    const firstCallMinutesByDay = new Map();
    const frtList = [];
    for (const t of disposedByDate) {
      const dates = ndrLeadDates[normalizeOrderKey(t.awb)] || {};
      if (!dates.disposedAt) continue;
      const disposedAt = new Date(dates.disposedAt);
      const dayKey = istDayKeyClient(disposedAt);
      const mins = istMinutesSinceMidnightClient(disposedAt);
      if (!firstCallMinutesByDay.has(dayKey) || mins < firstCallMinutesByDay.get(dayKey)) firstCallMinutesByDay.set(dayKey, mins);
      if (dates.assignedAt) {
        const frt = (disposedAt.getTime() - new Date(dates.assignedAt).getTime()) / 60000;
        if (frt >= 0) frtList.push(frt);
      }
    }
    const firstCalledAtMinutes = firstCallMinutesByDay.size
      ? Math.round([...firstCallMinutesByDay.values()].reduce((s, m) => s + m, 0) / firstCallMinutesByDay.size) : null;
    const frtMinutes = frtList.length ? Math.round(frtList.reduce((s, m) => s + m, 0) / frtList.length) : null;

    return {
      ...ag,
      assigned: assignedByDate.length, disposed: disposedByDate.length, connected: connected.length,
      reordersConverted: reordersConverted.length, markedRto: markedRto.length, highAttempt: highAttempt.length,
      firstCalledAtMinutes, frtMinutes,
    };
  };
  const ndrTableAgentMetrics = ndrOverviewRoster.map(computeNdrTableAgentMetrics);
  const ndrSummaryRows = ndrTableAgentMetrics.filter(am => am.assigned > 0);
  const ndrSummaryTotals = ndrSummaryRows.reduce((acc, am) => {
    acc.assigned += am.assigned; acc.disposed += am.disposed; acc.connected += am.connected;
    acc.reordersConverted += am.reordersConverted; acc.markedRto += am.markedRto; acc.highAttempt += am.highAttempt;
    return acc;
  }, { assigned: 0, disposed: 0, connected: 0, reordersConverted: 0, markedRto: 0, highAttempt: 0 });
  const ndrSummaryLoggedInList = ndrSummaryRows.map(am => serverPresence[am.email.toLowerCase()]?.loggedInMinutes).filter(m => m != null);
  const ndrSummaryBreakList = ndrSummaryRows.map(am => serverPresence[am.email.toLowerCase()]?.breakMinutes).filter(m => m != null);
  const ndrSummaryBusyList = ndrSummaryRows.map(am => serverPresence[am.email.toLowerCase()]?.busyMinutes).filter(m => m != null);
  const ndrSummaryAvgLoggedIn = ndrSummaryLoggedInList.length ? Math.round(ndrSummaryLoggedInList.reduce((s, m) => s + m, 0) / ndrSummaryLoggedInList.length) : null;
  const ndrSummaryAvgBreak = ndrSummaryBreakList.length ? Math.round(ndrSummaryBreakList.reduce((s, m) => s + m, 0) / ndrSummaryBreakList.length) : 0;
  const ndrSummaryAvgBusy = ndrSummaryBusyList.length ? Math.round(ndrSummaryBusyList.reduce((s, m) => s + m, 0) / ndrSummaryBusyList.length) : 0;
  const ndrSummaryFrtList = ndrSummaryRows.map(am => am.frtMinutes).filter(m => m != null);
  const ndrSummaryAvgFrt = ndrSummaryFrtList.length ? Math.round(ndrSummaryFrtList.reduce((s, m) => s + m, 0) / ndrSummaryFrtList.length) : null;

  // One row per lead behind the summary table (audit/reconcile), union of assigned-in-scope OR
  // (worked AND disposed-in-scope) - same as RTO's rawLeadDetailsList.
  const ndrRawLeadDetailsList = ndrOverviewRoster.flatMap(ag => ndrTickets
    .filter(t => ndrIsAssignedTo(t, ag.email) && (ndrAssignedDateInScope(t) || (t.connected && ndrDisposedDateInScope(t))))
    .map(t => {
      const dates = ndrLeadDates[normalizeOrderKey(t.awb)] || {};
      const frt = (dates.assignedAt && dates.disposedAt)
        ? (new Date(dates.disposedAt).getTime() - new Date(dates.assignedAt).getTime()) / 60000 : null;
      return {
        awb: t.awb, orderId: t.orderId, agentName: ag.name,
        assignedAt: dates.assignedAt || '', disposedAt: dates.disposedAt || '',
        frtMinutes: (frt !== null && frt >= 0) ? Math.round(frt) : null,
        connected: t.connected || '', outcome: t.outcome || '',
      };
    })
  ).sort((a, b) => a.agentName.localeCompare(b.agentName) || a.awb.localeCompare(b.awb));

  function downloadNdrAgentSummaryCsv() {
    const escapeCsv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = [
      'Agent Name', 'Total Leads Assigned', 'Total Disposed', 'First Called At', 'FRT',
      'Total Connected', 'Connected %', 'Reorders Converted', 'Reorders Converted %',
      'Mark RTO Count', 'Mark RTO %', 'High-Attempt Assigned', 'High-Attempt %',
      'Logged In At', 'Total Break Time', 'Total Busy Time',
    ];
    const rowFor = (am) => {
      const presence = serverPresence[am.email.toLowerCase()];
      return [
        am.name, am.assigned, am.disposed, formatTimeOfDay(am.firstCalledAtMinutes), formatFrt(am.frtMinutes),
        am.connected, formatPct(am.connected, am.disposed),
        am.reordersConverted, formatPct(am.reordersConverted, am.disposed),
        am.markedRto, formatPct(am.markedRto, am.disposed),
        am.highAttempt, formatPct(am.highAttempt, am.assigned),
        formatTimeOfDay(presence?.loggedInMinutes), formatBreakMinutes(presence?.breakMinutes), formatBreakMinutes(presence?.busyMinutes),
      ];
    };
    const lines = [header.map(escapeCsv).join(',')];
    ndrSummaryRows.forEach(am => lines.push(rowFor(am).map(escapeCsv).join(',')));
    if (ndrSummaryRows.length > 0) {
      lines.push([
        'Team Total', ndrSummaryTotals.assigned, ndrSummaryTotals.disposed, '—', formatFrt(ndrSummaryAvgFrt),
        ndrSummaryTotals.connected, formatPct(ndrSummaryTotals.connected, ndrSummaryTotals.disposed),
        ndrSummaryTotals.reordersConverted, formatPct(ndrSummaryTotals.reordersConverted, ndrSummaryTotals.disposed),
        ndrSummaryTotals.markedRto, formatPct(ndrSummaryTotals.markedRto, ndrSummaryTotals.disposed),
        ndrSummaryTotals.highAttempt, formatPct(ndrSummaryTotals.highAttempt, ndrSummaryTotals.assigned),
        formatTimeOfDay(ndrSummaryAvgLoggedIn), formatBreakMinutes(ndrSummaryAvgBreak), formatBreakMinutes(ndrSummaryAvgBusy),
      ].map(escapeCsv).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ndr-agent-performance-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function downloadNdrRawLeadDetailsCsv() {
    const escapeCsv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const formatCsvDate = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '';
    const lines = [
      ['AWB', 'Order ID', 'Agent Name', 'Assigned Date', 'Disposed Date', 'FRT', 'Connected', 'Outcome'].join(','),
      ...ndrRawLeadDetailsList.map(r => [
        r.awb, r.orderId, r.agentName, formatCsvDate(r.assignedAt), formatCsvDate(r.disposedAt),
        formatFrt(r.frtMinutes), r.connected, r.outcome,
      ].map(escapeCsv).join(',')),
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ndr-agent-performance-raw-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  const ndrDateOptions = [
    { value: 'ALL_TIME', label: 'All time' }, { value: 'TODAY', label: 'Today' },
    { value: 'YESTERDAY', label: 'Yesterday' }, { value: '7_DAYS', label: 'Last 7 days' },
    { value: '30_DAYS', label: 'Last 30 days' }, { value: 'CUSTOM', label: 'Custom range' },
  ];
  const ndrHeatmapIntervalOptions = [{ value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '1 hour' }];
  const ndrHeatmapMetricOptions = [
    { value: 'dialled', label: 'Total Dialled' }, { value: 'connected', label: 'Total Connected' }, { value: 'converted', label: 'Total Converted' },
  ];

  // Time-of-Day Distribution - same date range as the table above, bucketed by disposal time of
  // day; local metric/interval dropdowns only change bucketing, never which leads count.
  const ndrHeatmapAgentData = ndrOverviewRoster.map(ag => {
    const disposedByDate = ndrTickets.filter(t => ndrIsAssignedTo(t, ag.email) && t.connected && ndrDisposedDateInScope(t));
    const metricTickets = ndrHeatmapMetric === 'connected' ? disposedByDate.filter(t => t.connected === 'Yes')
      : ndrHeatmapMetric === 'converted' ? disposedByDate.filter(t => t.outcome === 'New order Placed')
      : disposedByDate;
    const bucketCounts = new Map();
    for (const t of metricTickets) {
      const iso = ndrLeadDates[normalizeOrderKey(t.awb)]?.disposedAt;
      if (!iso) continue;
      const idx = Math.floor(istMinutesSinceMidnightClient(new Date(iso)) / ndrHeatmapIntervalMinutes);
      bucketCounts.set(idx, (bucketCounts.get(idx) || 0) + 1);
    }
    return { ...ag, bucketCounts };
  });
  const ndrVisibleHeatmapAgentData = ndrHeatmapAgentData.filter(a => a.bucketCounts.size > 0);
  const ndrAllHeatmapBucketIndexes = ndrVisibleHeatmapAgentData.flatMap(a => [...a.bucketCounts.keys()]);
  const ndrHeatmapBucketIndexes = ndrAllHeatmapBucketIndexes.length
    ? (() => {
        const lo = Math.min(...ndrAllHeatmapBucketIndexes), hi = Math.max(...ndrAllHeatmapBucketIndexes);
        return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      })()
    : [];
  const ndrAllHeatmapValues = ndrVisibleHeatmapAgentData.flatMap(a => ndrHeatmapBucketIndexes.map(idx => a.bucketCounts.get(idx) || 0));
  const ndrHeatmapMin = ndrAllHeatmapValues.length ? Math.min(...ndrAllHeatmapValues) : 0;
  const ndrHeatmapMax = ndrAllHeatmapValues.length ? Math.max(...ndrAllHeatmapValues) : 0;
  function ndrHeatmapCellStyle(value) {
    if (ndrHeatmapMax <= ndrHeatmapMin) return undefined;
    const t = (ndrHeatmapMax - value) / (ndrHeatmapMax - ndrHeatmapMin);
    return { backgroundColor: `rgba(245, 158, 11, ${(t * 0.4).toFixed(2)})` };
  }

  // ═══ All Leads/Fresh Leads tabs' own stat cards + agent filter (renderNdrLeadsTable) ═══
  // Same idea as RTO's own agentPerf/pend/freshUnassignedCount above its lead table - reuses
  // ndrIsAssignedTo/ndrKpiInScope/ndrDateOptions from the Executive Overview block above.
  const ndrLeadAgentValues = (() => {
    const s = new Set();
    (processAgents || []).forEach(a => s.add(a.email));
    ndrTickets.forEach(t => { if (t.assignedAgent && t.assignedAgent !== 'Unassigned') s.add(t.assignedAgent); });
    return [...s].sort();
  })();
  const ndrLeadAgentOptions = [
    { value: 'ALL', label: 'All agents' },
    ...ndrLeadAgentValues.map(a => ({ value: a, label: a.includes('@') ? a.split('@')[0] : a })),
  ];
  const ndrLeadTargetTickets = ndrScopedTickets.filter(t =>
    (ndrLeadAgentFilter === 'ALL' || ndrIsAssignedTo(t, ndrLeadAgentFilter)) && ndrKpiInScope(t)
  );
  const ndrLeadDisposed = ndrLeadTargetTickets.filter(t => t.connected);
  const ndrLeadConnectedCalls = ndrLeadDisposed.filter(t => t.connected === 'Yes').length;
  const ndrLeadReordersConverted = ndrLeadDisposed.filter(t => t.outcome === 'New order Placed').length;
  const ndrLeadMarkedRto = ndrLeadDisposed.filter(t => t.outcome === 'Mark RTO').length;
  const ndrLeadConnectRate = ndrLeadDisposed.length > 0 ? Math.round((ndrLeadConnectedCalls / ndrLeadDisposed.length) * 100) : 0;
  const ndrLeadReorderRate = ndrLeadConnectedCalls > 0 ? Math.round((ndrLeadReordersConverted / ndrLeadConnectedCalls) * 100) : 0;
  // Active Pending Box - a specific agent picked in the dropdown overrides the viewer's own
  // role-scope (ndrMyScopeEmail), so an Admin picking one agent sees just that agent's queue.
  // Unlike the cards above, deliberately NOT filtered by ndrDateScope - a lead sitting unworked
  // in the queue is "pending" regardless of when it was assigned.
  const ndrLeadPendingScopeEmail = ndrLeadAgentFilter !== 'ALL' ? ndrLeadAgentFilter : ndrMyScopeEmail;
  const ndrLeadPending = ndrTickets.filter(t =>
    (!ndrLeadPendingScopeEmail || ndrIsAssignedTo(t, ndrLeadPendingScopeEmail)) && t.assignedAgent && !t.connected
  ).length;
  // Flat sheet-wide count, unscoped by role/agent/date - same as RTO's own freshUnassignedCount.
  const ndrLeadFreshUnassigned = ndrTickets.filter(t => !t.assignedAgent).length;

  const ndrTabsList = [
    { key: 'overview', label: '📊 Overview', count: ndrTotal },
    { key: 'all', label: 'Total Leads Disposed', count: ndrDisposed },
    { key: 'fresh', label: '⚡ Fresh Leads (Assigned)', count: ndrFreshCount },
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
                <div className="space-y-6">
                  {/* ═══ Executive Overview & Agents Performance ═══ */}
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                        {userRole === 'Agent' && !isProcessAdmin ? '📊 My Performance Overview' : '📊 Executive Overview & Agents Performance'}
                      </h2>
                      <p className="text-[13px] text-zinc-500 mt-0.5">
                        {userRole === 'Agent' && !isProcessAdmin
                          ? 'Your own real-time metrics and lead activity.'
                          : `Comprehensive real-time metrics and lead activity across all ${(processAgents || []).length} team members.`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <CustomSelect
                        value={ndrDateScope}
                        onChange={(val) => { setNdrDateScope(val); safeStorage.setItem('ndr_date_scope', val); }}
                        options={ndrDateOptions}
                        icon={CalendarIcon}
                        placeholder="Date Scope"
                      />
                      {ndrDateScope === 'CUSTOM' && (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="date"
                            value={ndrCustomDateFrom}
                            onChange={(e) => { setNdrCustomDateFrom(e.target.value); safeStorage.setItem('ndr_custom_date_from', e.target.value); }}
                            className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                          />
                          <span className="text-zinc-500 text-[12px]">to</span>
                          <input
                            type="date"
                            value={ndrCustomDateTo}
                            onChange={(e) => { setNdrCustomDateTo(e.target.value); safeStorage.setItem('ndr_custom_date_to', e.target.value); }}
                            className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                          />
                        </div>
                      )}
                      {userRole !== 'Agent' && (
                        <>
                          <span className="text-[12px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded-lg font-mono flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot"></span>
                            {ndrOnlineCount}/{(processAgents || []).length} Active
                          </span>
                          <span className="text-[12px] text-indigo-400 bg-indigo-950/40 border border-indigo-800/40 px-2.5 py-1 rounded-lg font-mono">
                            {(processAgents || []).length} Total Agents
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    <div className="bg-zinc-900/70 rounded-xl p-4 border border-zinc-800/80 shadow-xs">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Total Assigned</p>
                      <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{ndrKpiTotalAssigned.toLocaleString('en-IN')}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">Across all agents</p>
                    </div>
                    <div className="bg-zinc-900/70 rounded-xl p-4 border border-zinc-800/80 shadow-xs">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Total Disposed</p>
                      <p className="text-2xl font-extrabold text-indigo-400 tabular-nums">{ndrKpiTotalDisposed.toLocaleString('en-IN')}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">Actioned leads</p>
                    </div>
                    <div className="bg-zinc-900/70 rounded-xl p-4 border border-amber-900/50 shadow-xs">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-400 mb-1">Pending Queue</p>
                      <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{ndrKpiTotalPending.toLocaleString('en-IN')}</p>
                      <p className="text-[11px] text-amber-400/70 mt-0.5">Awaiting action</p>
                    </div>
                    <div className="bg-zinc-900/70 rounded-xl p-4 border border-emerald-900/50 shadow-xs">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">Avg Connect Rate</p>
                      <p className="text-2xl font-extrabold text-emerald-400 tabular-nums">{ndrKpiAvgConnectRate}<span className="text-sm font-normal text-zinc-400">%</span></p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">Call success</p>
                    </div>
                    <div className="bg-zinc-900/70 rounded-xl p-4 border border-violet-900/50 shadow-xs">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400 mb-1">Reorders Converted</p>
                      <p className="text-2xl font-extrabold text-violet-400 tabular-nums">{ndrKpiTotalReordersConverted.toLocaleString('en-IN')}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">New order Placed</p>
                    </div>
                    <div className="bg-zinc-900/70 rounded-xl p-4 border border-zinc-800/80 shadow-xs">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Fresh Unassigned</p>
                      <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{ndrKpiFreshUnassigned.toLocaleString('en-IN')}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">Ready to claim</p>
                    </div>
                  </div>

                  {/* Agent Performance Summary */}
                  <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
                    <div className="flex items-start justify-between flex-wrap gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">📋 Agent Performance Summary</h3>
                        <p className="text-[12px] text-zinc-500 mt-0.5">
                          Follows the date range above, but each column uses its own REAL event date (not Calling Date, unlike
                          the KPI tiles above): Assigned columns use when the lead was actually claimed by the agent;
                          Disposed/Connected/Reorders/Mark RTO columns use when the agent actually resolved it. Hover a header
                          for which, and for what each % is of. Logged In At/Total Break Time/Total Busy Time follow the same
                          filter as Total Break Time on RTO's own table. FRT is the average time between a lead's assignment
                          and its disposition, across disposed leads with both timestamps.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={downloadNdrRawLeadDetailsCsv}
                          disabled={ndrRawLeadDetailsList.length === 0}
                          title="One row per lead behind this table - AWB, Order ID, Agent Name, Assigned Date, Disposed Date, Connected, Outcome"
                          className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-[13px] font-medium text-zinc-200 transition-all shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <DownloadIcon /> Raw Lead Details
                        </button>
                        <button
                          type="button"
                          onClick={downloadNdrAgentSummaryCsv}
                          disabled={ndrSummaryRows.length === 0}
                          title="This table exactly as shown, one row per agent plus Team Total"
                          className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-[13px] font-medium text-zinc-200 transition-all shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <DownloadIcon /> Export CSV
                        </button>
                      </div>
                    </div>
                    <div className="overflow-x-auto custom-scroll">
                      <table className="w-full min-w-[980px] text-[12.5px] border-collapse">
                        <thead>
                          <tr className="text-left text-zinc-500 uppercase text-[10px] tracking-wider border-b border-zinc-800">
                            <th className="py-2 pr-3 font-bold sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Agent Name</th>
                            <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real assignment date">Total Leads Assigned</th>
                            <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real disposed date">Total Disposed</th>
                            <th className="py-2 px-3 font-bold" title="Average time-of-day of the first disposition across the range's active days">First Called At</th>
                            <th className="py-2 px-3 font-bold" title="Average time between a lead's assignment and its disposition">FRT</th>
                            <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real disposed date">Total Connected</th>
                            <th className="py-2 px-3 font-bold text-right" title="Total Connected / Total Disposed">Connected %</th>
                            <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real disposed date">Reorders Converted</th>
                            <th className="py-2 px-3 font-bold text-right" title="Reorders Converted / Total Disposed">Reorders Converted %</th>
                            <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real disposed date">Mark RTO Count</th>
                            <th className="py-2 px-3 font-bold text-right" title="Mark RTO Count / Total Disposed">Mark RTO %</th>
                            <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real assignment date - 3+ delivery attempts">High-Attempt Assigned</th>
                            <th className="py-2 px-3 font-bold text-right" title="High-Attempt Assigned / Total Leads Assigned">High-Attempt %</th>
                            <th className="py-2 px-3 font-bold" title="Average first-login time-of-day across the range's active days">Logged In At</th>
                            <th className="py-2 px-3 font-bold" title="Average break minutes per active day in the range">Total Break Time</th>
                            <th className="py-2 pl-3 font-bold" title="Average Busy (on-call) minutes per active day in the range">Total Busy Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ndrSummaryRows.map(am => {
                            const presence = serverPresence[am.email.toLowerCase()];
                            return (
                              <tr key={am.email} className="group border-b border-zinc-900 hover:bg-zinc-900/40 transition-colors">
                                <td className="py-2.5 pr-3 font-semibold text-zinc-200 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800 border-r border-zinc-800 transition-colors">{am.name}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">{am.assigned}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">{am.disposed}</td>
                                <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatTimeOfDay(am.firstCalledAtMinutes)}</td>
                                <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatFrt(am.frtMinutes)}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-emerald-400">{am.connected}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-emerald-400">{formatPct(am.connected, am.disposed)}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-violet-400">{am.reordersConverted}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-violet-300">{formatPct(am.reordersConverted, am.disposed)}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-rose-400">{am.markedRto}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-rose-300">{formatPct(am.markedRto, am.disposed)}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-amber-400">{am.highAttempt}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-amber-300">{formatPct(am.highAttempt, am.assigned)}</td>
                                <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatTimeOfDay(presence?.loggedInMinutes)}</td>
                                <td className="py-2.5 px-3 text-amber-400 font-mono whitespace-nowrap">{formatBreakMinutes(presence?.breakMinutes)}</td>
                                <td className="py-2.5 pl-3 text-rose-400 font-mono whitespace-nowrap">{formatBreakMinutes(presence?.busyMinutes)}</td>
                              </tr>
                            );
                          })}
                          {ndrSummaryRows.length > 0 && (
                            <tr className="border-t-2 border-zinc-700 bg-zinc-900/80 font-bold">
                              <td className="py-2.5 pr-3 text-zinc-100 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Team Total</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-zinc-100">{ndrSummaryTotals.assigned}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-zinc-100">{ndrSummaryTotals.disposed}</td>
                              <td className="py-2.5 px-3 text-zinc-500">—</td>
                              <td className="py-2.5 px-3 text-zinc-300 font-mono whitespace-nowrap" title="Average across disposed leads with both timestamps">{formatFrt(ndrSummaryAvgFrt)}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-emerald-300">{ndrSummaryTotals.connected}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-emerald-300">{formatPct(ndrSummaryTotals.connected, ndrSummaryTotals.disposed)}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-violet-300">{ndrSummaryTotals.reordersConverted}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-violet-200">{formatPct(ndrSummaryTotals.reordersConverted, ndrSummaryTotals.disposed)}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-rose-300">{ndrSummaryTotals.markedRto}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-rose-200">{formatPct(ndrSummaryTotals.markedRto, ndrSummaryTotals.disposed)}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-amber-300">{ndrSummaryTotals.highAttempt}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums text-amber-200">{formatPct(ndrSummaryTotals.highAttempt, ndrSummaryTotals.assigned)}</td>
                              <td className="py-2.5 px-3 text-zinc-300 font-mono whitespace-nowrap" title="Average across agents with a real value">{formatTimeOfDay(ndrSummaryAvgLoggedIn)}</td>
                              <td className="py-2.5 px-3 text-amber-300 font-mono whitespace-nowrap" title="Average across agents with a real value">{formatBreakMinutes(ndrSummaryAvgBreak)}</td>
                              <td className="py-2.5 pl-3 text-rose-300 font-mono whitespace-nowrap" title="Average across agents with a real value">{formatBreakMinutes(ndrSummaryAvgBusy)}</td>
                            </tr>
                          )}
                          {ndrSummaryRows.length === 0 && (
                            <tr><td colSpan={16} className="py-6 text-center text-zinc-500">No agents with assigned leads in this date range.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Time-of-Day Distribution */}
                  <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">🕐 Time-of-Day Distribution</h3>
                        <p className="text-[12px] text-zinc-500 mt-0.5">
                          Same date range as above, bucketed by time of day - columns span only the buckets with any activity.
                          Cell shading is a whole-table scale - the darker the highlight, the lower that count is relative to
                          every other cell currently shown.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <CustomSelect
                          value={ndrHeatmapMetric}
                          onChange={(v) => { setNdrHeatmapMetric(v); safeStorage.setItem('ndr_heatmap_metric', v); }}
                          options={ndrHeatmapMetricOptions}
                        />
                        <CustomSelect
                          value={ndrHeatmapIntervalMinutes}
                          onChange={(v) => { setNdrHeatmapIntervalMinutes(v); safeStorage.setItem('ndr_heatmap_interval', String(v)); }}
                          options={ndrHeatmapIntervalOptions}
                        />
                      </div>
                    </div>
                    <div className="overflow-x-auto custom-scroll">
                      <table className="w-full text-[12.5px] border-collapse">
                        <thead>
                          <tr className="text-left text-zinc-500 uppercase text-[10px] tracking-wider border-b border-zinc-800">
                            <th className="py-2 pr-3 font-bold whitespace-nowrap sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Agent Name</th>
                            {ndrHeatmapBucketIndexes.map(idx => (
                              <th key={idx} className="py-2 px-3 font-bold text-right whitespace-nowrap">{formatTimeOfDay(idx * ndrHeatmapIntervalMinutes)}</th>
                            ))}
                            <th className="py-2 pl-3 font-bold text-right whitespace-nowrap border-l border-zinc-800">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ndrVisibleHeatmapAgentData.map(a => {
                            const rowTotal = ndrHeatmapBucketIndexes.reduce((s, idx) => s + (a.bucketCounts.get(idx) || 0), 0);
                            return (
                              <tr key={a.email} className="group border-b border-zinc-900 hover:bg-zinc-900/40 transition-colors">
                                <td className="py-2.5 pr-3 font-semibold text-zinc-200 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800 border-r border-zinc-800 transition-colors">{a.name}</td>
                                {ndrHeatmapBucketIndexes.map(idx => {
                                  const value = a.bucketCounts.get(idx) || 0;
                                  return <td key={idx} className="py-2.5 px-3 text-right tabular-nums text-zinc-200" style={ndrHeatmapCellStyle(value)}>{value}</td>;
                                })}
                                <td className="py-2.5 pl-3 text-right tabular-nums text-zinc-100 font-bold border-l border-zinc-800">{rowTotal}</td>
                              </tr>
                            );
                          })}
                          {ndrVisibleHeatmapAgentData.length > 0 && (
                            <tr className="border-t-2 border-zinc-700 bg-zinc-900/80 font-bold">
                              <td className="py-2.5 pr-3 text-zinc-100 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Team Total</td>
                              {ndrHeatmapBucketIndexes.map(idx => {
                                const columnTotal = ndrVisibleHeatmapAgentData.reduce((s, a) => s + (a.bucketCounts.get(idx) || 0), 0);
                                return <td key={idx} className="py-2.5 px-3 text-right tabular-nums text-zinc-100">{columnTotal}</td>;
                              })}
                              <td className="py-2.5 pl-3 text-right tabular-nums text-zinc-100 border-l border-zinc-800">
                                {ndrVisibleHeatmapAgentData.reduce((s, a) => s + ndrHeatmapBucketIndexes.reduce((s2, idx) => s2 + (a.bucketCounts.get(idx) || 0), 0), 0)}
                              </td>
                            </tr>
                          )}
                          {ndrVisibleHeatmapAgentData.length === 0 && (
                            <tr>
                              <td colSpan={ndrHeatmapBucketIndexes.length + 2} className="py-6 text-center text-zinc-500">
                                No {ndrHeatmapMetricOptions.find(o => o.value === ndrHeatmapMetric)?.label.toLowerCase()} activity in this date range.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* All-time snapshot cards (unrelated to the date scope above) */}
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
