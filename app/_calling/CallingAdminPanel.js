'use client';

// Admin-surface pieces shared by every Calling process page: the business-hours editor, the
// admin-configurable disposition-tree editor, and the per-process team registry. All three are
// already fully generic (parameterized by processKey, nothing RTO/NDR-specific baked in) - RTO
// itself never renders ProcessDispositionsCard or CallingTeamsCard (it keeps its own hardcoded
// connectedOutcomes/unreachableOutcomes arrays and has no team concept yet), but CallingHoursCard
// is shared as-is.
//
// Deliberately NOT included here: the team roster table. Unlike hours/dispositions, RTO's
// roster add/remove actions are tied to RTO's own ticket model (checking allTickets for active/
// historical leads before allowing a removal) - forcing that into a "shared" component would
// mean threading RTO-only safety-check logic through props for a component NDR would use
// differently anyway. Each process's page keeps its own roster table, built from this module's
// hooks plus useCallingSession's processAgents/saveProcessAgent/setStatusForAgent.
import { useState, useCallback, useEffect } from 'react';

export const BUSINESS_HOUR_DAY_LABELS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

// Admin-editable calling hours, per process and per weekday. Server-owned (the
// calling_business_hours table, via /api/admin/business-hours) rather than local state, because
// assign_leads.py (and its per-process equivalents) has to read the same values to decide
// whether it may hand out leads - a browser-only setting would change nothing about that.
export function useBusinessHours(processKey, { userRole, isProcessAdmin, showToast } = {}) {
  const [hoursByProcess, setHoursByProcess] = useState(null); // null = not loaded yet
  const [hoursDraft, setHoursDraft] = useState(null);         // the week being edited
  const [hoursSaving, setHoursSaving] = useState(false);
  const [hoursError, setHoursError] = useState('');

  // Loaded once an admin actually opens the panel that shows them, rather than on every page
  // load - agents never see this card, so most sessions have no reason to make the call.
  // /api/admin/* is admin-only server-side, so a non-admin simply gets a 403 here and the card
  // stays hidden.
  const loadBusinessHours = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/business-hours');
      if (!r.ok) return;
      const d = await r.json();
      const byKey = {};
      (d.processes || []).forEach(p => { byKey[p.key] = p; });
      setHoursByProcess(byKey);
    } catch { /* leave unloaded - the card just won't render */ }
  }, []);

  useEffect(() => {
    if ((userRole === 'Admin' || userRole === 'Team Lead' || isProcessAdmin) && hoursByProcess === null) {
      loadBusinessHours();
    }
  }, [userRole, isProcessAdmin, hoursByProcess, loadBusinessHours]);

  // Editing starts from whatever the server returned for the process currently selected, so
  // the card always shows the hours for the process being administered.
  useEffect(() => {
    if (hoursByProcess && processKey && hoursByProcess[processKey]) {
      setHoursDraft(JSON.parse(JSON.stringify(hoursByProcess[processKey].week)));
      setHoursError('');
    }
  }, [hoursByProcess, processKey]);

  const saveBusinessHours = async () => {
    if (!hoursDraft || !processKey) return;
    setHoursSaving(true);
    setHoursError('');
    try {
      const r = await fetch('/api/admin/business-hours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, week: hoursDraft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // The server validates each day (close after open, both-or-neither) and returns a
        // readable reason - surfaced as-is so the admin can correct the actual field.
        setHoursError(d.error || `Could not save (${r.status})`);
        return;
      }
      const byKey = {};
      (d.processes || []).forEach(p => { byKey[p.key] = p; });
      setHoursByProcess(byKey);
      if (showToast) showToast('🕒 Calling hours saved');
    } catch (e) {
      setHoursError(e.message || 'Could not save calling hours');
    } finally {
      setHoursSaving(false);
    }
  };

  return { hoursByProcess, hoursDraft, setHoursDraft, hoursSaving, hoursError, saveBusinessHours };
}

