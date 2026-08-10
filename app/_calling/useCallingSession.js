'use client';

// Shared session/permissions/presence for a Calling process page - the pieces every process
// (RTO, NDR, and whatever comes next) needs regardless of what its own lead table/disposition
// form look like: who's signed in, what role they're viewing as, whether they administer this
// process, who else is on its roster, and everyone's live Online/On Break/Busy/Offline status.
//
// Deliberately ONE hook, not several smaller ones: loadProcessAgents sets both `processAgents`
// AND `isProcessAdmin` from the same response, and isProcessAdmin is read by page-level tab
// gating as well as by the roster table - splitting these into separate hooks would just mean
// threading one hook's output back into another's input.
//
// getPendingBox/getDateBounds are getters (not plain values) because the caller's own
// "My Active Queue" count and date-scope filter are usually declared in the page's OWN state,
// further down the component than where this hook needs to be called - passing them directly
// would be a temporal-dead-zone bug. Stashed in refs below so the hook always reads the
// LATEST value without needing them in any effect's dependency array.
import { useState, useEffect, useCallback, useRef } from 'react';
import { safeStorage as localStorage, postJsonWithRetry } from './util';

// value 'Busy' predates the "On Break" label and is kept as-is (see CALLING_STATUSES' comment
// in api/_lib/db.js) - "Busy" as shown in the UI today (an agent currently on a call) is a
// genuinely different status, so it gets its own value, 'OnCall', rather than colliding with
// the existing one.
export const STATUS_OPTIONS = [
  { value: 'Online', label: 'Online', icon: '🟢' },
  { value: 'Busy', label: 'On Break', icon: '🟡' },
  { value: 'OnCall', label: 'Busy', icon: '🔴' },
  { value: 'Offline', label: 'Offline', icon: '⚪' },
];

// Team Roster tab's status filter - same live statuses plus an "All" option.
export const ROSTER_STATUS_OPTIONS = [
  { value: 'All', label: 'All Statuses', icon: '📋' },
  ...STATUS_OPTIONS,
];

export const ROLE_OPTIONS = [
  { value: 'Admin', label: 'Role: Admin', icon: '🛡️' },
  { value: 'Team Lead', label: 'Role: Team Lead', icon: '👑' },
  { value: 'Agent', label: 'Role: Agent', icon: '👤' },
];

