// Shared, pure helpers used by every Calling process page (app/rto-crm, app/ndr-calling, and
// whatever comes next) - date-scope filtering, IST time-of-day math, and display formatting.
// Nothing here is process-specific; each page supplies its own rows/state and calls these the
// same way. See app/_calling/ui.js for the shared UI primitives (CustomSelect, Overlay, etc.).

// Next.js still server-renders a "use client" page once for the initial HTML, where
// `localStorage` doesn't exist. Every callsite already treats a missing/empty value as "no
// stored value yet" (that's what a first-ever page load already looked like), so a no-op shim
// on the server reproduces that exact behavior without touching any callsite.
export const safeStorage = typeof window !== 'undefined'
  ? window.localStorage
  : { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export function startOfDay(d) {
  if (!d) return null;
  const x = new Date(d);
  if (isNaN(x.getTime())) return null;
  x.setHours(0, 0, 0, 0);
  return x;
}

export function parseDate(s) {
  if (!s || typeof s !== 'string') return null;
  const str = s.trim();
  if (!str || str === '—') return null;

  // 1. Try "22 Jul" or "22 July 2026"
  const p = str.split(/\s+/);
  if (p.length >= 2) {
    const day = parseInt(p[0]);
    const ms = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = ms.indexOf(p[1].toLowerCase().slice(0, 3));
    if (!isNaN(day) && mi !== -1) {
      const year = p.length >= 3 && !isNaN(parseInt(p[2])) ? parseInt(p[2]) : new Date().getFullYear();
      return startOfDay(new Date(year, mi, day));
    }
  }

  // 2. Try "22/07/2026" or "22-07-2026" or "22.07.2026"
  const parts = str.split(/[\/\.-]/);
  if (parts.length === 3) {
    const p1 = parseInt(parts[0]), p2 = parseInt(parts[1]), p3 = parseInt(parts[2]);
    if (!isNaN(p1) && !isNaN(p2) && !isNaN(p3)) {
      let year, month, day;
      if (p3 > 1000) {
        year = p3;
        if (p2 <= 12 && p1 <= 31) { day = p1; month = p2 - 1; }
        else { day = p2; month = p1 - 1; }
      } else if (p1 > 1000) {
        year = p1; month = p2 - 1; day = p3;
      } else {
        year = new Date().getFullYear();
        day = p1; month = p2 - 1;
      }
      const testDate = new Date(year, month, day);
      if (!isNaN(testDate.getTime())) return startOfDay(testDate);
    }
  }

  // 3. Standard JS Date constructor fallback
  let d = new Date(str);
  if (!isNaN(d.getTime())) return startOfDay(d);
  return null;
}

export function isDateInScope(rowDate, scope, customFrom, customTo) {
  if (scope === 'ALL_TIME') return true;
  if (!rowDate) return true;
  const now = new Date(), today = startOfDay(now), rd = startOfDay(rowDate);
  if (scope === 'TODAY') return rd.getTime() === today.getTime();
  if (scope === 'YESTERDAY') { const y = new Date(today); y.setDate(y.getDate() - 1); return rd.getTime() === y.getTime(); }
  if (scope === '7_DAYS') return (now.getTime() - rowDate.getTime()) / (1000 * 3600 * 24) <= 7;
  if (scope === '30_DAYS') return (now.getTime() - rowDate.getTime()) / (1000 * 3600 * 24) <= 30;
  if (scope === 'CUSTOM') {
    if (!customFrom && !customTo) return true;
    if (customFrom && rd.getTime() < startOfDay(new Date(customFrom)).getTime()) return false;
    if (customTo && rd.getTime() > startOfDay(new Date(customTo)).getTime()) return false;
    return true;
  }
  return true;
}

// 'YYYY-MM-DD' -> a plain YYYY-MM-DD string, local calendar day (no timezone conversion -
// toISOString() would shift the date across midnight for anyone not at UTC+0).
export function toDateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Translates a page's own dateScope selector into concrete {dateFrom, dateTo} 'YYYY-MM-DD'
// bounds (or undefined for an open end), for /api/auth/presence's dateFrom/dateTo query params -
// so Logged In At / Total Break Time follow the SAME filter every other Overview column does,
// instead of always meaning "today". 7_DAYS/30_DAYS are approximated as calendar-day windows
// here (today minus N days, through today) rather than isDateInScope's own rolling
// now-minus-N-hours math - close enough for an attendance summary, and a lot simpler than
// threading sub-day precision through a date-only API param.
export function scopeToDateBounds(scope, customFrom, customTo) {
  const today = new Date();
  if (scope === 'ALL_TIME') return { dateFrom: undefined, dateTo: undefined };
  if (scope === 'TODAY') return { dateFrom: toDateStr(today), dateTo: toDateStr(today) };
  if (scope === 'YESTERDAY') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    return { dateFrom: toDateStr(y), dateTo: toDateStr(y) };
  }
  if (scope === '7_DAYS' || scope === '30_DAYS') {
    const back = new Date(today); back.setDate(back.getDate() - (scope === '7_DAYS' ? 7 : 30));
    return { dateFrom: toDateStr(back), dateTo: toDateStr(today) };
  }
  if (scope === 'CUSTOM') return { dateFrom: customFrom || undefined, dateTo: customTo || undefined };
  return { dateFrom: undefined, dateTo: undefined };
}