// hours = a useBusinessHours() return value; processLabel = display name (e.g. "RTO Calling").
export function CallingHoursCard({ processKey, processLabel, hours }) {
  const { hoursByProcess, hoursDraft, setHoursDraft, hoursSaving, hoursError, saveBusinessHours } = hours;
  if (!hoursDraft) return null;
  return (
    <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 shadow-xl backdrop-blur-md">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 shrink-0 rounded-xl bg-emerald-950/60 border border-emerald-800/60 flex items-center justify-center text-emerald-300">🕒</span>
          <div>
            <h2 className="text-lg font-bold text-zinc-100">
              Calling Hours &mdash; {processLabel}
            </h2>
            <p className="text-[13px] text-zinc-500">
              Automatic lead hand-out only runs inside these hours ({(hoursByProcess?.[processKey]?.timezone) || 'IST'}).
              Leave a day blank to close it. Agents can still record calls they&apos;ve already made at any time.
              {hoursByProcess?.[processKey]?.isDefault && (
                <span className="text-amber-400"> Currently using defaults &mdash; not yet set by an admin.</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHoursDraft(JSON.parse(JSON.stringify(hoursByProcess[processKey].week)))}
            disabled={hoursSaving}
            className="h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[13px] font-semibold transition-colors disabled:opacity-40"
          >
            Reset
          </button>
          <button
            onClick={saveBusinessHours}
            disabled={hoursSaving}
            className="h-8 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-bold transition-colors shadow-md shadow-indigo-950/50 disabled:opacity-50"
          >
            {hoursSaving ? 'Saving…' : 'Save hours'}
          </button>
        </div>
      </div>

      {hoursError && (
        <p className="mt-3 text-[13px] text-rose-400 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">
          {hoursError}
        </p>
      )}

      <div className="mt-4 space-y-1.5">
        {BUSINESS_HOUR_DAY_LABELS.map(([key, label]) => {
          const day = hoursDraft[key] || { open: '', close: '' };
          const closed = !day.open && !day.close;
          const setDay = (field, value) =>
            setHoursDraft(p => ({ ...p, [key]: { ...(p[key] || { open: '', close: '' }), [field]: value } }));
          return (
            <div key={key} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-950/40 border border-zinc-800/60 px-4 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-[13px] font-semibold text-zinc-200 w-24">{label}</span>
                {closed && <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 bg-zinc-800/80 border border-zinc-700/60 rounded-md px-2 py-0.5">Closed</span>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <label className="flex items-center gap-1.5 text-[12px] text-zinc-500">
                  Open:
                  <input
                    type="time"
                    value={day.open || ''}
                    onChange={e => setDay('open', e.target.value)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-[13px] text-zinc-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-zinc-500">
                  Close:
                  <input
                    type="time"
                    value={day.close || ''}
                    onChange={e => setDay('close', e.target.value)}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-[13px] text-zinc-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                  />
                </label>
                <button
                  onClick={() => setHoursDraft(p => ({ ...p, [key]: { open: '', close: '' } }))}
                  title="Close this day"
                  className="h-7 px-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-[11px] font-semibold transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Admin-editable default quota for a process (calling_process_settings, via
// /api/admin/default-quota) - the cap RTO/NDR's next-lead.js/claim.js (and NPS-Calling's
// auto-assign triggers, since its own next-lead.js is deleted - see the 2026-09-05 auto-
// assignment design spec) fall back to for any agent with no per-agent max_quota override in
// the Team Roster table. Same lazy-load-on-open pattern as
// useBusinessHours: agents never see this card, so most sessions never make the call.
export function useDefaultQuota(processKey, { userRole, isProcessAdmin, showToast } = {}) {
  const [quota, setQuota] = useState(null);       // server value: number, or null = never set
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadQuota = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/default-quota?process=${encodeURIComponent(processKey)}`);
      if (!r.ok) return;
      const d = await r.json();
      setQuota(d.quota != null ? d.quota : null);
      setDraft(d.quota != null ? String(d.quota) : '');
      setLoaded(true);
    } catch { /* leave unloaded - the card just won't render */ }
  }, [processKey]);

  useEffect(() => {
    if ((userRole === 'Admin' || userRole === 'Team Lead' || isProcessAdmin) && !loaded) {
      loadQuota();
    }
  }, [userRole, isProcessAdmin, loaded, loadQuota]);

  const saveQuota = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/admin/default-quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, quota: draft === '' ? null : Number(draft) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error || `Could not save (${r.status})`);
        return;
      }
      setQuota(d.quota != null ? d.quota : null);
      if (showToast) showToast('🎯 Default quota saved');
    } catch (e) {
      setError(e.message || 'Could not save default quota');
    } finally {
      setSaving(false);
    }
  };

  return { quota, loaded, draft, setDraft, saving, error, saveQuota };
}

// quota = a useDefaultQuota() return value; processLabel = display name (e.g. "NPS-Calling");
// fallback = the hardcoded value the server itself falls back to when quota.quota is null (keep
// in sync with that endpoint's own FALLBACK_QUOTA - shown so an admin knows what's in effect).
export function DefaultQuotaCard({ processLabel, fallback, quota }) {
  const { loaded, draft, setDraft, saving, error, saveQuota } = quota;
  if (!loaded) return null;
  return (
    <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 shadow-xl backdrop-blur-md">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 shrink-0 rounded-xl bg-indigo-950/60 border border-indigo-800/60 flex items-center justify-center text-indigo-300">🎯</span>
          <div>
            <h2 className="text-lg font-bold text-zinc-100">
              Default Quota &mdash; {processLabel}
            </h2>
            <p className="text-[13px] text-zinc-500">
              Max undisposed leads an agent may hold with no per-agent override set below in
              Team Roster. Blank uses this process&apos;s built-in fallback of {fallback}.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={String(fallback)}
            className="w-24 h-8 px-2 rounded-lg bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
          />
          <button
            onClick={saveQuota}
            disabled={saving}
            className="h-8 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-bold transition-colors shadow-md shadow-indigo-950/50 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-3 text-[13px] text-rose-400 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
}

// Admin-set pull order for a process's leads (calling_process_settings.lead_order, via
// /api/admin/lead-order) - same load-on-open/save shape as useDefaultQuota above.
export function useLeadOrder(processKey, { userRole, isProcessAdmin, showToast } = {}) {
  const [order, setOrder] = useState(null);        // server value: 'oldest'/'newest', or null = never set
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('oldest');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadOrder = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/lead-order?process=${encodeURIComponent(processKey)}`);
      if (!r.ok) return;
      const d = await r.json();
      setOrder(d.order || null);
      setDraft(d.order || 'oldest');
      setLoaded(true);
    } catch { /* leave unloaded - the card just won't render */ }
  }, [processKey]);

  useEffect(() => {
    if ((userRole === 'Admin' || userRole === 'Team Lead' || isProcessAdmin) && !loaded) {
      loadOrder();
    }
  }, [userRole, isProcessAdmin, loaded, loadOrder]);

  const saveOrder = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/admin/lead-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, order: draft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error || `Could not save (${r.status})`);
        return;
      }
      setOrder(d.order || null);
      if (showToast) showToast('🔀 Lead order saved');
    } catch (e) {
      setError(e.message || 'Could not save lead order');
    } finally {
      setSaving(false);
    }
  };

  return { order, loaded, draft, setDraft, saving, error, saveOrder };
}

// order = a useLeadOrder() return value; processLabel = display name (e.g. "NPS-Calling").
export function LeadOrderCard({ processLabel, order }) {
  const { loaded, draft, setDraft, saving, error, saveOrder } = order;
  if (!loaded) return null;
  return (
    <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 shadow-xl backdrop-blur-md">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 shrink-0 rounded-xl bg-indigo-950/60 border border-indigo-800/60 flex items-center justify-center text-indigo-300">🔀</span>
          <div>
            <h2 className="text-lg font-bold text-zinc-100">
              Lead Order &mdash; {processLabel}
            </h2>
            <p className="text-[13px] text-zinc-500">
              Which unclaimed lead gets assigned first.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[['oldest', 'Oldest first'], ['newest', 'Newest first']].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setDraft(value)}
              className={`h-8 px-3 rounded-lg text-[13px] font-bold border transition-colors ${
                draft === value ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={saveOrder}
            disabled={saving}
            className="h-8 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-bold transition-colors shadow-md shadow-indigo-950/50 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-3 text-[13px] text-rose-400 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
}

// Per-process TEAM registry (see calling_teams) - the self-serve half of NDR's per-team
// isolation feature (docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md). A
// team is a dimension INSIDE a process, not a process of its own: two NDR teams share this
// process's calling hours and disposition tree, and differ only in which agents are on them and
// which Google Sheet they work.
//
// GET is fetched for every process admin (not just full admins) so a team lead's own page can
// show its team's name - the server already strips sheetId/sheetTab down to {id,name,active}
// for anyone who isn't a full admin (see api/admin/[action].js's handleCallingTeams), so this
// hook never even receives another team's sheet id to accidentally expose. Create/update are
// full-admin-only, enforced server-side; the fields exist here so CallingTeamsCard has
// something to call, not because this hook grants anything itself.
export function useCallingTeams(processKey, { googleUser, showToast } = {}) {
  const [teams, setTeams] = useState(null); // null = not loaded yet
  const [teamsError, setTeamsError] = useState('');
  const [savingTeam, setSavingTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamSheetId, setNewTeamSheetId] = useState('');
  const [newTeamSheetTab, setNewTeamSheetTab] = useState('');

  const loadTeams = useCallback(async (key) => {
    if (!key) return;
    setTeamsError('');
    try {
      const r = await fetch(`/api/admin/calling-teams?process=${encodeURIComponent(key)}&includeInactive=1`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setTeamsError(d.error || `Could not load teams (${r.status})`); return; }
      setTeams(d.teams || []);
    } catch (e) {
      setTeamsError(e.message || 'Could not load teams');
    }
  }, []);

  // Same "fetched for everyone signed in, endpoint decides" shape as processAgents/
  // processDispositions above - a plain agent's GET here 403s (they don't administer the
  // process at all), which just leaves teams null and the card renders nothing for them.
  useEffect(() => {
    if (googleUser?.email) loadTeams(processKey);
  }, [googleUser, processKey, loadTeams]);

  const createTeam = async () => {
    const name = newTeamName.trim();
    const sheetId = newTeamSheetId.trim();
    // sheetTab is intentionally NOT trimmed before it leaves this function - the live NDR tab
    // is literally named 'Latest NDR ' with a significant trailing space, and trimming it here
    // would silently produce a range string the Sheets API can't resolve. Only the leading/
    // trailing whitespace a human typed by mistake around the whole field is worth stripping,
    // and that's exactly what .trim() on the OUTER value below does - never on the value itself.
    const sheetTab = newTeamSheetTab;
    if (!name || !sheetId || !sheetTab.trim()) {
      setTeamsError('Name, Sheet ID and Sheet Tab are all required');
      return;
    }
    setSavingTeam(true);
    setTeamsError('');
    try {
      const r = await fetch('/api/admin/calling-teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, name, sheetId, sheetTab }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not create team (${r.status})`;
        setTeamsError(msg);
        if (showToast) showToast(`⚠️ ${msg}`);
        return;
      }
      setNewTeamName(''); setNewTeamSheetId(''); setNewTeamSheetTab('');
      await loadTeams(processKey);
      if (showToast) showToast(`✅ Team "${d.team?.name || name}" created`);
    } catch (e) {
      const msg = e.message || 'Could not create team';
      setTeamsError(msg);
      if (showToast) showToast(`⚠️ ${msg}`);
    } finally {
      setSavingTeam(false);
    }
  };

  // active is the only field this UI ever toggles post-creation - renaming a team or repointing
  // its sheet mid-flight is a bigger, rarer decision than this card's scope, and the PUT
  // endpoint already supports it server-side if that's ever needed from a script or a future
  // edit form.
  const setTeamActive = async (id, active) => {
    setSavingTeam(true);
    setTeamsError('');
    try {
      const r = await fetch('/api/admin/calling-teams', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not update team (${r.status})`;
        setTeamsError(msg);
        if (showToast) showToast(`⚠️ ${msg}`);
        return;
      }
      await loadTeams(processKey);
    } catch (e) {
      const msg = e.message || 'Could not update team';
      setTeamsError(msg);
      if (showToast) showToast(`⚠️ ${msg}`);
    } finally {
      setSavingTeam(false);
    }
  };

  return {
    teams, teamsError, savingTeam,
    newTeamName, setNewTeamName, newTeamSheetId, setNewTeamSheetId, newTeamSheetTab, setNewTeamSheetTab,
    createTeam, setTeamActive,
  };
}

export function CallingTeamsCard({ processKey, processLabel, teamsHook, sessionIsAdmin }) {
  const {
    teams, teamsError, savingTeam,
    newTeamName, setNewTeamName, newTeamSheetId, setNewTeamSheetId, newTeamSheetTab, setNewTeamSheetTab,
    createTeam, setTeamActive,
  } = teamsHook;

  // Not loaded (still null) or the endpoint 403'd this caller (an agent with no admin role on
  // this process) - either way, nothing useful to show. A process admin who simply has zero
  // teams yet still gets an empty array, which DOES render (the create form, if they're also a
  // full admin), so this only hides the card from someone who was never going to see teams here.
  if (!teams) return null;

  const activeCount = teams.filter((t) => t.active).length;

  return (
    <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 shadow-xl backdrop-blur-md">
      <div className="flex items-start gap-3 mb-1">
        <span className="h-9 w-9 shrink-0 rounded-xl bg-indigo-950/60 border border-indigo-800/60 flex items-center justify-center text-indigo-300">👥</span>
        <div>
          <h2 className="text-lg font-bold text-zinc-100">
            Teams &mdash; {processLabel}
          </h2>
          <p className="text-[13px] text-zinc-500">
            {activeCount === 0
              ? 'No active team yet - everyone below shares one pool and one sheet, exactly as before this feature.'
              : activeCount === 1
                ? '1 active team - still one shared pool. Isolation between team leads switches on the moment a second team is active.'
                : `${activeCount} active teams - roster, metrics and sheet access are isolated between them. Assign each agent a team in the roster table below.`}
          </p>
        </div>
      </div>

      {teamsError && (
        <p className="mt-3 text-[13px] text-rose-400 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">
          {teamsError}
        </p>
      )}

      {teams.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {teams.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-950/40 border border-zinc-800/60 px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-zinc-200">{t.name}</span>
                  {!t.active && (
                    <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500 bg-zinc-800/80 border border-zinc-700/60 rounded-md px-1.5 py-0.5">Paused</span>
                  )}
                </div>
                {/* sheetId/sheetTab are only present when the server trusts this caller with them
                    (a full admin) - a process admin who is not a full admin sees the name only,
                    matching what the roster's own Team dropdown shows them. */}
                {sessionIsAdmin && t.sheetId && (
                  <p className="text-zinc-500 text-[11px] font-mono truncate max-w-md" title={`${t.sheetId} · tab "${t.sheetTab}"`}>
                    {t.sheetId}
                  </p>
                )}
              </div>
              {sessionIsAdmin && (
                <button
                  onClick={() => setTeamActive(t.id, !t.active)}
                  disabled={savingTeam}
                  className={`shrink-0 h-7 px-3 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-40 ${
                    t.active
                      ? 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300'
                      : 'bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/60'
                  }`}
                  title={t.active ? 'Pause this team - agents on it can no longer read or upload to its sheet until reactivated' : 'Reactivate this team'}
                >
                  {t.active ? 'Pause' : 'Reactivate'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Creating a team means handing an admin-typed Sheet ID to a service account with Editor
          access on real spreadsheets - full-admin only, both here and (independently) enforced
          server-side, so this form simply doesn't render for a process admin who isn't also a
          full admin rather than rendering a control that would only 403. */}
      {sessionIsAdmin && (
        <div className="mt-4 pt-4 border-t border-zinc-800/80">
          <div className="text-[12px] text-zinc-500 mb-2 font-medium">Add a team</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">Name</span>
              <input
                type="text"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="e.g. Team North"
                className="w-40 h-8 px-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">Google Sheet ID</span>
              <input
                type="text"
                value={newTeamSheetId}
                onChange={(e) => setNewTeamSheetId(e.target.value)}
                placeholder="the id from the sheet's URL, not the full URL"
                className="w-64 h-8 px-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg text-[13px] text-zinc-200 font-mono placeholder:text-zinc-600 placeholder:font-sans focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">Sheet Tab</span>
              <input
                type="text"
                value={newTeamSheetTab}
                onChange={(e) => setNewTeamSheetTab(e.target.value)}
                placeholder="e.g. Latest NDR "
                className="w-40 h-8 px-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg text-[13px] text-zinc-200 font-mono placeholder:text-zinc-600 placeholder:font-sans focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </label>
            <button
              onClick={createTeam}
              disabled={savingTeam || !newTeamName.trim() || !newTeamSheetId.trim() || !newTeamSheetTab.trim()}
              className="h-8 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-bold transition-colors shadow-md shadow-indigo-950/50 disabled:opacity-40"
            >
              {savingTeam ? 'Adding…' : 'Add team'}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-zinc-600">
            The sheet must already be shared with the app&apos;s service account as Editor, and its header row must match the existing NDR sheet layout exactly - both are checked when someone next uploads to it, not here.
          </p>
        </div>
      )}
    </div>
  );
}

// Per-process disposition TREE (see calling_process_dispositions) - arbitrary nesting,
// [{id,label,description,sortOrder,children:[...]}]. Reloaded whenever the caller's processKey
// changes, same reasoning as processAgents in useCallingSession: each process's list is its own.
// RTO's disposition options stay its hardcoded connectedOutcomes/unreachableOutcomes arrays and
// never touch this endpoint - this only backs a process (NDR today) with no built-in list.
export function useProcessDispositions(processKey, { googleUser, showToast, teamId = null } = {}) {
  const [processDispositions, setProcessDispositions] = useState(null); // null = not loaded yet
  const [dispositionsError, setDispositionsError] = useState('');
  const [savingDisposition, setSavingDisposition] = useState(false);
  const [newDispLabel, setNewDispLabel] = useState('');
  const [newDispDesc, setNewDispDesc] = useState('');
  // Which top-level options are expanded to show their children - a Set of ids, empty by
  // default (collapsed), same "closed until you open it" convention as the reference UI.
  const [expandedDispIds, setExpandedDispIds] = useState(() => new Set());
  // One draft {label, description} per parent id, so "add a child" inputs under two different
  // expanded parents never share state or clobber each other.
  const [newChildDrafts, setNewChildDrafts] = useState({});

  const loadDispositions = useCallback(async (key, team) => {
    if (!key) return;
    setProcessDispositions(null);
    setDispositionsError('');
    try {
      // teamId is honoured server-side only for a full admin - an agent or team lead gets their
      // own team's tree regardless of what is sent here, so this is a UI affordance, not a
      // permission.
      const teamQuery = team != null ? `&teamId=${encodeURIComponent(team)}` : '';
      const r = await fetch(`/api/admin/dispositions?process=${encodeURIComponent(key)}${teamQuery}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setDispositionsError(d.error || `Could not load dispositions (${r.status})`); return; }
      setProcessDispositions(d.dispositions || []);
    } catch (e) {
      setDispositionsError(e.message || 'Could not load dispositions');
    }
  }, []);

  // Fetched for everyone signed in, same as processAgents - the endpoint itself 403s a process
  // the caller doesn't administer, and this stays a lightweight no-op for a process (RTO) whose
  // disposition list never reads from here, rather than an empty admin-only card.
  useEffect(() => {
    if (googleUser?.email) loadDispositions(processKey, teamId);
  }, [googleUser, processKey, teamId, loadDispositions]);

  const toggleDispExpanded = (id) => {
    setExpandedDispIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // parentId omitted/null adds a top-level option (reads newDispLabel/newDispDesc); passed adds
  // a child under that parent instead (reads newChildDrafts[parentId]).
  const addDisposition = async (parentId) => {
    const draft = parentId ? (newChildDrafts[parentId] || { label: '', description: '' }) : { label: newDispLabel, description: newDispDesc };
    const label = draft.label.trim();
    if (!label) return;
    setSavingDisposition(true);
    setDispositionsError('');
    try {
      const r = await fetch('/api/admin/dispositions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, label, description: draft.description.trim(), parentId: parentId || undefined, ...(teamId != null ? { teamId } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not add option (${r.status})`;
        setDispositionsError(msg);
        if (showToast) showToast(`⚠️ ${msg}`);
        return;
      }
      setProcessDispositions(d.dispositions || []);
      if (parentId) {
        setNewChildDrafts((prev) => ({ ...prev, [parentId]: { label: '', description: '' } }));
        setExpandedDispIds((prev) => new Set(prev).add(parentId)); // stay open after adding
      } else {
        setNewDispLabel('');
        setNewDispDesc('');
      }
    } catch (e) {
      const msg = e.message || 'Could not add option';
      setDispositionsError(msg);
      if (showToast) showToast(`⚠️ ${msg}`);
    } finally {
      setSavingDisposition(false);
    }
  };

  // Inline-editable, no separate edit mode: each row's label/description inputs are
  // uncontrolled (defaultValue, not value) and commit on blur only if actually changed.
  // patch is whichever of {label, description} changed.
  const saveDispositionEdit = async (id, patch) => {
    setSavingDisposition(true);
    setDispositionsError('');
    try {
      const r = await fetch('/api/admin/dispositions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, id, ...patch, ...(teamId != null ? { teamId } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not save (${r.status})`;
        setDispositionsError(msg);
        if (showToast) showToast(`⚠️ ${msg}`);
        return;
      }
      setProcessDispositions(d.dispositions || []);
    } catch (e) {
      const msg = e.message || 'Could not save disposition';
      setDispositionsError(msg);
      if (showToast) showToast(`⚠️ ${msg}`);
    } finally {
      setSavingDisposition(false);
    }
  };

  const deleteDisposition = async (id) => {
    setSavingDisposition(true);
    setDispositionsError('');
    try {
      const r = await fetch('/api/admin/dispositions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, id, ...(teamId != null ? { teamId } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not delete (${r.status})`;
        setDispositionsError(msg);
        if (showToast) showToast(`⚠️ ${msg}`);
        return;
      }
      setProcessDispositions(d.dispositions || []);
    } catch (e) {
      const msg = e.message || 'Could not delete disposition';
      setDispositionsError(msg);
      if (showToast) showToast(`⚠️ ${msg}`);
    } finally {
      setSavingDisposition(false);
    }
  };

  // Optimistic swap-then-confirm: the reorder feels instant, and reverts to the server's own
  // order (via loadDispositions) if the request actually fails rather than leaving the UI
  // showing an order that was never saved. parentId null/omitted reorders the top-level list;
  // passed, reorders that ONE parent's children only - the two scopes never mix, so moving a
  // child up/down can't accidentally touch a top-level option's position.
  const moveDisposition = async (list, index, direction, parentId) => {
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= list.length) return;
    const next = [...list];
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    setProcessDispositions((prevTree) =>
      parentId ? prevTree.map((p) => (p.id === parentId ? { ...p, children: next } : p)) : next
    );
    setSavingDisposition(true);
    try {
      const r = await fetch('/api/admin/dispositions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey, orderedIds: next.map((x) => x.id), parentId: parentId || undefined, ...(teamId != null ? { teamId } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not reorder (${r.status})`;
        setDispositionsError(msg);
        if (showToast) showToast(`⚠️ ${msg}`);
        loadDispositions(processKey, teamId);
        return;
      }
      setProcessDispositions(d.dispositions || []);
    } catch (e) {
      const msg = e.message || 'Could not reorder';
      setDispositionsError(msg);
      if (showToast) showToast(`⚠️ ${msg}`);
      loadDispositions(processKey, teamId);
    } finally {
      setSavingDisposition(false);
    }
  };

  return {
    processDispositions, dispositionsError, savingDisposition,
    newDispLabel, setNewDispLabel, newDispDesc, setNewDispDesc,
    expandedDispIds, toggleDispExpanded, newChildDrafts, setNewChildDrafts,
    addDisposition, saveDispositionEdit, deleteDisposition, moveDisposition,
    teamId,
  };
}