export function useCallingSession(processKey, { getPendingBox, getDateBounds } = {}) {
  const pendingBoxRef = useRef(getPendingBox);
  pendingBoxRef.current = getPendingBox;
  const dateBoundsRef = useRef(getDateBounds);
  dateBoundsRef.current = getDateBounds;

  const [googleUser, setGoogleUser] = useState(() => {
    try { const s = localStorage.getItem('rto_google_user'); if (s) return JSON.parse(s); } catch {}
    return { name: 'Vighnesh Patil', email: 'vighnesh.patil@mcaffeine.com', picture: 'https://api.dicebear.com/7.x/avataaars/svg?seed=vighnesh.patil@mcaffeine.com' };
  });

  const [userRole, setUserRole] = useState(() => {
    try { const saved = localStorage.getItem('rto_active_role'); if (saved) return saved; } catch {}
    return 'Admin';
  });

  // Server-granted process access, filled in by the auth sync below. null = no explicit grant
  // on this account (admins, or an agent with no per-process rows); the list is only narrowed
  // when the database actually says which processes were granted. Kept out of localStorage on
  // purpose - it is an authorisation answer, so it gets re-fetched from the session on every
  // load rather than remembered by the browser.
  const [invitedProcessKeys, setInvitedProcessKeys] = useState(null);
  const [sessionIsAdmin, setSessionIsAdmin] = useState(false);
  const [processPermsLoaded, setProcessPermsLoaded] = useState(false);

  // Auth sync
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      if (d?.authenticated && d.email) {
        const u = { name: d.name || d.email.split('@')[0], email: d.email, picture: `https://api.dicebear.com/7.x/avataaars/svg?seed=${d.email}` };
        setGoogleUser(u);
        localStorage.setItem('rto_google_user', JSON.stringify(u));
        // Role defaults from the account itself (users.is_admin), not from a hardcoded list of
        // names - an admin who isn't called vighnesh or vikash is still an admin.
        const savedRole = localStorage.getItem('rto_active_role');
        if (!savedRole) {
          setUserRole(d.isAdmin ? 'Admin' : 'Agent');
        } else if (!d.isAdmin && savedRole !== 'Agent') {
          // A cached role can only ever LOWER what you see, never raise it: someone who is not
          // an admin on the server must not keep an 'Admin' view just because their browser
          // remembers one. (The panels behind it are all server-gated anyway, so this is about
          // not showing controls that would only fail.)
          setUserRole('Agent');
          try { localStorage.setItem('rto_active_role', 'Agent'); } catch {}
        }
        // Which processes this account has actually been invited to. getSession() reads
        // report_tab_permissions fresh from the database on every request, so this is the real
        // grant, not something the browser can talk itself into: an agent editing localStorage
        // still can't add a process here. is_admin users come back with an empty tabPerms,
        // which by that model's own convention means "unrestricted".
        setSessionIsAdmin(!!d.isAdmin);
        const callingTabs = (d.tabPerms && d.tabPerms.calling) || null;
        setInvitedProcessKeys(Array.isArray(callingTabs) && callingTabs.length ? callingTabs : null);
        setProcessPermsLoaded(true);
      } else {
        setProcessPermsLoaded(true);
      }
    }).catch(() => { setProcessPermsLoaded(true); });
  }, []);

  const [toast, setToast] = useState(null);
  const showToast = useCallback(m => { setToast(m); setTimeout(() => setToast(null), 3000); }, []);

  // The active process's own roster: who is invited to it, and their status/quota FOR THIS
  // PROCESS. Server-owned - scripts/assign_leads.py (and its NDR equivalent) reads the same
  // rows, so a browser-only value would change nothing about who gets leads.
  const [processAgents, setProcessAgents] = useState(null);
  // Whether the signed-in user administers THIS process (calling_agent_process
  // .is_process_admin). Separate from sessionIsAdmin, which is company-wide: a process admin
  // runs one process's roster and hours and gets nothing else. Server-derived - the roster it
  // reads comes from an endpoint that already refuses processes you don't administer, so the
  // browser can't grant this to itself.
  const [isProcessAdmin, setIsProcessAdmin] = useState(false);
  const [processAgentsError, setProcessAgentsError] = useState('');
  const [savingAgentEmail, setSavingAgentEmail] = useState('');

  // Reloaded whenever the page switches process - the whole point is that each process has its
  // own answer, so it can't be cached across them. Fetched for everyone signed in: the endpoint
  // itself decides (403s a process you don't administer), and it's the only way to learn you ARE
  // a process admin - gating the fetch on a role the browser holds would make that unknowable.
  const loadProcessAgents = useCallback(async (key) => {
    if (!key) return;
    setProcessAgents(null);
    setProcessAgentsError('');
    try {
      const r = await fetch(`/api/admin/calling-agents?process=${encodeURIComponent(key)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setProcessAgentsError(d.error || `Could not load roster (${r.status})`); return; }
      setProcessAgents(d.agents || []);
      const me = (d.agents || []).find(a => (a.email || '').toLowerCase() === (googleUser?.email || '').toLowerCase());
      setIsProcessAdmin(!!(me && me.isProcessAdmin));
    } catch (e) {
      setProcessAgentsError(e.message || 'Could not load roster');
    }
  }, [googleUser]);

  // Fires alongside the auth-sync fetch above, not after it: the endpoint only needs
  // processKey (identity comes from the session cookie server-side, same as any other
  // protected endpoint), so waiting on googleUser here just serialized two round trips for no
  // real data dependency. googleUser is only used afterward, inside loadProcessAgents itself,
  // to match "me" against the returned roster - staying a dep of loadProcessAgents (and so
  // transitively of this effect) means that match still recomputes once the real signed-in
  // user is known.
  useEffect(() => {
    loadProcessAgents(processKey);
  }, [processKey, loadProcessAgents]);

  // One agent, one process, one field at a time. status and maxQuota are sent independently so
  // changing availability never disturbs a quota an admin set.
  const saveProcessAgent = async (email, patch) => {
    setSavingAgentEmail(email);
    setProcessAgentsError('');
    try {
      const r = await fetch('/api/admin/calling-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, email, ...patch }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not save (${r.status})`;
        setProcessAgentsError(msg);
        showToast(`⚠️ ${msg}`);
        return;
      }
      setProcessAgents(d.agents || []);
    } catch (e) {
      const msg = e.message || 'Could not save';
      setProcessAgentsError(msg);
      showToast(`⚠️ ${msg}`);
    } finally {
      setSavingAgentEmail('');
    }
  };

  // Namespaced per process (rto_agent_status:<processKey>) - a single global key meant two
  // browser tabs on different processes (one RTO, one NDR) fought over the same cached value.
  // No migration needed: this is only a first-paint placeholder, overwritten by the server
  // fetch below within milliseconds.
  const statusStorageKey = `rto_agent_status:${processKey}`;
  const [agentStatus, setAgentStatus] = useState(() => localStorage.getItem(statusStorageKey) || 'Online');

  // The signed-in agent's own availability is per process, so switching process has to show
  // that process's own answer rather than carrying the previous one over - being Online for RTO
  // says nothing about NDR. Read from the server (not localStorage) because this is the value
  // assign_leads.py acts on; the local copy is only a first-paint placeholder.
  useEffect(() => {
    if (!googleUser?.email || !processKey) return;
    let cancelled = false;
    fetch(`/api/auth/processPresence?process=${encodeURIComponent(processKey)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d || !d.status) return;
        setAgentStatus(d.status);
        try { localStorage.setItem(statusStorageKey, d.status); } catch {}
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [googleUser, processKey]);

  // Real presence from Postgres (agent_presence table), keyed by lowercase email - {}'d out for
  // non-admin sessions (the GET is admin-only), in which case a page's own roster table just
  // falls back to each agent's local/mock status.
  const [serverPresence, setServerPresence] = useState({});

  // GET /api/auth/presence, with dateFrom/dateTo (from the caller's own date-scope filter, via
  // getDateBounds) so loggedInMinutes/breakMinutes/busyMinutes follow whatever date range the
  // caller's own Overview table uses - re-fetches immediately when that filter changes (not
  // just on the 30s poll), so switching to Yesterday/a Custom range doesn't sit on stale numbers
  // for up to 30 seconds. A caller with no such filter (getDateBounds omitted) gets an
  // unbounded (ALL_TIME) query, which is a safe default, not an error.
  const fetchServerPresence = useCallback(() => {
    const { dateFrom, dateTo } = dateBoundsRef.current ? dateBoundsRef.current() : {};
    const params = new URLSearchParams();
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    // Lets the server recognize a process admin (not company-wide) and scope them to their OWN
    // process's roster instead of self-only - see handlePresence's own comment. Harmless for a
    // plain agent or a full admin, who ignore it (self-only / everyone respectively).
    if (processKey) params.set('process', processKey);
    const qs = params.toString();
    fetch(`/api/auth/presence${qs ? `?${qs}` : ''}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.agents) setServerPresence(d.agents); })
      .catch(() => {});
  }, [processKey]);
  // Held in a ref (not called directly) so the shared visibilitychange listener further down
  // always invokes today's fetchServerPresence, not the one captured when the tab last had
  // this effect run.
  const fetchServerPresenceRef = useRef(fetchServerPresence);
  fetchServerPresenceRef.current = fetchServerPresence;
  useEffect(() => {
    fetchServerPresence();
    const t = setInterval(() => {
      if (!document.hidden) fetchServerPresence();
    }, 30000);
    return () => clearInterval(t);
  }, [fetchServerPresence]);

  // Reports an agent's status to the server (Postgres-backed agent_presence - see
  // api/auth/[action].js's presence handler) - this is what assign_leads.py/assign_ndr_leads.py
  // read to decide who's eligible for new leads. Best-effort: a failed sync just means that
  // agent won't show as eligible for the next assignment pass, not a UI error.
  const syncPresenceToServer = useCallback((status, opts = {}) => {
    const body = { status };
    if (typeof opts.pendingBox === 'number') body.pendingBox = opts.pendingBox;
    if (opts.email) { body.email = opts.email; body.name = opts.name; }
    postJsonWithRetry('/api/auth/presence', body);
  }, []);

  // Combined self-status write: both halves have to be written, or assign_leads.py won't agree
  // with what the UI shows - agent_presence ("at their desk", global) and calling_agent_process
  // ("available for THIS process"). Writing only one is what made this control look effective
  // while changing nothing about who receives leads. Callers add their own activity-log/roster-
  // cache side effects on top of this (see RtoCrmClient.js's handleSetStatus).
  const setStatus = useCallback((s) => {
    setAgentStatus(s);
    try { localStorage.setItem(statusStorageKey, s); } catch {}
    syncPresenceToServer(s, { pendingBox: s === 'Online' ? pendingBoxRef.current?.() : undefined });
    if (processKey) {
      postJsonWithRetry('/api/auth/processPresence', { processKey, status: s });
    }
  }, [processKey, statusStorageKey, syncPresenceToServer]);

  // Same as setStatus, but for a DIFFERENT agent - the roster table's per-row status control.
  // The server only honors a client-supplied target email for an admin session (see
  // api/auth/[action].js's presence handler), so a non-admin trying it just ends up reporting
  // their own status regardless. `name` is the target's display name (the caller already has
  // this from its own roster - passed in rather than looked up here, since the merged roster
  // itself lives outside this hook).
  const setStatusForAgent = useCallback((email, newStatus, name) => {
    const lower = (email || '').toLowerCase();
    if (!lower) return;
    const isSelf = googleUser?.email && googleUser.email.toLowerCase() === lower;

    if (processKey) {
      if (isSelf) {
        postJsonWithRetry('/api/auth/processPresence', { processKey, status: newStatus });
      } else {
        saveProcessAgent(lower, { status: newStatus });
      }
    }

    if (isSelf) {
      setAgentStatus(newStatus);
      try { localStorage.setItem(statusStorageKey, newStatus); } catch {}
      syncPresenceToServer(newStatus, { pendingBox: newStatus === 'Online' ? pendingBoxRef.current?.() : undefined });
    } else {
      syncPresenceToServer(newStatus, { email: lower, name });
      // Optimistic - a page's own merged roster prefers serverPresence for non-self rows, so
      // without this the row would flicker back to the old status until the next 30s poll
      // catches up with what was just written.
      setServerPresence(p => ({ ...p, [lower]: { status: newStatus, updatedAt: null } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleUser, processKey, statusStorageKey, syncPresenceToServer]);

  // Presence heartbeat: push status to the server immediately on sign-in, then every 2 minutes
  // while active, well inside assign_leads.py's 10-minute staleness window - an agent who opens
  // the app and just starts working without ever touching the status dropdown still needs the
  // server to know they're Online. Also passes pendingBox so returning to the app already
  // Online with an empty queue (e.g. a page refresh) still gets the instant-assignment trigger,
  // not just an explicit dropdown change.
  //
  // Deliberately does NOT push a locally-cached 'Offline' this same way: unlike Online/Busy,
  // this cached value could just be leftover from a stale/background tab (read once on mount)
  // rather than anything the agent actually just chose - blindly replaying it here could
  // silently flip a genuinely-Online agent (set from a different, currently-active tab) back to
  // Offline with no explicit action on this tab's part at all. Only an agent's own dropdown
  // click (setStatus/setStatusForAgent) should ever write Offline.
  useEffect(() => {
    if (googleUser?.email && agentStatus !== 'Offline') {
      syncPresenceToServer(agentStatus, { pendingBox: agentStatus === 'Online' ? pendingBoxRef.current?.() : undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleUser]);

  // Presence heartbeat: keeps this agent's agent_presence row fresh in Postgres every 2
  // minutes, well inside the 10-minute staleness window, so someone who's been Online/Busy for
  // a while doesn't silently fall out of the eligible pool. Only the agent's own explicit
  // status choice should ever change their status or touch their assignments - never an idle
  // timer (a long call, a meeting, or just reading something could trigger it for no good
  // reason, silently pulling leads out from under someone who was still actively working them).
  const heartbeatTickRef = useRef(() => {});
  useEffect(() => {
    if (!googleUser?.email) { heartbeatTickRef.current = () => {}; return; }
    const tick = () => {
      if (agentStatus !== 'Offline') syncPresenceToServer(agentStatus);
    };
    heartbeatTickRef.current = tick;
    const t = setInterval(() => {
      if (!document.hidden) tick();
    }, 2 * 60 * 1000);
    return () => clearInterval(t);
  }, [agentStatus, googleUser, syncPresenceToServer]);

  // Polls this page's own deployed bundle for a version change (ETag/Last-Modified via a
  // no-store HEAD request) so a long-lived tab that's been open since before a deploy shows a
  // "reload for the latest version" banner instead of silently running stale JS forever - the
  // exact way some agents' browsers once kept running old JS that predated a feature while
  // others, who'd reloaded more recently, silently got it. Zero upkeep on every future edit,
  // since it's comparing the file's own headers, not a manually-bumped version constant.
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const deployedVersionRef = useRef(null);
  const versionCheckRef = useRef(() => {});
  useEffect(() => {
    const checkVersion = async () => {
      try {
        const res = await fetch(window.location.pathname, { method: 'HEAD', cache: 'no-store' });
        const v = res.headers.get('etag') || res.headers.get('last-modified');
        if (!v) return;
        if (deployedVersionRef.current === null) {
          deployedVersionRef.current = v;
        } else if (v !== deployedVersionRef.current) {
          setUpdateAvailable(true);
        }
      } catch (e) {
        // Network hiccup - just skip this round, next interval tries again.
      }
    };
    versionCheckRef.current = checkVersion;
    checkVersion();
    const t = setInterval(() => {
      if (!document.hidden) checkVersion();
    }, 3 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // One shared visibilitychange listener (not one per interval above) so a tab that's been
  // backgrounded for a while catches presence/heartbeat/version-check up immediately on
  // return, rather than waiting up to a full interval period for each to happen to tick.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      fetchServerPresenceRef.current();
      heartbeatTickRef.current();
      versionCheckRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return {
    googleUser, setGoogleUser,
    userRole, setUserRole,
    sessionIsAdmin, invitedProcessKeys, processPermsLoaded,
    processAgents, isProcessAdmin, processAgentsError, savingAgentEmail,
    loadProcessAgents, saveProcessAgent,
    agentStatus, serverPresence,
    setStatus, setStatusForAgent,
    toast, showToast,
    updateAvailable,
  };
}
