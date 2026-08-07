'use client';

// Admin-surface pieces shared by every Calling process page: the business-hours editor and the
// admin-configurable disposition-tree editor. Both are already fully generic (parameterized by
// processKey, nothing RTO-specific baked in) - RTO itself never renders ProcessDispositionsCard
// (it keeps its own hardcoded connectedOutcomes/unreachableOutcomes arrays), but CallingHoursCard
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

// Per-process disposition TREE (see calling_process_dispositions) - arbitrary nesting,
// [{id,label,description,sortOrder,children:[...]}]. Reloaded whenever the caller's processKey
// changes, same reasoning as processAgents in useCallingSession: each process's list is its own.
// RTO's disposition options stay its hardcoded connectedOutcomes/unreachableOutcomes arrays and
// never touch this endpoint - this only backs a process (NDR today) with no built-in list.
export function useProcessDispositions(processKey, { googleUser, showToast } = {}) {
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

  const loadDispositions = useCallback(async (key) => {
    if (!key) return;
    setProcessDispositions(null);
    setDispositionsError('');
    try {
      const r = await fetch(`/api/admin/dispositions?process=${encodeURIComponent(key)}`);
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
    if (googleUser?.email) loadDispositions(processKey);
  }, [googleUser, processKey, loadDispositions]);

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
        body: JSON.stringify({ processKey, label, description: draft.description.trim(), parentId: parentId || undefined }),
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
        body: JSON.stringify({ processKey, id, ...patch }),
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
        body: JSON.stringify({ processKey, id }),
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
        body: JSON.stringify({ processKey, orderedIds: next.map((x) => x.id), parentId: parentId || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || `Could not reorder (${r.status})`;
        setDispositionsError(msg);
        if (showToast) showToast(`⚠️ ${msg}`);
        loadDispositions(processKey);
        return;
      }
      setProcessDispositions(d.dispositions || []);
    } catch (e) {
      const msg = e.message || 'Could not reorder';
      setDispositionsError(msg);
      if (showToast) showToast(`⚠️ ${msg}`);
      loadDispositions(processKey);
    } finally {
      setSavingDisposition(false);
    }
  };

  return {
    processDispositions, dispositionsError, savingDisposition,
    newDispLabel, setNewDispLabel, newDispDesc, setNewDispDesc,
    expandedDispIds, toggleDispExpanded, newChildDrafts, setNewChildDrafts,
    addDisposition, saveDispositionEdit, deleteDisposition, moveDisposition,
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
function DispNode({ d, list, index, parentId, depth, disp }) {
  const { expandedDispIds, newChildDrafts, setNewChildDrafts, addDisposition, savingDisposition } = disp;
  return (
    <div key={d.id}>
      <DispRow d={d} list={list} index={index} parentId={parentId} depth={depth} disp={disp} />
      {expandedDispIds.has(d.id) && (
        <div className="mt-1.5 space-y-1.5">
          {d.children.map((c, ci) => (
            <DispNode key={c.id} d={c} list={d.children} index={ci} parentId={d.id} depth={depth + 1} disp={disp} />
          ))}
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
        </div>
      )}
    </div>
  );
}

// Admin-defined disposition list for a process with no hardcoded one of its own (see
// calling_process_dispositions) - "highly customisable" per the ask: an admin can add, rename,
// describe, nest (any depth), reorder, and remove options freely, with no seeded default and no
// fixed count. disp = a useProcessDispositions() return value; processLabel = display name.
export function ProcessDispositionsCard({ processLabel, disp }) {
  const { processDispositions, dispositionsError, savingDisposition, newDispLabel, setNewDispLabel, newDispDesc, setNewDispDesc, addDisposition } = disp;
  return (
    <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 shadow-xl backdrop-blur-md">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 shrink-0 rounded-xl bg-violet-950/60 border border-violet-800/60 flex items-center justify-center text-violet-300">🏷️</span>
          <div>
            <h2 className="text-lg font-bold text-zinc-100">
              Disposition List{processLabel ? ` — ${processLabel}` : ''}
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
          <DispNode key={d.id} d={d} list={processDispositions} index={i} parentId={null} depth={0} disp={disp} />
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