// One row, reused at every depth (depth 0 = top-level option, depth 1 = child, depth 2 =
// grandchild, ...). Label/description are uncontrolled (defaultValue) and commit on blur only
// if changed, so typing never round-trips to the server per keystroke. `list` is whichever
// sibling array d belongs to (the top-level array, or one parent's .children), needed for the
// up/down bounds and to send the right reorder scope.
function DispRow({ d, list, index, parentId, depth, disp }) {
  const { expandedDispIds, toggleDispExpanded, savingDisposition, saveDispositionEdit, moveDisposition, deleteDisposition } = disp;
  return (
    <div className="rounded-xl bg-zinc-950/40 border border-zinc-800/60 px-3 py-2" style={depth ? { marginLeft: depth * 32 } : undefined}>
      <div className="flex items-center gap-2">
        <span className="text-zinc-600 select-none text-[13px]" title="Reorder with the ↑↓ buttons">⋮⋮</span>
        <span className="inline-flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg pl-2 pr-1 py-1 shrink-0 w-[220px]">
          <span className="text-indigo-400 text-[12px] shrink-0">🏷️</span>
          <input
            key={`label-${d.id}`}
            defaultValue={d.label}
            maxLength={120}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (!v) { e.target.value = d.label; return; }
              if (v !== d.label) saveDispositionEdit(d.id, { label: v });
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-200 focus:outline-none"
          />
        </span>
        <button
          onClick={() => toggleDispExpanded(d.id)}
          className="shrink-0 h-7 px-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-emerald-400 text-[11px] font-bold transition-colors flex items-center gap-1"
          title={expandedDispIds.has(d.id) ? 'Collapse' : 'Expand to view/add child options'}
        >
          {d.children.length} {d.children.length === 1 ? 'child' : 'children'}
          <span>{expandedDispIds.has(d.id) ? '⌄' : '›'}</span>
        </button>
        <input
          key={`desc-${d.id}`}
          defaultValue={d.description}
          placeholder="Description (optional)"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== d.description) saveDispositionEdit(d.id, { description: v });
          }}
          className="min-w-0 flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-[12px] text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
        />
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => moveDisposition(list, index, -1, parentId)}
            disabled={savingDisposition || index === 0}
            title="Move up"
            className="h-7 w-7 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-[12px] font-bold transition-colors disabled:opacity-30"
          >
            ↑
          </button>
          <button
            onClick={() => moveDisposition(list, index, 1, parentId)}
            disabled={savingDisposition || index === list.length - 1}
            title="Move down"
            className="h-7 w-7 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-[12px] font-bold transition-colors disabled:opacity-30"
          >
            ↓
          </button>
          <button
            onClick={() => {
              const childNote = d.children.length ? ` and its ${d.children.length} child option(s)` : '';
              if (window.confirm(`Delete "${d.label}"${childNote}?`)) deleteDisposition(d.id);
            }}
            disabled={savingDisposition}
            title="Delete"
            className="h-7 w-7 rounded-lg bg-rose-950/60 hover:bg-rose-900/60 text-rose-300 text-[12px] font-semibold transition-colors"
          >
            🗑
          </button>
        </div>
      </div>
    </div>
  );
}