// Trim + uppercase, so a stray space or case difference between a sheet's own order/AWB key and
// Postgres's stored key doesn't silently fail to match.
export function normalizeOrderKey(orderNumber) {
  return (orderNumber || '').toString().trim().toUpperCase();
}

// Like isDateInScope, but for a lead's REAL assigned_at/disposed_at timestamp rather than its
// own sheet-column date. Works for either date field - same "missing" semantics apply to both:
// deliberately NOT a branch inside isDateInScope itself, because the two kinds of date disagree
// on what a missing value means. isDateInScope treats a missing rowDate as "always in scope" (a
// bad/blank sheet date shouldn't vanish from every report). A lead can have no assigned_at/
// disposed_at at all - assigned or disposed before this tracking existed, or done straight in
// the sheet rather than through this app's own disposal call - and for these fields that's
// treated the opposite way: excluded from every date-scoped view (nothing real to filter by),
// except ALL_TIME, which by definition applies no date filter to anything.
export function isLeadDateInScope(dateIso, scope, customFrom, customTo) {
  if (scope === 'ALL_TIME') return true;
  if (!dateIso) return false;
  return isDateInScope(new Date(dateIso), scope, customFrom, customTo);
}

// Same fixed UTC+5:30 offset convention used throughout this app (assign_leads.py's
// within_business_hours, api/_lib/db.js's istMinutesSinceMidnight/istDayKey) - client-side
// equivalents, since some time-of-day figures are computed in the browser rather than by the
// backend.
export const IST_OFFSET_MS_CLIENT = (5 * 60 + 30) * 60 * 1000;
export function istMinutesSinceMidnightClient(date) {
  return Math.floor((date.getTime() + IST_OFFSET_MS_CLIENT) / 60000) % (24 * 60);
}
export function istDayKeyClient(date) {
  return Math.floor((date.getTime() + IST_OFFSET_MS_CLIENT) / 86400000);
}

// Formats a "minutes since IST midnight" integer as a wall-clock time - shared by every
// time-of-day column in an Agent Performance Summary table (Logged In At, First Called At): NOT
// an ISO timestamp, because for a multi-day date-scope each is an AVERAGE across days, which can
// only be expressed as a time-of-day, not a specific instant on any one calendar day. No
// timezone conversion needed here - the value is already in IST minutes by the time it reaches
// this function. '—' when nothing was logged within the current date-scope filter at all.
export function formatTimeOfDay(mins) {
  if (mins === null || mins === undefined) return '—';
  const m = ((Math.round(mins) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h24 = Math.floor(m / 60), rem = m % 60;
  const ampm = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(rem).padStart(2, '0')} ${ampm}`;
}

// breakMinutes (a plain integer from the same endpoint - already averaged per active day for a
// multi-day scope) -> "1h 12m" / "45m" / "0m".
export function formatBreakMinutes(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  const h = Math.floor(m / 60), rem = m % 60;
  return h > 0 ? `${h}h ${rem}m` : `${rem}m`;
}

// FRT (First Response Time) column - same "Xh Ym" rendering as formatBreakMinutes, but '—' when
// there's nothing to average (formatBreakMinutes' own null->0 fallback would read as "instant
// response", which is wrong here).
export function formatFrt(mins) {
  return (mins === null || mins === undefined) ? '—' : formatBreakMinutes(mins);
}

// count/total*100, rounded, as "N%" - '—' when the denominator is 0 (nothing to divide), same
// fail-open-to-dash convention formatTimeOfDay's '—' already uses.
export function formatPct(count, total) {
  if (!total) return '—';
  return `${Math.round((count / total) * 100)}%`;
}
