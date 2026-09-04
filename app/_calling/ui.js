'use client';

// Shared, process-agnostic UI primitives used by every Calling process page - icons, dropdown
// components, and small presentational wrappers. Nothing here reads or writes anything
// RTO/NDR-specific; each page passes in its own options/labels/content.

import { useState, useEffect, useRef, useMemo } from 'react';

export const SearchIcon = (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>;
export const XIcon = (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;
export const CheckIcon = (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>;
export const PhoneIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.76.32 1.54.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c1.27.38 2.05.58 2.81.7A2 2 0 0 1 22 16.92z"/></svg>;
export const WhatsAppIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2zm0 18.06h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.16 8.16 0 0 1-1.26-4.38c0-4.52 3.68-8.2 8.21-8.2 2.19 0 4.25.86 5.8 2.4a8.15 8.15 0 0 1 2.4 5.8c0 4.53-3.68 8.24-8.16 8.24zm4.5-6.16c-.25-.12-1.46-.72-1.68-.8-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.96-.14.16-.29.18-.53.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.24-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.16.04-.31-.02-.43-.06-.12-.56-1.36-.77-1.86-.2-.49-.41-.42-.56-.43h-.48c-.16 0-.43.06-.65.31-.23.24-.85.83-.85 2.04 0 1.2.87 2.36.99 2.52.12.16 1.71 2.6 4.14 3.65.58.25 1.03.4 1.38.51.58.18 1.11.16 1.53.1.47-.07 1.46-.6 1.66-1.17.21-.58.21-1.08.15-1.18-.06-.1-.22-.16-.47-.28z"/></svg>;
export const RefreshIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>;
export const DownloadIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>;
export const ChevronDown = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m6 9 6 6 6-6"/></svg>;
export const UserIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
export const CalendarIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>;
export const CreditCardIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>;
export const ChatIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
export const ShieldIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
export const SparklesIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z"/></svg>;

export function CustomSelect({ value, onChange, options, icon: IconComponent, placeholder, className = "" }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setIsOpen(false); };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOpt = options.find(o => String(o.value) === String(value)) || options[0];

  return (
    <div className={`relative inline-block ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="h-8 px-3 py-1 bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded-lg text-[13px] font-medium text-zinc-200 flex items-center justify-between gap-2.5 transition-all shadow-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
      >
        <div className="flex items-center gap-2 truncate">
          {IconComponent && <IconComponent className="text-zinc-400 shrink-0" />}
          <span className="truncate">{selectedOpt ? selectedOpt.label : placeholder}</span>
        </div>
        <ChevronDown className={`text-zinc-500 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180 text-indigo-400' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-1.5 min-w-[160px] w-full max-w-xs bg-[#141417] border border-zinc-800/90 rounded-xl shadow-2xl z-50 overflow-hidden animate-fadeIn py-1 custom-scroll max-h-60 overflow-y-auto">
          {options.map((opt) => {
            const isSelected = String(opt.value) === String(value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setIsOpen(false); }}
                className={`w-full text-left px-3 py-2 text-[13px] flex items-center justify-between gap-2 hover:bg-zinc-800/70 transition-colors ${isSelected ? 'bg-indigo-950/40 text-indigo-300 font-semibold' : 'text-zinc-300'}`}
              >
                <span className="truncate flex items-center gap-2">
                  {opt.icon && <span>{opt.icon}</span>}
                  {opt.label}
                </span>
                {isSelected && <CheckIcon className="text-indigo-400 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Multi-select dropdown for a Team Roster column where an agent can specialize in more than one
// value at once (e.g. RTO's "Priority Reasons" - the stored value is a comma-separated string,
// matched as independent substrings by the assignment script). value/onChange work in terms of
// a string[]; the caller owns joining/splitting against whatever's actually persisted.
// groupBy (optional): opt => category name. When given, options are rendered under clickable
// category headers instead of one flat list - the RTO roster's Priority Reasons picker uses
// api/_lib/rtoReasonCategory's categorizeRtoReason so its headings match the Overview tab's
// RTO-reason breakdown. Clicking a header selects/clears that whole category at once. The
// VALUE is unchanged either way: still the individual raw reason strings, because that is what
// build_assignment_queue substring-matches against - a category name would match nothing.
// groupOrder (optional): category names in display order; any category not listed follows, in
// first-seen order, so a new keyword bucket can never silently vanish from the list.
export function MultiSelectDropdown({ value, onChange, options, placeholder = 'None', groupBy, groupOrder, itemNoun = 'reasons', disabled = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setIsOpen(false); };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selected = value || [];
  const label = selected.length === 0 ? placeholder : selected.length === 1 ? selected[0] : `${selected.length} ${itemNoun}`;
  const toggle = (opt) => {
    onChange(selected.includes(opt) ? selected.filter(o => o !== opt) : [...selected, opt]);
  };
  // [[category, opts]] preserving groupOrder first, then first-seen order for the rest.
  // Null (not an empty list) when ungrouped, so the flat render path below stays untouched.
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const byCat = new Map((groupOrder || []).map(c => [c, []]));
    for (const opt of options) {
      const cat = groupBy(opt);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(opt);
    }
    return [...byCat].filter(([, opts]) => opts.length);
  }, [options, groupBy, groupOrder]);
  // Header click: clear the group if every member is already selected, else add the missing
  // ones. Add (not replace) so selections in other groups survive.
  const toggleGroup = (opts) => {
    const all = opts.every(o => selected.includes(o));
    onChange(all ? selected.filter(o => !opts.includes(o)) : [...selected, ...opts.filter(o => !selected.includes(o))]);
  };
  // Select-all, grouped mode only. The ungrouped callers are the NDR roster's Attempts picker,
  // whose own 'All' option already means unrestricted (see ndrAttemptFilterOnChange) - a second
  // select-all there would be two controls for one idea. toggleGroup over every option, so it
  // clears only when literally everything is on.
  const allOptionsSelected = options.length > 0 && options.every(o => selected.includes(o));

  return (
    <div className="relative inline-block w-44" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        title={disabled ? 'Only a Team Leader can edit tags' : selected.join(', ')}
        className={`w-full h-8 px-3 py-1 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[13px] font-medium text-zinc-200 flex items-center justify-between gap-2 transition-all shadow-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/40 ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-800 hover:border-zinc-700'}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={`text-zinc-500 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180 text-indigo-400' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-1.5 min-w-[240px] bg-[#141417] border border-zinc-800/90 rounded-xl shadow-2xl z-50 overflow-hidden animate-fadeIn py-1 custom-scroll max-h-60 overflow-y-auto">
          {groups && (
            <button
              type="button"
              onClick={() => toggleGroup(options)}
              title={allOptionsSelected ? 'Clear every reason' : `Select all ${options.length} reasons, every category`}
              className="sticky top-0 z-10 w-full text-left px-3 py-2 text-[12px] font-semibold flex items-center justify-between gap-2 bg-[#141417] border-b border-zinc-800/80 hover:bg-zinc-800/70 transition-colors text-zinc-200"
            >
              <span className="flex items-center gap-2">
                <span className={`h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center ${allOptionsSelected ? 'bg-indigo-600 border-indigo-600' : selected.length ? 'border-indigo-500' : 'border-zinc-600'}`}>
                  {allOptionsSelected ? <CheckIcon className="text-white" style={{ width: 10, height: 10 }} />
                    : selected.length ? <span className="h-0.5 w-2 rounded-full bg-indigo-400" /> : null}
                </span>
                {allOptionsSelected ? 'Clear all' : 'All categories'}
              </span>
              <span className="shrink-0 text-zinc-600 font-normal">{selected.length}/{options.length}</span>
            </button>
          )}
          {(groups || [[null, options]]).map(([cat, opts]) => (
            <div key={cat || '_'}>
              {cat && (() => {
                // Tri-state, like a file-tree parent: ticked when the whole category is on, a
                // dash when only part of it is, empty otherwise. Without the dash a partly-picked
                // category is indistinguishable from an untouched one at a glance.
                const hit = opts.filter(o => selected.includes(o)).length;
                return (
                  <button
                    type="button"
                    onClick={() => toggleGroup(opts)}
                    title={`Select / clear all ${opts.length} reasons in ${cat}`}
                    className="w-full text-left px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 hover:text-indigo-300 hover:bg-zinc-800/50 transition-colors flex items-center justify-between gap-2"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center ${hit === opts.length ? 'bg-indigo-600 border-indigo-600' : hit > 0 ? 'border-indigo-500' : 'border-zinc-600'}`}>
                        {hit === opts.length ? <CheckIcon className="text-white" style={{ width: 10, height: 10 }} />
                          : hit > 0 ? <span className="h-0.5 w-2 rounded-full bg-indigo-400" /> : null}
                      </span>
                      <span className="truncate">{cat}</span>
                    </span>
                    <span className="shrink-0 text-zinc-600">{hit}/{opts.length}</span>
                  </button>
                );
              })()}
              {opts.map((opt) => {
                const isSelected = selected.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => toggle(opt)}
                    className={`w-full text-left ${cat ? 'pl-7 pr-3' : 'px-3'} py-2 text-[12.5px] flex items-center gap-2 hover:bg-zinc-800/70 transition-colors ${isSelected ? 'text-indigo-300 font-semibold' : 'text-zinc-300'}`}
                  >
                    <span className={`h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-zinc-600'}`}>
                      {isSelected && <CheckIcon className="text-white" style={{ width: 10, height: 10 }} />}
                    </span>
                    <span className="truncate">{opt}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Badge({ children, color = 'zinc' }) {
  const c = { zinc: 'bg-zinc-800/80 text-zinc-300 border-zinc-700/80', blue: 'bg-blue-950/60 text-blue-300 border-blue-800/60', amber: 'bg-amber-950/50 text-amber-300 border-amber-800/50', green: 'bg-emerald-950/50 text-emerald-300 border-emerald-800/50', red: 'bg-rose-950/50 text-rose-300 border-rose-800/50', indigo: 'bg-indigo-950/50 text-indigo-300 border-indigo-800/50' };
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-medium border ${c[color] || c.zinc}`}>{children}</span>;
}

export function Overlay({ children, onClose }) {
  return (<div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
    <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
    <div className="relative animate-slideUp max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>{children}</div>
  </div>);
}

export function EmptyState({ title, sub }) {
  return (<div className="flex flex-col items-center justify-center py-20 text-center">
    <div className="w-16 h-16 rounded-2xl bg-zinc-800/60 flex items-center justify-center mb-4"><SearchIcon className="text-zinc-500 w-8 h-8" /></div>
    <p className="text-sm font-semibold text-zinc-300 mb-1">{title}</p>
    <p className="text-xs text-zinc-500 max-w-xs">{sub}</p>
  </div>);
}

// Result pill for the CSV-upload modals (app/rto-crm/RtoUploadModal.js,
// app/ndr-calling/NdrUploadModal.js) - lives here rather than in either one so the two upload
// flows cannot drift apart visually.
const STAT_TONE = {
  ok: 'bg-emerald-950/50 text-emerald-300 border-emerald-800/50',
  skip: 'bg-amber-950/50 text-amber-300 border-amber-800/50',
  neutral: 'bg-zinc-800/80 text-zinc-300 border-zinc-700/80',
};

export function Stat({ tone = 'neutral', children }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-[12px] font-medium border ${STAT_TONE[tone]}`}>
      {children}
    </span>
  );
}