// Recursive: renders d's own row, then (if expanded) every child at depth+1 plus an "add child"
// input scoped to d - so any option, at any depth, can grow its own sub-options the same way a
// top-level one does.
function DispNode({ d, list, index, parentId, depth, disp, allowInputTypeControl }) {
  const { expandedDispIds, newChildDrafts, setNewChildDrafts, addDisposition, savingDisposition, saveDispositionEdit } = disp;
  const childrenInputType = d.childrenInputType || 'single';
  return (
    <div key={d.id}>
      <DispRow d={d} list={list} index={index} parentId={parentId} depth={depth} disp={disp} />
      {expandedDispIds.has(d.id) && (
        <div className="mt-1.5 space-y-1.5">
          {allowInputTypeControl && (
            <div className="flex items-center gap-2" style={{ marginLeft: (depth + 1) * 32 }}>
              <span className="w-[13px]" />
              <label className="text-[11px] font-semibold text-zinc-500">Children answer type:</label>
              <select
                value={childrenInputType}
                onChange={(e) => saveDispositionEdit(d.id, { childrenInputType: e.target.value })}
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              >
                <option value="single">Single choice (buttons)</option>
                <option value="multi">Multiple choice (checkboxes)</option>
                <option value="text">Free text</option>
              </select>
            </div>
          )}
          {d.children.map((c, ci) => (
            <DispNode key={c.id} d={c} list={d.children} index={ci} parentId={d.id} depth={depth + 1} disp={disp} allowInputTypeControl={allowInputTypeControl} />
          ))}
          {childrenInputType === 'text' ? (
            <p className="text-[12px] text-zinc-500" style={{ marginLeft: (depth + 1) * 32 + 13 }}>
              Agents type free text here - no child options to add.
            </p>
          ) : (
            <div className="flex items-center gap-2" style={{ marginLeft: (depth + 1) * 32 }}>
              <span className="w-[13px]" />
              <input
                value={(newChildDrafts[d.id] || {}).label || ''}
                onChange={(e) => setNewChildDrafts((prev) => ({ ...prev, [d.id]: { label: e.target.value, description: (prev[d.id] || {}).description || '' } }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (newChildDrafts[d.id] || {}).label?.trim()) addDisposition(d.id); }}
                placeholder="New child option"
                maxLength={120}
                className="w-[220px] bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <input
                value={(newChildDrafts[d.id] || {}).description || ''}
                onChange={(e) => setNewChildDrafts((prev) => ({ ...prev, [d.id]: { label: (prev[d.id] || {}).label || '', description: e.target.value } }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (newChildDrafts[d.id] || {}).label?.trim()) addDisposition(d.id); }}
                placeholder="Description (optional)"
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-[12px] text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <button
                onClick={() => addDisposition(d.id)}
                disabled={savingDisposition || !(newChildDrafts[d.id] || {}).label?.trim()}
                className="h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[12px] font-bold transition-colors disabled:opacity-50 shrink-0"
              >
                + Add child
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Admin-defined disposition list for a process with no hardcoded one of its own (see
// calling_process_dispositions) - "highly customisable" per the ask: an admin can add, rename,
// describe, nest (any depth), reorder, and remove options freely, with no seeded default and no
// fixed count. disp = a useProcessDispositions() return value; processLabel = display name.
export function ProcessDispositionsCard({ processLabel, disp, allowInputTypeControl = false, teamName = '' }) {
  const { processDispositions, dispositionsError, savingDisposition, newDispLabel, setNewDispLabel, newDispDesc, setNewDispDesc, addDisposition, teamId } = disp;
  return (
    <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 shadow-xl backdrop-blur-md">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 shrink-0 rounded-xl bg-violet-950/60 border border-violet-800/60 flex items-center justify-center text-violet-300">🏷️</span>
          <div>
            <h2 className="text-lg font-bold text-zinc-100">
              Disposition List{processLabel ? ` — ${processLabel}` : ''}
              {/* Which tree this card edits. Without it an admin switching teams cannot tell
                  whose list they just changed - the one thing per-team trees make possible to
                  get wrong. */}
              {teamId != null && <span className="text-zinc-400 font-medium"> · {teamName || `Team #${teamId}`}</span>}
            </h2>
            <p className="text-[13px] text-zinc-500">
              What an agent may select when disposing a lead on this process. Unlike RTO Calling
              (a fixed, built-in list), this one starts empty - add whatever this process needs.
              Expand an option to give it its own child reasons.
            </p>
          </div>
        </div>
        <button
          onClick={() => addDisposition()}
          disabled={savingDisposition || !newDispLabel.trim()}
          className="h-8 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-bold transition-colors shadow-md shadow-indigo-950/50 disabled:opacity-50 shrink-0"
        >
          {savingDisposition ? 'Adding…' : '+ Add Option'}
        </button>
      </div>

      {dispositionsError && (
        <p className="mt-3 text-[13px] text-rose-400 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">
          {dispositionsError}
        </p>
      )}

      <div className="mt-4 space-y-1.5">
        {processDispositions === null ? (
          <p className="text-[13px] text-zinc-500">Loading…</p>
        ) : processDispositions.length === 0 ? (
          <p className="text-[13px] text-zinc-500">No options added yet - use &quot;+ Add Option&quot; below to add the first one.</p>
        ) : processDispositions.map((d, i) => (
          <DispNode key={d.id} d={d} list={processDispositions} index={i} parentId={null} depth={0} disp={disp} allowInputTypeControl={allowInputTypeControl} />
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-zinc-800/60 flex items-center gap-2">
        <input
          value={newDispLabel}
          onChange={e => setNewDispLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newDispLabel.trim()) addDisposition(); }}
          placeholder="New top-level option"
          maxLength={120}
          className="w-[220px] bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
        />
        <input
          value={newDispDesc}
          onChange={e => setNewDispDesc(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newDispLabel.trim()) addDisposition(); }}
          placeholder="Description (optional)"
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-[12px] text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
        />
      </div>
    </div>
  );
}
