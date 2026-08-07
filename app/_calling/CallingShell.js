'use client';

// Shared page chrome for every Calling process page: the sticky header (logo/title/last-sync/
// Refresh/role switcher/status dropdown), the toast, and the "a newer version of this app is
// available" banner. Everything process-specific (search box, process switcher, whatever else
// sits next to Refresh) is passed in via `rightSlot` rather than owned here.
import { CustomSelect, RefreshIcon, ShieldIcon, CheckIcon } from './ui';
import { ROLE_OPTIONS, STATUS_OPTIONS } from './useCallingSession';

// session = a useCallingSession() return value. lastSync/syncing/syncError/onSync are the
// calling page's OWN sync state (each process syncs its own sheet/table on its own cadence),
// not part of the shared session hook.
export function CallingShell({
  logoLabel = 'RTO',
  title,
  lastSync, syncing, syncError, onSync,
  session,
  onSetStatus,
  onSwitchRole,
  rightSlot,
  children,
}) {
  const { sessionIsAdmin, userRole, setUserRole, agentStatus, toast, updateAvailable } = session;
  return (
    <>
      {/* ═══ CLEAN TOP UTILITY HEADER ═══ */}
      <header className="sticky top-0 z-30 bg-[#09090b]/95 backdrop-blur-xl border-b border-zinc-800/80">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 min-h-13 py-2 flex items-center justify-between flex-wrap gap-2 sm:gap-4">

          {/* Header Title & Branding */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white font-extrabold text-xs shadow-md shadow-indigo-950/50">
              {logoLabel}
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-extrabold text-zinc-100 tracking-tight flex items-center gap-2 truncate">
                <span className="truncate">{title}</span>
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

          {/* Header Controls: process-specific extras (rightSlot), Sync, Role Switcher, Status */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 flex-wrap justify-end">
            {rightSlot}

            <button onClick={() => onSync(false)} disabled={syncing} className="h-8 px-2.5 sm:px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50 shrink-0" title={`Refresh ${title} data`}>
              <RefreshIcon className={syncing ? 'animate-spin text-indigo-400' : ''} />
              <span className="hidden md:inline">{syncing ? 'Syncing…' : 'Refresh'}</span>
            </button>

            {/* UI Role Switcher - hidden for genuine Agents, who have no legitimate reason to
                switch into Admin/Team Lead view (setUserRole is a plain client-side state
                change with no server-side check, so this is the only gate). Gated on the
                underlying account, NOT on the current userRole - otherwise a real admin who
                switches into "Agent" view to preview it would lose the only control that
                switches them back. Keyed on the session's own isAdmin (users.is_admin,
                re-read from the database on every request), not a hardcoded email match.
                onSwitchRole defaults to the hook's own setUserRole, but a caller with its own
                side effects on top (see RTO's handleSwitchRole) passes that wrapper instead. */}
            {sessionIsAdmin && (
              <CustomSelect
                value={userRole}
                onChange={onSwitchRole || setUserRole}
                options={ROLE_OPTIONS}
                icon={ShieldIcon}
                className="shrink-0"
              />
            )}

            {/* Custom Status Dropdown - onSetStatus defaults to the shared hook's own setStatus,
                but a caller with its own activity-log/broadcast side effects on top (see RTO's
                handleSetStatus) passes that wrapper instead. */}
            <CustomSelect
              value={agentStatus}
              onChange={onSetStatus || session.setStatus}
              options={STATUS_OPTIONS}
              className="shrink-0"
            />
          </div>
        </div>
      </header>

      {/* ═══ TOAST ═══ */}
      {toast && <div className="fixed top-16 right-5 z-50 animate-slideUp"><div className="px-4 py-2.5 rounded-xl bg-zinc-800/90 text-zinc-100 border border-zinc-700 text-[13px] shadow-2xl flex items-center gap-2.5 backdrop-blur-md"><CheckIcon className="text-emerald-400 shrink-0" />{toast}</div></div>}

      {/* ═══ NEW VERSION BANNER — this tab is running stale JS, a newer deploy exists ═══ */}
      {updateAvailable && (
        <div className="bg-amber-950/95 backdrop-blur-xl border-b border-amber-800/60">
          <div className="max-w-[1440px] mx-auto px-5 py-2 flex items-center justify-between gap-3">
            <span className="text-[13px] text-amber-200 font-medium flex items-center gap-2">
              <RefreshIcon className="text-amber-400 shrink-0" />
              A newer version of this app is available. Refresh to make sure your leads sync correctly.
            </span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 text-[12px] font-bold transition-colors shadow-xs shrink-0"
            >
              Refresh Now
            </button>
          </div>
        </div>
      )}

      {children}
    </>
  );
}
