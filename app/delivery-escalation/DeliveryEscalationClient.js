'use client';

// Delivery-Escalation's own independent workspace - modeled on app/ndr-calling/NdrCallingClient.js
// (claim a row, record a resolution). Deliberately NOT built on the shared
// app/_calling/useCallingSession.js: this process has no Postgres-backed roster, presence,
// quota, business hours, or round-robin assignment robot - see
// api/_lib/callingProcesses.json's "deliveryescalation" entry for why. It DOES reuse one piece of
// app/_calling/CallingAdminPanel.js - useProcessDispositions/ProcessDispositionsCard, the same
// admin-configurable disposition tree NDR's Admin Panel uses - since an outcome list an admin can
// shape without a code change is worth the one Postgres table (calling_process_dispositions) it
// costs; CallingHoursCard and the roster table are NOT used, on purpose. Access is still gated the
// same way everything else in this app is: report_tab_permissions, checked server-side by
// api/delivery-escalation/sheet.js and api/delivery-escalation/record.js.
//
// One data source: MySQL PEP_CLS.Delivery_escalation, via api/delivery-escalation/record.js.
// Outcome blank/RTO/Escalated is Fresh, outcome Delivered is Resolved, and claim/dispose write
// straight to that row - no sheet cell involved, same model as the RTO calling process's own
// CLS_RTO_calling table. The Google Sheet is no longer read here at all: it still feeds this
// table (the 2-hourly cron mirror, scripts/sync_delivery_tickets_to_sheet.py), but nothing on
// this page depends on reading it back.
//
// Paging, filtering and searching all happen SERVER-side (see db.js's own header comment). The
// browser holds one page of rows, never the whole table - which is what keeps the response
// inside Lambda's 6MB cap however large this table grows. There is no per-agent row scoping:
// everyone invited to this process sees the whole shared desk, admin or not, since tickets are
// self-claimed from a common unassigned pool - the Agent filter narrows the view by choice.
import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { CustomSelect, MultiSelectDropdown, CheckIcon, XIcon, RefreshIcon, Overlay } from '../_calling/ui';
import { useProcessDispositions, ProcessDispositionsCard } from '../_calling/CallingAdminPanel';
import { safeStorage } from '../_calling/util';

const BRANDS = ['HYPHEN', 'mCaffeine'];
const PAYMENT_MODES = ['Prepaid', 'COD'];
// Same repeat-contact buckets getDeliveryEscalationRepeatStats already groups by (see db.js) -
// reusing them here rather than inventing a second bucketing keeps "how many times did this
// customer come" meaning one thing everywhere on this page.
const CONTACT_BUCKET_OPTIONS = [
  { value: 'ALL', label: 'Total times user came' },
  { value: '1', label: '1 time' },
  { value: '2-4', label: '2-4 times' },
  { value: '5-9', label: '5-9 times' },
  { value: '10+', label: '10+ times' },
];
// Quick date-range presets for the filter bar, shared by every tab (Fresh/Forced RTO/Resolved/
// New Order Placed all render the same filter row - see the `listTab` block below).
const DATE_RANGE_PRESET_OPTIONS = [
  { value: 'all', label: 'All Dates' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'custom', label: 'Custom' },
];
const CARD_KEY = 'calling';
const TAB_KEY = 'deliveryescalation';
// report_tab_permissions card_key for the Tab Access column (see api/admin/[action].js's own
// DE_TAB_CARD_KEY comment) - deliberately its own card_key, never TAB_KEY above, so it can't
// collide with the deliveryescalation PROCESS grant that already lives under CARD_KEY='calling'.
const DE_TAB_CARD_KEY = 'deliveryescalation-tabs';
// MultiSelectDropdown (app/_calling/ui.js) renders its options AS its stored values - no
// separate {value,label} shape, unlike CustomSelect - so the admin picker below shows/picks
// these display labels and expands back to the plain tab_key on save (DE_TAB_LABEL_TO_KEY),
// same expand-on-save/collapse-on-load convention canonicalPartnerOptions already uses.
const DE_TAB_LABELS = {
  overview: '📊 Overview',
  fresh: '⚡ Fresh',
  forced_rto: '↩️ Forced RTO',
  resolved: '✅ Resolved',
  new_order_placed: '🆕 New Order Placed',
};
const DE_TAB_LABEL_TO_KEY = Object.fromEntries(Object.entries(DE_TAB_LABELS).map(([k, v]) => [v, k]));
const DE_TAB_OPTIONS = Object.values(DE_TAB_LABELS);

// One shared mapping for both tabs - the same SELECT backs Fresh and Resolved (see db.js's
// DE_SELECT_COLUMNS), so there's no reason for two row shapes. readOnly is the only thing that
// differs: a Resolved ticket is already Delivered, so there's nothing left to action on it.
function mapRow(row, readOnly) {
  return {
    id: row.id, mysqlId: row.id, readOnly,
    brand: row.brand, orderId: row.order_id, awb: row.awb_code || '',
    deliveryPartner: row.delivery_partner || '', queryClass: row.query_class || '',
    queryCategory: row.query_category || '',
    statusAsPerAwb: row.status_as_per_awb || '', tat: row.tat || '',
    ticketNumber: row.ticket_number || '', assignedAgent: row.agent_email || '',
    addedDate: row.added_date ? new Date(row.added_date).toLocaleDateString('en-GB') : '',
    orderDate: row.order_date ? new Date(row.order_date).toLocaleDateString('en-GB') : '',
    actionDate: row.disposed_at ? new Date(row.disposed_at).toLocaleDateString('en-GB') : '',
    outcome: row.outcome || '', childDisposition: row.child_disposition || '',
    remarks: row.agent_remarks || '',
    tatBucket: row.tat_bucket || '',
    // How many tickets share this AWB, and when the customer FIRST came about it - both are
    // aggregates maintained by the sync (see scripts/delivery_escalation_contact_stats.py),
    // not properties of this row alone.
    contactCount: row.contact_count == null ? '' : row.contact_count,
    firstContactDate: row.first_added_date ? new Date(row.first_added_date).toLocaleDateString('en-GB') : '',
    // Reshipped order's own AWB - New Order Placed tab only (see its own bulk-upload note below).
    newOrderAwb: row.new_order_awb || '',
  };
}

// Every column after Brand, for one ticket row - shared between a group's parent row and its
// collapsed timeline children (see groupedTicketRows) so the two can never drift out of sync
// with each other or with the column headers above them.
function ticketRowCells(t, tab, openAction, isChild) {
  return (
    <>
      <td className="py-3 px-4 text-zinc-300 font-mono text-[12px]">{t.orderId}</td>
      <td className="py-3 px-4 text-zinc-300 font-mono text-[12px]">{t.awb}</td>
      {tab === 'new_order_placed' && <td className="py-3 px-4 text-zinc-300 font-mono text-[12px]">{t.newOrderAwb || '—'}</td>}
      <td className="py-3 px-4 text-zinc-400">{t.deliveryPartner}</td>
      <td className="py-3 px-4 text-zinc-400">{t.queryCategory}</td>
      <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">{t.addedDate || '—'}</td>
      <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">{t.orderDate || '—'}</td>
      <td className="py-3 px-4 text-zinc-400">{t.tat}</td>
      <td className="py-3 px-4 text-zinc-400 tabular-nums">
        {t.contactCount === '' ? '—' : (
          <span className={t.contactCount > 1 ? 'text-amber-400 font-semibold' : ''}>
            {t.contactCount}{t.contactCount > 1 ? '×' : ''}
          </span>
        )}
      </td>
      <td className="py-3 px-4 text-zinc-400">{t.firstContactDate || '—'}</td>
      <td className="py-3 px-4 text-zinc-400 text-[12px]">{t.assignedAgent ? t.assignedAgent.split('@')[0] : '—'}</td>
      <td className="py-3 px-4 text-zinc-400">{t.outcome || '—'}</td>
      <td className="py-3 px-4 text-zinc-400">{t.childDisposition || '—'}</td>
      {(tab === 'resolved' || tab === 'new_order_placed') && <td className="py-3 px-4 text-zinc-400">{t.actionDate}</td>}
      {(tab === 'resolved' || tab === 'new_order_placed') && <td className="py-3 px-4 text-zinc-400 max-w-xs truncate" title={t.remarks}>{t.remarks}</td>}
      {(tab === 'resolved' || tab === 'new_order_placed') && <td className="py-3 px-4 text-zinc-400">{t.tatBucket}</td>}
      <td className="py-3 px-4 text-right">
        {/* Resolving is a parent-only action - a child is the same ticket-cascade target
            saveAction already updates when its parent is disposed (see db.js's
            disposeDeliveryEscalationTicketById), not something to action separately. */}
        {isChild ? (
          <span className="text-zinc-600 text-[12px]">—</span>
        ) : (
          <button
            onClick={() => openAction(t)}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-semibold transition-all active:scale-95"
          >
            {t.readOnly ? 'View' : t.outcome ? 'View / Edit' : 'Resolve'}
          </button>
        )}
      </td>
    </>
  );
}

// record.js's own catch puts the real exception message in the body - surface that rather than
// a bare status code, so a failure is diagnosable from the error banner alone without needing
// Lambda CloudWatch access.
async function getJson(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

// 'YYYY-MM-DD' (what op=daywise returns) -> 'Jul 10, 2026' for the day-wise TAT table.
function formatDaywiseDate(d) {
  if (!d) return d;
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// { y, m, d } of "today" in IST (Asia/Kolkata), regardless of the browser's own timezone -
// matches the backend's own IST calendar-day convention for date filters (see api/_lib/db.js's
// dateBounds). en-CA formats as 'YYYY-MM-DD', the one locale that does by default.
function istTodayParts() {
  const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
  return { y, m, d };
}
// y/m/d as plain numbers (m is 1-12, either can be out of its normal range) -> 'YYYY-MM-DD'.
// Built on Date.UTC, never the browser's local timezone, specifically so day=0/month=-1 etc.
// normalize (day 0 = last day of the previous month) without any manual carry logic, and so this
// never drifts by the browser's own UTC offset the way `new Date(dateStr)` would.
function ymd(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}
// Presets for DATE_RANGE_PRESET_OPTIONS above - returns { from, to } (YYYY-MM-DD), or null for
// 'all'/'custom' (both leave the current from/to alone: 'all' is cleared by the caller instead,
// 'custom' is the agent typing both ends by hand).
function dateRangeForPreset(preset) {
  const { y, m, d } = istTodayParts();
  const todayStr = ymd(y, m, d);
  switch (preset) {
    case 'today': return { from: todayStr, to: todayStr };
    case 'yesterday': { const t = ymd(y, m, d - 1); return { from: t, to: t }; }
    case 'this_month': return { from: ymd(y, m, 1), to: todayStr };
    case 'last_month': return { from: ymd(y, m - 1, 1), to: ymd(y, m, 0) };
    default: return null;
  }
}

// The exact string checkAccess() in record.js/sheet.js sends when getSession(req) comes back
// null - a cookie that expired (7-day Max-Age; this page is the kind of tab an agent leaves
// open for days) or was cleared, NOT a permission problem. Distinguishing it matters: every
// other failure here is worth retrying (a blip, a slow query), but this one never recovers on
// its own - retrying just repeats "Not authenticated" every 15-60s forever with no way for the
// agent to tell that from a real outage. See sessionExpired below for what happens once this
// is seen.
const AUTH_ERROR_MESSAGE = 'Not authenticated';
function isSessionExpired(err) {
  return err?.message === AUTH_ERROR_MESSAGE;
}

// Sums a set of day-level {counts, total} entries (already computed server-side per day) into
// one aggregate, recomputing pct against THIS group's own total - the same "% of this row's own
// total" rule the day rows already use, just applied at whichever level is being summed.
function sumDaywiseRows(dayRows, buckets) {
  const counts = {};
  buckets.forEach((b) => { counts[b] = 0; });
  let total = 0;
  for (const r of dayRows) {
    buckets.forEach((b) => { counts[b] += r.counts[b] || 0; });
    total += r.total;
  }
  const pct = Object.fromEntries(buckets.map((b) => [b, total ? Math.round((counts[b] / total) * 100) : 0]));
  return { counts, total, pct };
}

// Heatmap shading for a % cell, shared by every pct column in both TAT tables - 0% stays plain,
// higher % ramps up an indigo tint (same accent as the tables' own hover/link color) and switches
// to light text once the background gets dark enough to need it.
function pctHeatStyle(pct) {
  const v = Math.max(0, Math.min(100, pct || 0));
  if (v === 0) return undefined;
  const alpha = 0.12 + (v / 100) * 0.55;
  return { backgroundColor: `rgba(99, 102, 241, ${alpha})`, color: alpha > 0.4 ? '#e4e4e7' : undefined };
}

// Buckets a flat list of {date, counts, total} rows (all within one month) into Week-of-month ->
// Day. Week is "days 1-7 of the month = week 1, 8-14 = week 2, ..." rather than a calendar/ISO
// week (which can straddle two months) - it keeps every week fully nested inside one month.
// keyPrefix scopes week.key to whichever partner/month this batch of days belongs to, so two
// partners' own "Week 1" never collide in the expandedWeeks Set.
function buildWeeksOfMonth(dayRows, buckets, keyPrefix) {
  const weeks = new Map();
  for (const r of dayRows) {
    const weekOfMonth = Math.ceil(Number(r.date.split('-')[2]) / 7);
    if (!weeks.has(weekOfMonth)) weeks.set(weekOfMonth, { weekOfMonth, days: [] });
    weeks.get(weekOfMonth).days.push(r);
  }
  return [...weeks.values()].sort((a, b) => a.weekOfMonth - b.weekOfMonth).map((week) => {
    const days = [...week.days].sort((a, b) => a.date.localeCompare(b.date));
    return { ...week, key: `${keyPrefix}-W${week.weekOfMonth}`, days, ...sumDaywiseRows(days, buckets) };
  });
}

// Buckets a flat list of {date, counts, total} rows into Month -> Week-of-month -> Day.
// keyPrefix scopes month/week keys so the same helper serves both the plain date table and,
// nested one level under a partner for groupPartnerwiseRows below, the partner-wise table -
// two different partners' (or a partner's vs. the plain table's own) "2026-07" never collide
// in expandedMonths/expandedWeeks.
function buildMonthsFromDayRows(dayRows, buckets, keyPrefix = '') {
  const months = new Map();
  for (const r of dayRows) {
    const [y, m] = r.date.split('-').map(Number);
    const monthKey = `${keyPrefix}${y}-${String(m).padStart(2, '0')}`;
    if (!months.has(monthKey)) months.set(monthKey, { key: monthKey, days: [] });
    months.get(monthKey).days.push(r);
  }
  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key)).map((month) => {
    const weeks = buildWeeksOfMonth(month.days, buckets, month.key);
    return { key: month.key, days: month.days, weeks, ...sumDaywiseRows(month.days, buckets) };
  });
}

// Groups the flat day-level rows the server returns into Month -> Week-of-month -> Day, purely
// client-side, for the plain date table (no partner nesting - see groupPartnerwiseRows below for
// that breakdown as its own table).
function groupDaywiseRows(dayRows, buckets) {
  return buildMonthsFromDayRows(dayRows, buckets);
}

// delivery_partner is the raw shipping_courier string (many account/vendor variants per real
// courier - "DLSRF_Direct", "HYP_DELHIVERY", "Delhivery Air" are all Delhivery). This collapses
// them to one canonical name for the partner-wise table below; anything not in the map (a new
// courier code that hasn't been mapped yet, or 'Unknown' from a null delivery_partner) falls
// through as its own raw value rather than disappearing.
const PARTNER_NAME_MAP = {
  AIRTRANS: 'AIRTRANS',
  ATS___AMAZON_TRANSPORT_SERVICES___: 'ATS',
  'Blue Dart': 'Blue Dart',
  'Blue Dart Air': 'Blue Dart',
  'Blue Dart Brand Air': 'Blue Dart',
  'Blue Dart Surface': 'Blue Dart',
  'Bluedart brands 500 g Surface': 'Blue Dart',
  'Bluedart Surface - Select  500gm': 'Blue Dart',
  'Bluedart Surface - Select 500gm': 'Blue Dart',
  'Bluedart Surface 500 gms- Select': 'Blue Dart',
  'SR Bluedart': 'Blue Dart',
  'Bluedart': 'Blue Dart',
  Cuberooteeine: 'PurpleDrone',
  CuberooteKatalyst: 'PurpleDrone',
  CuberooteMcaffeine: 'PurpleDrone',
  DELHIVERY: 'DELHIVERY',
  Delhivery: 'DELHIVERY',
  'Delhivery NDD': 'DELHIVERY',
  'Delhivery Air': 'DELHIVERY',
  'Delhivery Surface': 'DELHIVERY',
  Delhivery_Air: 'DELHIVERY',
  Delhivery_Direct: 'DELHIVERY',
  DELHIVERY_SMYTTEN: 'DELHIVERY',
  DLSRF_Direct: 'DELHIVERY',
  Dlv_Direct_Air: 'DELHIVERY',
  DTDC: 'DTDC',
  'DTDC Surface': 'DTDC',
  'DTDC Surface 10kg': 'DTDC',
  DTDC_Surface_Direct: 'DTDC',
  DTDC_Surface_Direct_HYP: 'DTDC',
  'Ekart Logistics Surface': 'Ekart',
  Elasticrun: 'ElasticRun',
  'ElasticRun SDD': 'ElasticRun',
  Elasticrun_direct_H: 'ElasticRun',
  Elasticrun_direct_M: 'ElasticRun',
  HYP_DELHIVERY: 'DELHIVERY',
  pidge: 'Pidge',
  Pidge_Omnivio: 'Pidge',
  Pikndel: 'Pikndel',
  Pikendle: 'Pikndel',
  'Pikndel NDD': 'Pikndel',
  Pikndel_H_SDD: 'Pikndel',
  Pikndel_M_SDD: 'Pikndel',
  Purpledrone_mCaff: 'PurpleDrone',
  Shadowfax: 'Shadowfax',
  'Shadowfax Heavy 10Kg': 'Shadowfax',
  'Shadowfax Intercity NDD': 'Shadowfax',
  'Shadowfax NDD': 'Shadowfax',
  'Shadowfax Surface': 'Shadowfax',
  SHADOWFAX_DIRECT: 'Shadowfax',
  SHADOWFAX_DIRECT_HYP: 'Shadowfax',
  Shadowfax_H_NDD: 'Shadowfax',
  Shadowfax_H_SDD: 'Shadowfax',
  Shadowfax_M_NDD: 'Shadowfax',
  Shadowfax_M_SDD: 'Shadowfax',
  'Shadowfax_NDD/SDD': 'Shadowfax',
  SITICS_LOGISTICS_TRAIN: 'STICS',
  XB_AIR: 'Xpressbees',
  'XBSRF_ Air_Direct': 'Xpressbees',
  XBSRF_Direct: 'Xpressbees',
  XBSRF_Direct_NDD: 'Xpressbees',
  XBSRF_Direct_NDD_HYPHEN: 'Xpressbees',
  Xpressbees: 'Xpressbees',
  'Xpressbees 2kg': 'Xpressbees',
  'Xpressbees Surface': 'Xpressbees',
  Xpressbees_Direct: 'Xpressbees',
  XPRESSBEES_DIRECT_HYP: 'Xpressbees',
  Xpressbees_NDD: 'Xpressbees',
  Pikndel_M_Rapid: 'Pikndel',
  DELHIVERY_NDD_MDIRECT: 'DELHIVERY',
  'Blitz Intercity NDD': 'Blitz',
  'Blitz Intercity Metro NDD': 'Blitz',
  'Blitz NDD': 'Blitz',
  XpressbeesAir_Direct: 'Xpressbees',
  Pikndel_H_NDD: 'Pikndel',
  Pikndel_H_Rapid: 'Pikndel',
  DELHIVERY_NDD_DIRECT_H: 'DELHIVERY',
};

function mapPartnerName(raw) {
  const key = (raw || '').trim();
  return PARTNER_NAME_MAP[key] || key;
}

// canonical partner name -> every raw shipping_courier value that folds into it, so the Partner
// filter dropdown can show ~9 clean names while the server still filters delivery_partner (the
// raw column) - see fetchDaywiseStats, which sends this list rather than the canonical name.
const CANONICAL_TO_RAW_PARTNER = Object.entries(PARTNER_NAME_MAP).reduce((m, [raw, canon]) => {
  (m[canon] = m[canon] || []).push(raw);
  return m;
}, {});
const PARTNER_FILTER_OPTIONS = [...new Set(Object.values(PARTNER_NAME_MAP))].sort();

// Several raw couriers can fold into the same final partner (see PARTNER_NAME_MAP) - if two of
// them fire on the same date, sums them into one row per date rather than leaving two rows that
// would collide on the same React key when the day level renders.
function mergeDayRowsByDate(rows, buckets) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) {
      byDate.set(r.date, { date: r.date, counts: Object.fromEntries(buckets.map((b) => [b, 0])), total: 0 });
    }
    const entry = byDate.get(r.date);
    buckets.forEach((b) => { entry.counts[b] += r.counts[b] || 0; });
    entry.total += r.total;
  }
  return [...byDate.values()].map((entry) => ({
    ...entry,
    pct: Object.fromEntries(buckets.map((b) => [b, entry.total ? Math.round((entry.counts[b] / entry.total) * 100) : 0])),
  }));
}

// Each date row carries its own partner split (r.partners, from the server) - this re-groups by
// final partner (after mapPartnerName folds raw courier variants together), then Month ->
// Week-of-month -> Day underneath, for a standalone partner-wise TAT table.
function groupPartnerwiseRows(dayRows, buckets) {
  const partners = new Map();
  for (const r of dayRows) {
    for (const p of (r.partners || [])) {
      const partner = mapPartnerName(p.partner);
      if (!partners.has(partner)) partners.set(partner, []);
      partners.get(partner).push({ date: r.date, counts: p.counts, total: p.total });
    }
  }
  return [...partners.entries()].map(([partner, partnerDayRows]) => {
    const merged = mergeDayRowsByDate(partnerDayRows, buckets);
    const months = buildMonthsFromDayRows(merged, buckets, `${partner}::`);
    return { key: partner, partner, months, ...sumDaywiseRows(merged, buckets) };
  }).sort((a, b) => b.total - a.total);
}

// Each date row carries its own query_category split (r.categories, from the server, same shape
// as r.partners) - re-summed here straight from a month's own day rows (no further Week/Day
// nesting - shown flat under the expanded month, unlike the partner breakdown which is its own
// standalone table).
function categoryBreakdownForDays(days, buckets) {
  const byCategory = new Map();
  for (const r of days) {
    for (const c of (r.categories || [])) {
      if (!byCategory.has(c.category)) byCategory.set(c.category, []);
      byCategory.get(c.category).push({ counts: c.counts, total: c.total });
    }
  }
  return [...byCategory.entries()]
    .map(([category, rows]) => ({ category, ...sumDaywiseRows(rows, buckets) }))
    .sort((a, b) => b.total - a.total);
}

// One category's own Week -> Day breakdown, re-derived from the month's day rows the same way
// categoryBreakdownForDays sums the flat total - here each day's r.categories entry for this
// category (or a zero row if the category didn't fire that day) feeds buildWeeksOfMonth, so an
// expanded category gets the same drill chain as the month itself.
function buildCategoryWeeks(days, category, buckets, keyPrefix) {
  const dayRows = days.map((r) => {
    const cat = (r.categories || []).find((c) => c.category === category);
    return { date: r.date, counts: cat ? cat.counts : Object.fromEntries(buckets.map((b) => [b, 0])), total: cat ? cat.total : 0 };
  });
  return buildWeeksOfMonth(mergeDayRowsByDate(dayRows, buckets), buckets, keyPrefix).filter((week) => week.total > 0);
}

// Each date row carries its own query_category split (r.categories) - same re-grouping
// groupPartnerwiseRows does for partners (Month -> Week -> Day underneath), for a standalone
// Query Class TAT table.
function groupCategorywiseRows(dayRows, buckets) {
  const categories = new Map();
  for (const r of dayRows) {
    for (const c of (r.categories || [])) {
      if (!categories.has(c.category)) categories.set(c.category, []);
      categories.get(c.category).push({ date: r.date, counts: c.counts, total: c.total });
    }
  }
  return [...categories.entries()].map(([category, rows]) => {
    const merged = mergeDayRowsByDate(rows, buckets);
    const months = buildMonthsFromDayRows(merged, buckets, `${category}::`);
    return { key: category, category, months, ...sumDaywiseRows(merged, buckets) };
  }).sort((a, b) => b.total - a.total);
}

// Natural 1 -> 2-4 -> 5-9 -> 10+ order (an ordinal scale), not by total - unlike partner/category
// this dimension has a real order the reader expects, same labels
// getDeliveryEscalationRepeatStats/DE_CONTACT_BUCKET_SQL already use.
const CONTACT_BUCKET_ORDER = ['1 time', '2-4 times', '5-9 times', '10+ times'];

// Each date row carries its own repeat-contact split (r.contactBuckets, from the server, same
// shape as r.partners/r.categories) - same re-grouping groupPartnerwiseRows does for partners,
// for a standalone "how many times did the customer come" TAT table.
function groupContactBucketwiseRows(dayRows, buckets) {
  const contactBuckets = new Map();
  for (const r of dayRows) {
    for (const c of (r.contactBuckets || [])) {
      if (!contactBuckets.has(c.contactBucket)) contactBuckets.set(c.contactBucket, []);
      contactBuckets.get(c.contactBucket).push({ date: r.date, counts: c.counts, total: c.total });
    }
  }
  return [...contactBuckets.entries()].map(([contactBucket, rows]) => {
    const merged = mergeDayRowsByDate(rows, buckets);
    const months = buildMonthsFromDayRows(merged, buckets, `${contactBucket}::`);
    return { key: contactBucket, contactBucket, months, ...sumDaywiseRows(merged, buckets) };
  }).sort((a, b) => CONTACT_BUCKET_ORDER.indexOf(a.contactBucket) - CONTACT_BUCKET_ORDER.indexOf(b.contactBucket));
}

// One contact bucket's own Delivery Partner breakdown, Month -> Week -> Day underneath - same
// re-grouping groupPartnerwiseRows does from r.partners directly, just sourced from that
// bucket's own nested partner split (r.contactBuckets[].partners, from the server) so Repeat
// Contacts can drill Times Contacted -> Delivery Partner -> Month/Week/Day instead of straight
// to Month. `label` (not `partner`) so TatBreakdownTable's sub-row rendering stays generic.
function groupContactBucketPartnerwiseRows(dayRows, buckets, contactBucket) {
  const partners = new Map();
  for (const r of dayRows) {
    const cb = (r.contactBuckets || []).find((c) => c.contactBucket === contactBucket);
    for (const p of (cb?.partners || [])) {
      const partner = mapPartnerName(p.partner);
      if (!partners.has(partner)) partners.set(partner, []);
      partners.get(partner).push({ date: r.date, counts: p.counts, total: p.total });
    }
  }
  return [...partners.entries()].map(([partner, rows]) => {
    const merged = mergeDayRowsByDate(rows, buckets);
    const months = buildMonthsFromDayRows(merged, buckets, `${contactBucket}::${partner}::`);
    return { key: `${contactBucket}::${partner}`, label: partner, months, ...sumDaywiseRows(merged, buckets) };
  }).sort((a, b) => b.total - a.total);
}

function formatDaywiseMonth(monthKey) {
  const plain = monthKey.includes('::') ? monthKey.split('::').pop() : monthKey;
  const [y, m] = plain.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// "Week 2 (Jul 8-14)" - the day range read off the week's own first/last day rather than a
// fixed 7-day span, since a month's final week is often shorter.
function formatDaywiseWeek(week) {
  const first = week.days[0]?.date, last = week.days[week.days.length - 1]?.date;
  const dayNum = (d) => Number(d.split('-')[2]);
  const range = first && last ? (first === last ? `${dayNum(first)}` : `${dayNum(first)}-${dayNum(last)}`) : '';
  return `Week ${week.weekOfMonth}${range ? ` (${formatDaywiseDate(first).split(' ')[0]} ${range})` : ''}`;
}

// Same TAT-bucket-column table (Month -> Week -> Day drill under each row) as the day-wise table
// above it, just grouped by a different dimension (delivery partner / query class / repeat-
// contact bucket) instead of by date - shared here so those three tables don't triplicate ~150
// lines of identical row/month/week/day JSX with only the row label and grouping source differing.
function TatBreakdownTable({
  title, description, rowHeader, rows, grandTotal, buckets, loading,
  expandedRows, toggleRow, expandedMonths, toggleMonth, expandedWeeks, toggleWeek,
  getLabel, onDrill,
  // Optional 4th level for a table that needs one more layer of grouping between the top row
  // and its Month/Week/Day drill (currently only Repeat Contacts -> Delivery Partner).
  // subRowsFor(row) returns that row's sub-rows (same {key, label, total, counts, pct, months}
  // shape a top row has) or an empty/undefined result for every other table, in which case
  // Month/Week/Day render directly under the top row exactly as before.
  subRowsFor, expandedSubRows, toggleSubRow,
}) {
  // Indent step per nesting depth - Month/Week/Day sit one level deeper when a sub-row level is
  // in play (row -> sub-row -> month -> week -> day) than when it isn't (row -> month -> week ->
  // day), everything else about their rendering is identical.
  const PAD = ['pl-3', 'pl-8', 'pl-14', 'pl-20', 'pl-26'];
  const monthDepth = subRowsFor ? 2 : 1;

  const renderMonths = (months, depth) => months.map((month) => {
    const monthOpen = expandedMonths.has(month.key);
    return (
      <Fragment key={month.key}>
        <tr onClick={() => toggleMonth(month.key)} className="group hover:bg-zinc-800/30 transition-colors cursor-pointer bg-zinc-950/30">
          <td className={`sticky left-0 z-10 bg-zinc-950 group-hover:bg-zinc-800/30 transition-colors py-2 px-3 ${PAD[depth]} text-zinc-300 whitespace-nowrap`}>
            <span className="inline-block w-4 text-zinc-500">{monthOpen ? '▾' : '▸'}</span>
            {formatDaywiseMonth(month.key)}
          </td>
          {buckets.flatMap((b) => {
            const count = month.counts[b] || 0;
            const days = month.days;
            return [
              <td
                key={`${b}-n`}
                onClick={count ? (e) => { e.stopPropagation(); onDrill(days[0]?.date, days[days.length - 1]?.date, b); } : undefined}
                title={count ? `View these ${count.toLocaleString('en-IN')} ticket(s)` : undefined}
                className={`py-2 px-3 text-right text-zinc-300 tabular-nums border-l border-zinc-800/60 ${count ? 'cursor-pointer hover:underline hover:text-indigo-400' : ''}`}
              >{count}</td>,
              <td key={`${b}-pct`} style={pctHeatStyle(month.pct[b])} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">{month.pct[b] || 0}%</td>,
            ];
          })}
          <td className="py-2 px-3 text-right text-zinc-100 font-semibold tabular-nums border-l border-zinc-800/60">{month.total.toLocaleString('en-IN')}</td>
        </tr>
        {monthOpen && month.weeks.map((week) => {
          const weekOpen = expandedWeeks.has(week.key);
          return (
            <Fragment key={week.key}>
              <tr onClick={() => toggleWeek(week.key)} className="group hover:bg-zinc-800/30 transition-colors cursor-pointer bg-zinc-950/30">
                <td className={`sticky left-0 z-10 bg-zinc-950 group-hover:bg-zinc-800/30 transition-colors py-2 px-3 ${PAD[depth + 1]} text-zinc-300 whitespace-nowrap`}>
                  <span className="inline-block w-4 text-zinc-500">{weekOpen ? '▾' : '▸'}</span>
                  {formatDaywiseWeek(week)}
                </td>
                {buckets.flatMap((b) => {
                  const count = week.counts[b] || 0;
                  return [
                    <td
                      key={`${b}-n`}
                      onClick={count ? (e) => { e.stopPropagation(); onDrill(week.days[0]?.date, week.days[week.days.length - 1]?.date, b); } : undefined}
                      title={count ? `View these ${count.toLocaleString('en-IN')} ticket(s)` : undefined}
                      className={`py-2 px-3 text-right text-zinc-300 tabular-nums border-l border-zinc-800/60 ${count ? 'cursor-pointer hover:underline hover:text-indigo-400' : ''}`}
                    >{count}</td>,
                    <td key={`${b}-pct`} style={pctHeatStyle(week.pct[b])} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">{week.pct[b] || 0}%</td>,
                  ];
                })}
                <td className="py-2 px-3 text-right text-zinc-100 font-semibold tabular-nums border-l border-zinc-800/60">{week.total.toLocaleString('en-IN')}</td>
              </tr>
              {weekOpen && week.days.map((r) => (
                <tr key={r.date} className="group hover:bg-zinc-800/30 transition-colors">
                  <td className={`sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800/30 transition-colors py-2 px-3 ${PAD[depth + 2]} text-zinc-400 whitespace-nowrap`}>{formatDaywiseDate(r.date)}</td>
                  {buckets.flatMap((b) => {
                    const count = r.counts[b] || 0;
                    return [
                      <td
                        key={`${b}-n`}
                        onClick={count ? () => onDrill(r.date, r.date, b) : undefined}
                        title={count ? `View these ${count.toLocaleString('en-IN')} ticket(s)` : undefined}
                        className={`py-2 px-3 text-right text-zinc-400 tabular-nums border-l border-zinc-800/60 ${count ? 'cursor-pointer hover:underline hover:text-indigo-400' : ''}`}
                      >{count}</td>,
                      <td key={`${b}-pct`} style={pctHeatStyle(r.pct[b])} className="py-2 px-3 text-right text-zinc-600 tabular-nums text-[12px]">{r.pct[b] || 0}%</td>,
                    ];
                  })}
                  <td className="py-2 px-3 text-right text-zinc-300 tabular-nums border-l border-zinc-800/60">{r.total.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </Fragment>
    );
  });

  return (
    <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
      <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
        <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">{title}</p>
        {loading && <span className="text-[11px] text-zinc-600">Loading…</span>}
      </div>
      <p className="text-[12px] text-zinc-500 mb-3">{description}</p>
      <div className="rounded-xl border border-zinc-800/80 overflow-hidden">
        <div className="overflow-x-auto custom-scroll">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-zinc-800/80 text-zinc-500">
                <th rowSpan={2} className="sticky left-0 z-10 bg-zinc-900 py-2 px-3 text-left font-medium align-bottom whitespace-nowrap">{rowHeader}</th>
                {buckets.map((b) => (
                  <th key={b} colSpan={2} className="py-2 px-3 text-center font-medium border-l border-zinc-800/60 whitespace-nowrap">{b}</th>
                ))}
                <th rowSpan={2} className="py-2 px-3 text-right font-medium align-bottom border-l border-zinc-800/60 whitespace-nowrap">Grand Total</th>
              </tr>
              <tr className="border-b border-zinc-800/80 text-zinc-600 text-[11px]">
                {buckets.flatMap((b) => ([
                  <th key={`${b}-n`} className="py-1 px-3 text-right font-medium border-l border-zinc-800/60"> </th>,
                  <th key={`${b}-pct`} className="py-1 px-3 text-right font-medium">%</th>,
                ]))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {rows.map((row) => {
                const rowOpen = expandedRows.has(row.key);
                return (
                  <Fragment key={row.key}>
                    <tr onClick={() => toggleRow(row.key)} className="group hover:bg-zinc-800/30 transition-colors cursor-pointer">
                      <td className="sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800/30 transition-colors py-2 px-3 text-zinc-200 font-semibold whitespace-nowrap">
                        <span className="inline-block w-4 text-zinc-500">{rowOpen ? '▾' : '▸'}</span>
                        {getLabel(row)}
                      </td>
                      {buckets.flatMap((b) => {
                        const count = row.counts[b] || 0;
                        const allDays = row.months.flatMap((mo) => mo.days);
                        return [
                          <td
                            key={`${b}-n`}
                            onClick={count ? (e) => { e.stopPropagation(); onDrill(allDays[0]?.date, allDays[allDays.length - 1]?.date, b); } : undefined}
                            title={count ? `View these ${count.toLocaleString('en-IN')} ticket(s)` : undefined}
                            className={`py-2 px-3 text-right text-zinc-200 font-semibold tabular-nums border-l border-zinc-800/60 ${count ? 'cursor-pointer hover:underline hover:text-indigo-400' : ''}`}
                          >{count}</td>,
                          <td key={`${b}-pct`} style={pctHeatStyle(row.pct[b])} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">{row.pct[b] || 0}%</td>,
                        ];
                      })}
                      <td className="py-2 px-3 text-right text-zinc-100 font-bold tabular-nums border-l border-zinc-800/60">{row.total.toLocaleString('en-IN')}</td>
                    </tr>
                    {rowOpen && (subRowsFor ? subRowsFor(row).map((sub) => {
                      const subOpen = expandedSubRows.has(sub.key);
                      const allDays = sub.months.flatMap((mo) => mo.days);
                      return (
                        <Fragment key={sub.key}>
                          <tr onClick={() => toggleSubRow(sub.key)} className="group hover:bg-zinc-800/30 transition-colors cursor-pointer bg-zinc-950/30">
                            <td className={`sticky left-0 z-10 bg-zinc-950 group-hover:bg-zinc-800/30 transition-colors py-2 px-3 ${PAD[1]} text-zinc-300 whitespace-nowrap`}>
                              <span className="inline-block w-4 text-zinc-500">{subOpen ? '▾' : '▸'}</span>
                              {sub.label}
                            </td>
                            {buckets.flatMap((b) => {
                              const count = sub.counts[b] || 0;
                              return [
                                <td
                                  key={`${b}-n`}
                                  onClick={count ? (e) => { e.stopPropagation(); onDrill(allDays[0]?.date, allDays[allDays.length - 1]?.date, b); } : undefined}
                                  title={count ? `View these ${count.toLocaleString('en-IN')} ticket(s)` : undefined}
                                  className={`py-2 px-3 text-right text-zinc-300 tabular-nums border-l border-zinc-800/60 ${count ? 'cursor-pointer hover:underline hover:text-indigo-400' : ''}`}
                                >{count}</td>,
                                <td key={`${b}-pct`} style={pctHeatStyle(sub.pct[b])} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">{sub.pct[b] || 0}%</td>,
                              ];
                            })}
                            <td className="py-2 px-3 text-right text-zinc-100 font-semibold tabular-nums border-l border-zinc-800/60">{sub.total.toLocaleString('en-IN')}</td>
                          </tr>
                          {subOpen && renderMonths(sub.months, monthDepth)}
                        </Fragment>
                      );
                    }) : renderMonths(row.months, monthDepth))}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={buckets.length * 2 + 2} className="py-8 text-center text-zinc-500">
                  {loading ? 'Loading…' : 'No data.'}
                </td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-zinc-800/80 bg-zinc-950/40 font-semibold">
                  <td className="sticky left-0 z-10 bg-zinc-950 py-2 px-3 text-zinc-200 whitespace-nowrap">Grand Total</td>
                  {buckets.flatMap((b) => ([
                    <td key={`${b}-n`} className="py-2 px-3 text-right text-zinc-100 tabular-nums border-l border-zinc-800/60">{(grandTotal.totals[b] || 0).toLocaleString('en-IN')}</td>,
                    <td key={`${b}-pct`} style={pctHeatStyle(grandTotal.all ? Math.round(((grandTotal.totals[b] || 0) / grandTotal.all) * 100) : 0)} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">
                      {grandTotal.all ? Math.round(((grandTotal.totals[b] || 0) / grandTotal.all) * 100) : 0}%
                    </td>,
                  ]))}
                  <td className="py-2 px-3 text-right text-zinc-100 tabular-nums border-l border-zinc-800/60">{grandTotal.all.toLocaleString('en-IN')}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

// State -> City -> Pincode (rows, expandable one level at a time - click a State to see its
// Cities, click a City to see its Pincodes) x Query Category (fixed columns, unique/distinct-
// AWB count). Same indented-row-under-its-parent drill TatBreakdownTable's Month -> Week -> Day
// nesting already uses on this page, just State/City/Pincode instead of date - `tree` is
// pre-built by the caller (see geoTree in DeliveryEscalationClient) from the raw per-level
// responses plus which rows are currently expanded.
function GeoCategoryTable({
  month, monthOptions, onMonthChange, tree, categories, grandTotal, grandTotalAll,
  loading, onToggleState, onToggleCity,
}) {
  const pendingLabel = (status) => (status === 'error' ? 'Error' : 'Loading…');
  const colSpan = categories.length + 2;

  return (
    <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
      <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
        <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Query Category by Location</p>
        <div className="flex items-center gap-2">
          {loading && <span className="text-[11px] text-zinc-600">Loading…</span>}
          <CustomSelect value={month} onChange={onMonthChange} options={monthOptions} placeholder="Month" />
        </div>
      </div>
      <p className="text-[12px] text-zinc-500 mb-3">
        Unique ticket count (distinct AWB) per query category, by Query Date. Click a State to see its Cities, click a City to see its Pincodes.
      </p>
      <div className="rounded-xl border border-zinc-800/80 overflow-hidden">
        <div className="overflow-x-auto custom-scroll">
          {/* Depth (State/City/Pincode) is carried by indent + label weight/size alone, never by
              a translucent row fill - stacking a tinted row on top of this card's own
              bg-zinc-900/70 is exactly the "translucent surface on translucent surface"
              legibility trap (see apple-design's Materials section), which is what made every
              expanded row read as a flat gray smear. The sticky first column still needs a real
              (non-alpha) backdrop so horizontally-scrolled data can't show through it - that's
              the one spot with an explicit solid bg. Every value column stays full-contrast
              zinc-100 regardless of depth: the numbers are the content, only the row LABEL may
              recede with depth. */}
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-zinc-800/80">
                <th className="sticky left-0 z-10 bg-zinc-900 py-2.5 px-3 text-left font-semibold text-zinc-400 whitespace-nowrap">State / City / Pincode</th>
                {/* Grand Total right after the label, not after every category - it's the sort
                    key every row below is ordered by (highest first), so it needs to be visible
                    without scrolling past the whole category breakdown to confirm the order. */}
                <th className="py-2.5 px-3 text-right font-semibold text-zinc-300 border-l border-zinc-800/80 whitespace-nowrap">Grand Total</th>
                {categories.map((cat) => (
                  <th key={cat} className="py-2.5 px-3 text-right font-semibold text-zinc-400 whitespace-nowrap">{cat}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {tree.map((s) => (
                <Fragment key={s.key}>
                  <tr onClick={() => onToggleState(s.state)} className="group hover:bg-white/[0.04] transition-colors cursor-pointer">
                    <td className="sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800 transition-colors py-2.5 px-3 text-zinc-100 font-semibold whitespace-nowrap">
                      <span className="inline-block w-4 text-zinc-500">{s.expanded ? '▾' : '▸'}</span>{s.state}
                    </td>
                    <td className="py-2.5 px-3 text-right text-zinc-100 font-semibold tabular-nums border-l border-zinc-800/80">
                      {(s.total || 0).toLocaleString('en-IN')}
                    </td>
                    {categories.map((cat) => (
                      <td key={cat} className="py-2.5 px-3 text-right text-zinc-100 tabular-nums">
                        {(s.counts[cat] || 0).toLocaleString('en-IN')}
                      </td>
                    ))}
                  </tr>
                  {s.expanded && s.cities.map((c) => (
                    c.pending ? (
                      <tr key={c.key}>
                        <td colSpan={colSpan} className="py-2 px-3 pl-9 text-zinc-500 text-[12px]">{pendingLabel(c.status)}</td>
                      </tr>
                    ) : (
                      <Fragment key={c.key}>
                        <tr onClick={() => onToggleCity(s.state, c.city)} className="group hover:bg-white/[0.04] transition-colors cursor-pointer">
                          <td className="sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800 transition-colors py-2 px-3 pl-9 text-zinc-300 font-medium whitespace-nowrap">
                            <span className="inline-block w-4 text-zinc-500">{c.expanded ? '▾' : '▸'}</span>↳ {c.city}
                          </td>
                          <td className="py-2 px-3 text-right text-zinc-100 font-medium tabular-nums border-l border-zinc-800/80">
                            {(c.total || 0).toLocaleString('en-IN')}
                          </td>
                          {categories.map((cat) => (
                            <td key={cat} className="py-2 px-3 text-right text-zinc-100 tabular-nums">
                              {(c.counts[cat] || 0).toLocaleString('en-IN')}
                            </td>
                          ))}
                        </tr>
                        {c.expanded && c.pincodes.map((p) => (
                          p.pending ? (
                            <tr key={p.key}>
                              <td colSpan={colSpan} className="py-2 px-3 pl-16 text-zinc-500 text-[12px]">{pendingLabel(p.status)}</td>
                            </tr>
                          ) : (
                            <tr key={p.key} className="hover:bg-white/[0.04] transition-colors">
                              <td className="sticky left-0 z-10 bg-zinc-900 py-2 px-3 pl-16 text-zinc-400 text-[12px] whitespace-nowrap">↳ {p.pincode}</td>
                              <td className="py-2 px-3 text-right text-zinc-200 tabular-nums text-[12px] border-l border-zinc-800/80">
                                {(p.total || 0).toLocaleString('en-IN')}
                              </td>
                              {categories.map((cat) => (
                                <td key={cat} className="py-2 px-3 text-right text-zinc-200 tabular-nums text-[12px]">
                                  {(p.counts[cat] || 0).toLocaleString('en-IN')}
                                </td>
                              ))}
                            </tr>
                          )
                        ))}
                      </Fragment>
                    )
                  ))}
                </Fragment>
              ))}
              {tree.length === 0 && (
                <tr><td colSpan={colSpan} className="py-8 text-center text-zinc-500">
                  {loading ? 'Loading…' : 'No data for this month.'}
                </td></tr>
              )}
            </tbody>
            {tree.length > 0 && (
              <tfoot>
                <tr className="border-t border-zinc-800/80 bg-zinc-950 font-semibold">
                  <td className="sticky left-0 z-10 bg-zinc-950 py-2.5 px-3 text-zinc-100 whitespace-nowrap">Grand Total</td>
                  <td className="py-2.5 px-3 text-right text-zinc-100 tabular-nums border-l border-zinc-800/80">{grandTotalAll.toLocaleString('en-IN')}</td>
                  {categories.map((cat) => (
                    <td key={cat} className="py-2.5 px-3 text-right text-zinc-100 tabular-nums">
                      {(grandTotal[cat] || 0).toLocaleString('en-IN')}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

function filterQuery({ view, search, brand, agent, date, dateTo, dateField, tatBucket, contactBucket, partner }) {
  const p = new URLSearchParams();
  if (view) p.set('view', view);
  if (search) p.set('search', search);
  if (brand && brand !== 'ALL') p.set('brand', brand);
  if (agent && agent !== 'ALL') p.set('agent', agent);
  if (date) p.set('date', date);
  if (date && dateTo) p.set('dateTo', dateTo);
  if (date && dateField) p.set('dateField', dateField);
  if (tatBucket) p.set('tatBucket', tatBucket);
  if (contactBucket && contactBucket !== 'ALL') p.set('contactBucket', contactBucket);
  // Canonical name -> every raw delivery_partner variant it folds into, same
  // CANONICAL_TO_RAW_PARTNER convention fetchDaywiseStats already uses - the server only ever
  // filters the raw column, never learns what "canonical" means.
  if (partner && partner !== 'ALL') p.set('partner', (CANONICAL_TO_RAW_PARTNER[partner] || [partner]).join(','));
  return p;
}

// One page of whichever tab is open, with the current filters applied server-side.
async function fetchPage({ view, page, perPage, search, brand, agent, date, dateTo, dateField, tatBucket, contactBucket, partner }) {
  const p = filterQuery({ view, search, brand, agent, date, dateTo, dateField, tatBucket, contactBucket, partner });
  p.set('page', String(page));
  p.set('perPage', String(perPage));
  const d = await getJson(`/api/delivery-escalation/record?${p}`);
  // New Order Placed rows are actionable now (dispose to Delivered/RTO, see openAction/saveAction
  // below) - only Resolved is truly read-only.
  return { rows: (d.rows || []).map((r) => mapRow(r, view === 'resolved')), total: d.total || 0 };
}

// Mirrors db.js's DE_RESOLVED_WHERE (pre-New-Order-Placed-carve-out - Delivered or ANY Resolved
// child counts) - a history row is read-only once it's actually resolved, regardless of which
// tab (Fresh/Resolved/Forced RTO/New Order Placed) the currently loaded page is showing.
function isDeResolvedOutcome(outcome) {
  const o = outcome || '';
  return o === 'Delivered' || o.startsWith('Delivered > ') || o === 'Resolved' || o.startsWith('Resolved > ');
}

// Mirrors db.js's DE_MISSING_AWB_WHERE - blank, or Flowcall's own 'N/A'/'#N/A' placeholder (any
// casing), counts as "no AWB on file" for the old-AWB dispose mandate below.
function isAwbMissing(awb) {
  const a = (awb || '').trim().toUpperCase();
  return !a || a === 'N/A' || a === '#N/A';
}

// Every ticket ever raised for one parcel (see db.js's getDeliveryEscalationAwbHistory) - the
// repeat's OTHER tickets can land on any page of the id-ordered table, not just this one, so
// contactCount > 1 alone can't be expanded from what's already loaded; this is the fetch that
// actually gets them, called lazily the first time a repeat row is expanded.
async function fetchAwbHistory(awb, brand) {
  const p = new URLSearchParams({ op: 'awbHistory', awb, brand });
  const d = await getJson(`/api/delivery-escalation/record?${p}`);
  return (d.rows || []).map((r) => mapRow(r, isDeResolvedOutcome(r.outcome)));
}

// Overview's tiles + the admin Agent filter's options. Counted in SQL over the whole table,
// not derived from the loaded page.
async function fetchStats() {
  const d = await getJson('/api/delivery-escalation/record?op=stats');
  return {
    stats: d.stats || { total: 0, assigned: 0, resolved: 0, fresh: 0, forcedRto: 0, newOrderPlaced: 0 },
    agents: d.agents || [],
    repeatStats: d.repeatStats || [],
  };
}

// Overview's day-wise TAT table - unlike fetchStats above, this DOES take the page's current
// brand/agent filters (see record.js's own op=daywise comment on why).
async function fetchDaywiseStats({ brand, agent, dateField, partner, paymentMode, dateFrom, dateTo }) {
  const p = new URLSearchParams({ op: 'daywise' });
  if (brand && brand !== 'ALL') p.set('brand', brand);
  if (agent && agent !== 'ALL') p.set('agent', agent);
  if (dateField) p.set('dateField', dateField);
  if (partner && partner !== 'ALL') p.set('partner', (CANONICAL_TO_RAW_PARTNER[partner] || [partner]).join(','));
  if (paymentMode && paymentMode !== 'ALL') p.set('paymentMode', paymentMode);
  if (dateFrom && dateTo) { p.set('dateFrom', dateFrom); p.set('dateTo', dateTo); }
  const d = await getJson(`/api/delivery-escalation/record?${p}`);
  return {
    buckets: d.buckets || [],
    rows: d.rows || [],
    grandTotal: d.grandTotal || {},
    grandTotalAll: d.grandTotalAll || 0,
    missingDateCount: d.missingDateCount || 0,
  };
}

// Fresh tab's claim/resolve - MySQL-only, no sheet write at all, same model as CLS_RTO_calling's
// own claim/dispose (see api/_lib/db.js's claimDeliveryEscalationTicketById/
// disposeDeliveryEscalationTicketById). Unlike the old sheet write path these throw on failure -
// this IS the write now, not a best-effort mirror alongside one, so a failure has to surface to
// the agent instead of being silently swallowed.
async function claimMysqlTicket(id) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'claim', id }),
  });
  // Same "read the real reason out of the body" rule as getJson/bulkUploadOutcomes - a bare
  // "Claim failed 401" can't be told apart from a session expiry (AUTH_ERROR_MESSAGE) or any
  // other real failure without it.
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Claim failed (${r.status})`);
}

// newOrderAwb is only ever non-blank when resolving a New Order Placed ticket (see saveAction) -
// the server enforces it's present when that ticket is being marked Delivered/RTO, and otherwise
// just carries it through as an optional update (see disposeDeliveryEscalationTicketById).
// oldAwb is the SEPARATE "this ticket has no AWB at all" mandate - non-blank only when the
// ticket being disposed had a missing awb_code, server-enforced the same way.
async function disposeMysqlTicket(id, outcome, agentRemarks, newOrderAwb, oldAwb) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dispose', id, outcome, agentRemarks, newOrderAwb, oldAwb }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Save failed (${r.status})`);
}

// Minimal CSV parser for the Fresh tab's bulk outcome upload - handles quoted fields (commas,
// escaped "" quotes) since Remarks is free text that could contain either. No library: CSV's
// quoting rule is the one thing a plain .split(',') gets wrong, and it's small enough that a
// hand-rolled parser beats a dependency for it.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Header lookup is case/space-insensitive ("AWB Number", "awb", "AWB_Number" all match) since
// this file is hand-exported by whoever's doing the bulk resolution, not machine-generated.
function rowsFromBulkCsv(text) {
  const [header, ...dataRows] = parseCsv(text);
  if (!header) return [];
  const norm = (s) => (s || '').trim().toLowerCase().replace(/[\s_]+/g, '');
  const idx = {};
  header.forEach((h, i) => { idx[norm(h)] = i; });
  const awbIdx = idx.awb ?? idx.awbnumber ?? idx.awbcode;
  const outcomeIdx = idx.outcome;
  const remarksIdx = idx.remarks;
  if (awbIdx === undefined || outcomeIdx === undefined) {
    throw new Error('CSV needs an AWB column and an Outcome column');
  }
  return dataRows
    .map((r) => ({
      awb: (r[awbIdx] || '').trim(),
      outcome: (r[outcomeIdx] || '').trim(),
      remarks: remarksIdx !== undefined ? (r[remarksIdx] || '').trim() : '',
    }))
    .filter((r) => r.awb && r.outcome);
}

// New Order Placed tab's own bulk upload - fills in `new_order_AWB` by AWB match. Outcome is
// OPTIONAL: blank just updates new_order_AWB (the ticket stays as-is); given, it also disposes
// the ticket to that outcome (e.g. Delivered/RTO) - same "mandatory New Order AWB" rule the
// tab's own single-dispose modal enforces, satisfied here for free since New Order AWB is
// already required on every row regardless of Outcome. Same header lookup convention as
// rowsFromBulkCsv.
function rowsFromNewOrderAwbCsv(text) {
  const [header, ...dataRows] = parseCsv(text);
  if (!header) return [];
  const norm = (s) => (s || '').trim().toLowerCase().replace(/[\s_]+/g, '');
  const idx = {};
  header.forEach((h, i) => { idx[norm(h)] = i; });
  const awbIdx = idx.awb ?? idx.awbnumber ?? idx.awbcode;
  const newAwbIdx = idx.neworderawb ?? idx.newawb;
  const outcomeIdx = idx.outcome;
  const remarksIdx = idx.remarks;
  if (awbIdx === undefined || newAwbIdx === undefined) {
    throw new Error('CSV needs an AWB column and a New Order AWB column');
  }
  return dataRows
    .map((r) => ({
      awb: (r[awbIdx] || '').trim(),
      newOrderAwb: (r[newAwbIdx] || '').trim(),
      outcome: outcomeIdx !== undefined ? (r[outcomeIdx] || '').trim() : '',
      remarks: remarksIdx !== undefined ? (r[remarksIdx] || '').trim() : '',
    }))
    .filter((r) => r.awb && r.newOrderAwb);
}

// Quote a CSV field only when it needs it (comma, quote, or newline), doubling embedded quotes
// - the same rule parseCsv above reads back.
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_COLUMNS = [
  ['Brand', 'brand'], ['Order ID', 'orderId'], ['AWB', 'awb'], ['New Order AWB', 'newOrderAwb'], ['Ticket Number', 'ticketNumber'],
  ['Delivery Partner', 'deliveryPartner'], ['Query Class', 'queryClass'],
  ['Query Category', 'queryCategory'], ['Added Date', 'addedDate'], ['Order Date', 'orderDate'],
  ['TAT', 'tat'], ['Times Contacted', 'contactCount'], ['First Contact', 'firstContactDate'],
  ['Agent Name', 'assignedAgent'],
  ['Action Date', 'actionDate'], ['Outcome', 'outcome'],
  ['Child Disposition', 'childDisposition'], ['Remarks', 'remarks'],
  ['TAT Bucket', 'tatBucket'],
];

// Downloads the CURRENT view and filters, not just the page on screen - every matching row,
// with no row-count ceiling. The server hands back one chunk per request (bounded so any single
// response stays inside Lambda's 6MB cap - see DELIVERY_ESCALATION_MAX_EXPORT/hasMore in
// db.js/record.js); this walks page 1, 2, 3... until a chunk comes back short, then builds one
// CSV from everything collected. onChunk reports progress for a long export.
// ﻿ prefix: without a BOM Excel reads a UTF-8 CSV as ANSI and mangles non-ASCII text.
async function downloadCsv({ view, search, brand, agent, date, dateTo, dateField, tatBucket, contactBucket, partner }, onChunk) {
  const rows = [];
  for (let page = 1; ; page++) {
    const p = filterQuery({ view, search, brand, agent, date, dateTo, dateField, tatBucket, contactBucket, partner });
    p.set('op', 'export');
    p.set('page', String(page));
    const d = await getJson(`/api/delivery-escalation/record?${p}`);
    const chunk = d.rows || [];
    for (const r of chunk) rows.push(mapRow(r, view === 'resolved'));
    onChunk?.(rows.length);
    if (!d.hasMore) break;
  }
  const lines = [EXPORT_COLUMNS.map(([label]) => csvCell(label)).join(',')];
  for (const row of rows) lines.push(EXPORT_COLUMNS.map(([, key]) => csvCell(row[key])).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `delivery-escalation-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { count: rows.length };
}

// Fresh tab's bulk outcome upload - one call, many (awb, outcome) pairs; see
// api/_lib/db.js's bulkDisposeDeliveryEscalationByAwb for matching/scoping rules (every row
// with that AWB, but only if it's still Fresh-eligible).
async function bulkUploadOutcomes(rows, view) {
  const r = await fetch('/api/delivery-escalation/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bulkDispose', rows, view }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Bulk upload failed (${r.status})`);
  return d.results || [];
}

// Walks the FIRST child at each level of the process's own configured disposition tree, so the
// sample template shows a real, currently-valid outcome path for THIS process rather than a
// made-up one that might not exist here. Falls back to a plain placeholder when nothing's been
// configured yet (a fresh process's tree starts empty - see callingProcesses.json's own note on
// "no seeded default").
function sampleOutcomePaths(tree) {
  const paths = [];
  for (const node of (tree || [])) {
    const labels = [node.label];
    let cur = node;
    while (cur.children && cur.children.length) {
      cur = cur.children[0];
      labels.push(cur.label);
    }
    paths.push(labels.join(' > '));
    if (paths.length >= 2) break;
  }
  return paths;
}

// Downloads a ready-to-fill CSV for the Bulk Upload button - same AWB/Outcome/Remarks columns
// rowsFromBulkCsv reads back, pre-populated with two example rows pulled from the process's own
// disposition tree: a plain top-level outcome, and a nested one showing the "Parent > Child"
// convention a bulk upload's Outcome column uses for a child disposition (there's no separate
// column for it - the full path IS the Outcome value, same as a single dispose's
// dispPath.join(' > ')).
function downloadBulkSampleCsv(processDispositions) {
  const [path1, path2] = sampleOutcomePaths(processDispositions);
  const outcomeTop = path1 || 'Delivered';
  const outcomeNested = path2 || (path1 && path1.includes(' > ') ? path1 : 'Escalated > Awaiting Partner');
  const lines = [
    'AWB,Outcome,Remarks',
    `SF1234567890EX,${csvCell(outcomeTop)},Optional free text`,
    `SF0987654321EX,${csvCell(outcomeNested)},`,
  ];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'delivery-escalation-bulk-upload-sample.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Sample CSV for the New Order Placed tab's own bulk upload - AWB + New Order AWB, and an
// OPTIONAL Outcome (blank row just fills New Order AWB; a given Outcome also disposes the
// ticket, e.g. to Delivered or RTO).
function downloadNewOrderAwbSampleCsv() {
  const lines = [
    'AWB,New Order AWB,Outcome',
    'SF1234567890EX,SF9999999999EX,',
    'SF1122334455EX,SF8888888888EX,Delivered',
  ];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'delivery-escalation-new-order-awb-sample.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Admin Panel card - per-user Role label, Delivery Partner allowlist, and Query Category
// allowlist (see api/admin/[action].js's handleDeliveryPartnerAccess). Partner/Query Category
// use the SAME MultiSelectDropdown the RTO roster's own Priority Reasons column already uses
// (app/_calling/ui.js) - one control language across the app instead of a new bespoke picker,
// and it already solves the actual problem a flat wall of 50 chip buttons per row had: scanning,
// comparing rows at a glance, and telling "selected" from "everything else" apart.
//
// Each of the three columns saves independently, keyed by its own field name so one column's
// debounce never cancels another's (see saveTimers' per-field keys below). Partner/Query
// Category are debounced ~500ms after the last change to that cell (not on every checkbox click,
// not requiring a separate Save button) - a few quick clicks while narrowing someone's access
// become one write. Role is a plain <select> and saves immediately on pick. The row's own
// "Saving…" label is the only feedback needed either way, since each setter already replaces its
// list/value atomically. Role itself gates nothing (see DELIVERY_ESCALATION_ROLES in
// api/admin/[action].js's own comment) - it's a label only, for whoever's configuring the other
// two columns.
const DE_ROLE_OPTIONS = [
  { value: 'Agent', label: 'Agent' },
  { value: 'Partner', label: 'Partner' },
  { value: 'Team Leader', label: 'Team Leader' },
];

function DeliveryPartnerAccessCard({ showToast }) {
  const [state, setState] = useState({ status: 'loading', users: [], partners: [], queryCategories: [] });
  const [savingIds, setSavingIds] = useState(() => new Set());
  const saveTimers = useRef({});

  // The dropdown picks/shows CANONICAL names (DELHIVERY, Shadowfax, ... - same PARTNER_NAME_MAP/
  // mapPartnerName the Overview's own Partner breakdown already groups by), never the raw
  // delivery_partner spelling - a wall of 50 near-duplicate raw variants (DELHIVERY_NDD_DIRECT_H,
  // Shadowfax_H_NDD, XBSRF_Direct_NDD_HYPHEN, ...) is what made the picker unreadable in the
  // first place. Storage/enforcement still key off the raw column (db.js has no notion of
  // "canonical"), so this expands on save and collapses on load, same convention as
  // fetchDaywiseStats' own Partner filter (see CANONICAL_TO_RAW_PARTNER's own comment).
  // Built from state.partners (the LIVE distinct raw values) rather than the static
  // PARTNER_FILTER_OPTIONS list, so a raw value with no PARTNER_NAME_MAP entry (passes through
  // mapPartnerName unchanged - 'SELF', '#N/A', 'M_SHIPROCKET', ...) still gets its own option
  // instead of silently having no way to be picked at all.
  const canonicalPartnerOptions = useMemo(
    () => [...new Set(state.partners.map(mapPartnerName))].sort(),
    [state.partners],
  );
  // Query Category has no canonical-name grouping (that problem - raw carrier-code sprawl - is
  // specific to delivery_partner), so state.queryCategories (the LIVE distinct values, same
  // "built from live data, not a static list" convention as canonicalPartnerOptions) is offered
  // as-is.
  const queryCategoryOptions = state.queryCategories;

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const r = await fetch('/api/admin/delivery-partner-access');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Load failed (${r.status})`);
      setState({ status: 'loaded', users: d.users || [], partners: d.partners || [], queryCategories: d.queryCategories || [] });
    } catch (e) {
      setState({ status: 'error', users: [], partners: [], queryCategories: [], error: e.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Any in-flight debounce timers must die with the component, or a save fires against an
  // unmounted card's stale closure after navigating away.
  useEffect(() => () => Object.values(saveTimers.current).forEach(clearTimeout), []);

  // patch carries whichever of partners/queryCategories/role changed - see the PUT shape in
  // api/admin/[action].js's own handleDeliveryPartnerAccess comment. One save endpoint for all
  // three columns, same as it already was for partners alone.
  const commitSave = async (userId, patch) => {
    setSavingIds((prev) => new Set(prev).add(userId));
    try {
      const r = await fetch('/api/admin/delivery-partner-access', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...patch }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Save failed (${r.status})`);
    } catch (e) {
      showToast?.(`⚠️ Could not save: ${e.message}`);
      load(); // revert this row (and everyone else's) to the server's own truth
    } finally {
      setSavingIds((prev) => { const next = new Set(prev); next.delete(userId); return next; });
    }
  };

  // canonicalList is what the dropdown hands back (canonical names) - expand each to every raw
  // variant that folds into it (CANONICAL_TO_RAW_PARTNER; a canonical name with no map entry -
  // an unmapped raw passing through as itself - falls back to just itself) before storing/
  // sending, since that's what's actually persisted and enforced against.
  const handleCanonicalChange = (userId, canonicalList) => {
    const rawList = [...new Set(canonicalList.flatMap((c) => CANONICAL_TO_RAW_PARTNER[c] || [c]))];
    setState((s) => ({ ...s, users: s.users.map((u) => (u.id === userId ? { ...u, deliveryPartners: rawList } : u)) }));
    const key = `partners:${userId}`;
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => commitSave(userId, { partners: rawList }), 500);
  };

  // Query Category has no canonical/raw distinction (unlike Delivery Partner above) - the
  // dropdown's own values are exactly what's stored/enforced, so no expand/collapse step.
  const handleQueryCategoryChange = (userId, next) => {
    setState((s) => ({ ...s, users: s.users.map((u) => (u.id === userId ? { ...u, queryCategories: next } : u)) }));
    const key = `queryCategories:${userId}`;
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => commitSave(userId, { queryCategories: next }), 500);
  };

  // Role saves immediately on pick (a <select>, not a debounced multi-select) - no separate
  // timer key needed since it never fires more than once per click.
  const handleRoleChange = (userId, role) => {
    setState((s) => ({ ...s, users: s.users.map((u) => (u.id === userId ? { ...u, role } : u)) }));
    commitSave(userId, { role });
  };

  // labelList is what the dropdown hands back (display labels, e.g. '⚡ Fresh') - resolve back
  // to plain tab_keys before storing/sending, same shape handleCanonicalChange's own
  // canonical -> raw expansion uses for Delivery Partner.
  const handleTabAccessChange = (userId, labelList) => {
    const tabAccess = labelList.map((l) => DE_TAB_LABEL_TO_KEY[l]).filter(Boolean);
    setState((s) => ({ ...s, users: s.users.map((u) => (u.id === userId ? { ...u, tabAccess } : u)) }));
    const key = `tabAccess:${userId}`;
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => commitSave(userId, { tabAccess }), 500);
  };

  if (state.status === 'loading') {
    return (
      <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5">
        <p className="text-zinc-500 text-[13px]">Loading Delivery Partner access…</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="bg-zinc-900/60 rounded-xl border border-rose-900/50 p-5 space-y-2">
        <p className="text-rose-400 text-[13px]">Could not load Delivery Partner access: {state.error}</p>
        <button onClick={load} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[12px] font-semibold">Retry</button>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
      <div className="flex items-center gap-3">
        <span className="h-9 w-9 rounded-lg bg-indigo-500/10 flex items-center justify-center text-lg">🚚</span>
        <div>
          <h3 className="text-[15px] font-bold text-zinc-100">Delivery-Escalation Access</h3>
          <p className="text-[12px] text-zinc-500">
            Role is a label only. Delivery Partner and Query Category restrict which tickets each agent may see; Tab Access restricts which of this page's own tabs they may open - all on top of their existing Delivery-Escalation access, not instead of it. Nothing selected in any of the three = sees every value/tab.
          </p>
        </div>
      </div>
      {state.users.length === 0 ? (
        <p className="text-[12px] text-zinc-500">No one has Delivery-Escalation access yet.</p>
      ) : (
        <div className="border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-zinc-800/80 text-zinc-500">
                <th className="text-left font-medium py-2.5 px-4">Name</th>
                <th className="text-left font-medium py-2.5 px-4">Role</th>
                <th className="text-left font-medium py-2.5 px-4">Delivery Partner Access</th>
                <th className="text-left font-medium py-2.5 px-4">Query Category Access</th>
                <th className="text-left font-medium py-2.5 px-4">Tab Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {state.users.map((u) => {
                // Raw storage collapsed to canonical for display - multiple raw variants under
                // one canonical name (e.g. every DELHIVERY_* row) always dedupe to one chip.
                const canonicalSelected = [...new Set(u.deliveryPartners.map(mapPartnerName))];
                const isSaving = savingIds.has(u.id);
                return (
                <tr key={u.id} className="hover:bg-zinc-800/20 transition-colors">
                  <td className="py-2.5 px-4">
                    <div className="text-zinc-200 font-semibold">{u.name || u.email}</div>
                    {u.name && <div className="text-[11px] text-zinc-500">{u.email}</div>}
                  </td>
                  <td className="py-2.5 px-4">
                    <CustomSelect
                      value={u.role}
                      onChange={(role) => handleRoleChange(u.id, role)}
                      options={DE_ROLE_OPTIONS}
                    />
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-2">
                      <MultiSelectDropdown
                        value={canonicalSelected}
                        onChange={(next) => handleCanonicalChange(u.id, next)}
                        options={canonicalPartnerOptions}
                        placeholder="All partners"
                        itemNoun="partners"
                      />
                      {isSaving && <span className="text-[11px] text-zinc-500">Saving…</span>}
                    </div>
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-2">
                      <MultiSelectDropdown
                        value={u.queryCategories}
                        onChange={(next) => handleQueryCategoryChange(u.id, next)}
                        options={queryCategoryOptions}
                        placeholder="All categories"
                        itemNoun="categories"
                      />
                      {isSaving && <span className="text-[11px] text-zinc-500">Saving…</span>}
                    </div>
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-2">
                      <MultiSelectDropdown
                        value={u.tabAccess.map((k) => DE_TAB_LABELS[k]).filter(Boolean)}
                        onChange={(next) => handleTabAccessChange(u.id, next)}
                        options={DE_TAB_OPTIONS}
                        placeholder="All tabs"
                        itemNoun="tabs"
                      />
                      {isSaving && <span className="text-[11px] text-zinc-500">Saving…</span>}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
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
  // Which of THIS PAGE'S OWN tabs (Overview/Fresh/Forced RTO/Resolved/New Order Placed) this
  // session may open - the admin panel's own Tab Access column (see DeliveryPartnerAccessCard),
  // separate from invitedProcessKeys above (that's whether this account can open the
  // deliveryescalation process AT ALL among sibling Calling processes). null = unrestricted,
  // same convention as invitedProcessKeys.
  const [allowedDeTabs, setAllowedDeTabs] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      if (d?.authenticated && d.email) {
        setGoogleUser({ name: d.name || d.email.split('@')[0], email: d.email });
        setSessionIsAdmin(!!d.isAdmin);
        const tabs = (d.tabPerms && d.tabPerms[CARD_KEY]) || null;
        setInvitedProcessKeys(Array.isArray(tabs) && tabs.length ? tabs : null);
        const deTabs = (d.tabPerms && d.tabPerms[DE_TAB_CARD_KEY]) || null;
        setAllowedDeTabs(Array.isArray(deTabs) && deTabs.length ? deTabs : null);
      }
      setAuthLoaded(true);
    }).catch(() => setAuthLoaded(true));
  }, []);
  const hasAccess = sessionIsAdmin || !invitedProcessKeys || invitedProcessKeys.includes(TAB_KEY);

  const [toast, setToast] = useState(null);
  const showToast = useCallback(m => { setToast(m); setTimeout(() => setToast(null), 3000); }, []);

  // Admin-configurable disposition tree (calling_process_dispositions), the same shared piece
  // NDR's Admin Panel uses - starts empty, an admin adds whatever outcomes this process needs.
  // No CallingHoursCard / roster table here on purpose - this process has neither business
  // hours nor a roster to administer (see the module comment up top).
  const disp = useProcessDispositions(TAB_KEY, { googleUser, showToast });
  const { processDispositions } = disp;

  const [tab, setTab] = useState('overview');
  // If the signed-in agent's own Tab Access restriction excludes the default/current tab (e.g.
  // Overview isn't in their allowlist), land them on the first tab they actually have - never on
  // a nav item that isn't even rendered for them (see tabsList's own filter below).
  useEffect(() => {
    if (allowedDeTabs && allowedDeTabs.length && !allowedDeTabs.includes(tab)) {
      setTab(allowedDeTabs[0]);
    }
  }, [allowedDeTabs]);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState(() => safeStorage.getItem('de_brand_filter') || 'ALL');
  // Daywise-table-only filters (unlike brandFilter/agentFilter below, these don't touch the
  // Fresh/Resolved ticket list - see fetchDaywiseStats, the only place they're read).
  const [daywisePartnerFilter, setDaywisePartnerFilter] = useState(() => safeStorage.getItem('de_daywise_partner_filter') || 'ALL');
  const [daywisePaymentModeFilter, setDaywisePaymentModeFilter] = useState(() => safeStorage.getItem('de_daywise_payment_mode_filter') || 'ALL');
  // Which date column the TAT-by-date table's rows are grouped under - 'added_date' (labeled
  // Query Date here, same as the rest of this page) or 'order_date' (when the order was placed).
  const [daywiseDateBasis, setDaywiseDateBasis] = useState(() => safeStorage.getItem('de_daywise_date_basis') || 'added_date');
  // The day-wise table's OWN date-range filter - independent of the ticket list's dateRangePreset/
  // dateFilter/dateFilterTo below (this table has no `view`, spans Fresh+Resolved+Forced RTO at
  // once, and filters the DATE-GROUPED rows themselves rather than a ticket list). Same
  // preset/custom shape and same istTodayParts/dateRangeForPreset helpers, just its own state.
  const [daywiseDateRangePreset, setDaywiseDateRangePreset] = useState(() => safeStorage.getItem('de_daywise_date_range_preset') || 'all');
  const [daywiseDateFrom, setDaywiseDateFrom] = useState('');
  const [daywiseDateTo, setDaywiseDateTo] = useState('');
  const [agentFilter, setAgentFilter] = useState('ALL');
  // Ticket list's own Delivery Partner filter (Fresh/Forced RTO/Resolved/New Order Placed all
  // share this one filter bar) - a canonical name, same PARTNER_FILTER_OPTIONS/
  // CANONICAL_TO_RAW_PARTNER convention as daywisePartnerFilter above, resolved to raw values in
  // filterQuery. Separate from allowedPartners (the admin-set access floor, always enforced,
  // never shown as a filter) - this one narrows further, same relationship
  // getDeliveryEscalationDaywiseStats' own partner/allowedPartners pair already has.
  const [partnerFilter, setPartnerFilter] = useState(() => safeStorage.getItem('de_partner_filter') || 'ALL');
  // dateFilter/dateFilterTo are the actual from/to bounds sent to the server (see
  // effectiveFilters below) - dateRangePreset is purely a UI convenience that fills them in.
  // 'custom' leaves them for the agent to type by hand; any other preset (over)writes both from
  // handleDateRangePresetChange.
  const [dateRangePreset, setDateRangePreset] = useState(() => safeStorage.getItem('de_date_range_preset') || 'all');
  const [dateFilter, setDateFilter] = useState('');
  const [dateFilterTo, setDateFilterTo] = useState('');
  // Which date column the ticket list's date filter (and its CSV export) matches against -
  // same 'added_date'/'order_date' choice as the Overview tab's day-wise table.
  const [dateFilterBasis, setDateFilterBasis] = useState(() => safeStorage.getItem('de_date_filter_basis') || 'added_date');
  // Set by clicking a bucket cell in the Overview day-wise table (see drillIntoDaywise) -
  // { dateFrom, dateTo, dateField, tatBucket, label } overrides dateFilter/dateFilterBasis
  // entirely while active, since a month/week cell spans a date range the single-day picker
  // can't express. Cleared by the chip's × or by picking a tab from the nav bar directly.
  const [dateDrill, setDateDrill] = useState(null);
  const [contactBucketFilter, setContactBucketFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState({ total: 0, assigned: 0, resolved: 0, fresh: 0, forcedRto: 0, newOrderPlaced: 0 });
  const [agents, setAgents] = useState([]);
  const [repeatStats, setRepeatStats] = useState([]);
  const [daywise, setDaywise] = useState({ buckets: [], rows: [], grandTotal: {}, grandTotalAll: 0, missingDateCount: 0 });
  const [daywiseLoading, setDaywiseLoading] = useState(false);
  // Collapsed by default at every level - a flat list of every individual day was the whole
  // problem being fixed here. Shared between the date table and the partner-wise table below it:
  // date table keys are month key ('2026-07') and week key ('2026-07-W2'); partner-wise table
  // keys are partner key ('Delhivery'), month key ('Delhivery::2026-07'), and week key
  // ('Delhivery::2026-07-W2') - the prefixes keep the two tables' keys from colliding.
  const [expandedMonths, setExpandedMonths] = useState(() => new Set());
  const [expandedPartners, setExpandedPartners] = useState(() => new Set());
  const [expandedWeeks, setExpandedWeeks] = useState(() => new Set());
  const [expandedCategories, setExpandedCategories] = useState(() => new Set());
  // Top-level row expand state for the standalone Query Class / Repeat Contacts TAT tables -
  // same shared expandedMonths/expandedWeeks as the partner-wise table above (key prefixes keep
  // all these tables' month/week keys from colliding with each other).
  const [expandedQueryClasses, setExpandedQueryClasses] = useState(() => new Set());
  const [expandedContactBuckets, setExpandedContactBuckets] = useState(() => new Set());
  // Repeat Contacts' own extra level - a Delivery Partner row nested under a Times Contacted
  // row (see groupContactBucketPartnerwiseRows), keyed `${contactBucket}::${partner}` so two
  // buckets' own "Delhivery" row never collide.
  const [expandedContactBucketPartners, setExpandedContactBucketPartners] = useState(() => new Set());
  // Fresh/Resolved list's own expand state - same repeat-contact AWBs contactCount already
  // flags, collapsed to one parent (the newest row, since rows arrive id/disposed_at DESC)
  // with every older ticket for that AWB nested under it as a timeline. Keyed by the parent's
  // own id, not the AWB string, so two different parents never collide.
  const [expandedAwbGroups, setExpandedAwbGroups] = useState(() => new Set());
  // Fetched lazily on first expand, keyed by `${brand}|${awb}` - {status: 'loading'|'loaded'|
  // 'error', rows, error}. Cached so re-collapsing and re-expanding the same row doesn't refetch.
  const [awbHistory, setAwbHistory] = useState(() => new Map());
  const toggleExpanded = (setFn, key) => setFn((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const groupedDaywise = useMemo(
    () => groupDaywiseRows(daywise.rows, daywise.buckets),
    [daywise.rows, daywise.buckets]
  );
  const groupedPartnerwise = useMemo(
    () => groupPartnerwiseRows(daywise.rows, daywise.buckets),
    [daywise.rows, daywise.buckets]
  );
  const partnerwiseGrandTotal = useMemo(() => {
    const totals = Object.fromEntries(daywise.buckets.map((b) => [b, 0]));
    let all = 0;
    for (const p of groupedPartnerwise) {
      daywise.buckets.forEach((b) => { totals[b] += p.counts[b] || 0; });
      all += p.total;
    }
    return { totals, all };
  }, [groupedPartnerwise, daywise.buckets]);
  const groupedCategorywise = useMemo(
    () => groupCategorywiseRows(daywise.rows, daywise.buckets),
    [daywise.rows, daywise.buckets]
  );
  const categorywiseGrandTotal = useMemo(() => {
    const totals = Object.fromEntries(daywise.buckets.map((b) => [b, 0]));
    let all = 0;
    for (const c of groupedCategorywise) {
      daywise.buckets.forEach((b) => { totals[b] += c.counts[b] || 0; });
      all += c.total;
    }
    return { totals, all };
  }, [groupedCategorywise, daywise.buckets]);
  const groupedContactBucketwise = useMemo(
    () => groupContactBucketwiseRows(daywise.rows, daywise.buckets),
    [daywise.rows, daywise.buckets]
  );
  const contactBucketwiseGrandTotal = useMemo(() => {
    const totals = Object.fromEntries(daywise.buckets.map((b) => [b, 0]));
    let all = 0;
    for (const c of groupedContactBucketwise) {
      daywise.buckets.forEach((b) => { totals[b] += c.counts[b] || 0; });
      all += c.total;
    }
    return { totals, all };
  }, [groupedContactBucketwise, daywise.buckets]);
  // Query Category by Location table - its own month filter (defaults to the latest month once
  // groupedDaywise has one), independent of the page's main date filter since this table is a
  // standalone monthly snapshot, not a filtered ticket list. State/city/pincode data is fetched
  // one level at a time as each column is expanded (see toggleGeoState/toggleGeoCity below) -
  // cached by key so re-collapsing and re-expanding the same column doesn't refetch, same
  // pattern as awbHistory.
  const [geoMonth, setGeoMonth] = useState('');
  const [geoData, setGeoData] = useState({ categories: [], rows: [], grandTotal: {}, grandTotalAll: 0 });
  const [geoLoading, setGeoLoading] = useState(false);
  const [expandedGeoStates, setExpandedGeoStates] = useState(() => new Set());
  const [expandedGeoCities, setExpandedGeoCities] = useState(() => new Set());
  const [geoCities, setGeoCities] = useState(() => new Map()); // stateName -> {status, rows}
  const [geoPincodes, setGeoPincodes] = useState(() => new Map()); // `${state}::${city}` -> {status, rows}
  const geoMonthOptions = useMemo(
    () => groupedDaywise.map((m) => ({ value: m.key, label: formatDaywiseMonth(m.key) })),
    [groupedDaywise]
  );
  useEffect(() => {
    if (!geoMonth && geoMonthOptions.length) setGeoMonth(geoMonthOptions[geoMonthOptions.length - 1].value);
  }, [geoMonth, geoMonthOptions]);

  useEffect(() => {
    if (!geoMonth) return;
    let cancelled = false;
    setGeoLoading(true);
    setExpandedGeoStates(new Set());
    setExpandedGeoCities(new Set());
    setGeoCities(new Map());
    setGeoPincodes(new Map());
    const p = new URLSearchParams({ op: 'geoCategory', level: 'state', month: geoMonth });
    if (brandFilter !== 'ALL') p.set('brand', brandFilter);
    getJson(`/api/delivery-escalation/record?${p.toString()}`)
      .then((d) => { if (!cancelled) setGeoData(d); })
      .catch((e) => {
        if (cancelled) return;
        setGeoData({ categories: [], rows: [], grandTotal: {}, grandTotalAll: 0 });
        if (isSessionExpired(e)) setSessionExpired(true);
      })
      .finally(() => { if (!cancelled) setGeoLoading(false); });
    return () => { cancelled = true; };
  }, [geoMonth, brandFilter]);

  const toggleGeoState = useCallback((stateName) => {
    setExpandedGeoStates((prev) => {
      const next = new Set(prev);
      if (next.has(stateName)) next.delete(stateName); else next.add(stateName);
      return next;
    });
    setGeoCities((prev) => {
      if (prev.has(stateName)) return prev;
      const p = new URLSearchParams({ op: 'geoCategory', level: 'city', month: geoMonth, state: stateName });
      if (brandFilter !== 'ALL') p.set('brand', brandFilter);
      getJson(`/api/delivery-escalation/record?${p.toString()}`)
        .then((d) => setGeoCities((m) => new Map(m).set(stateName, { status: 'loaded', rows: d.rows })))
        .catch((e) => {
          setGeoCities((m) => new Map(m).set(stateName, { status: 'error', rows: [] }));
          if (isSessionExpired(e)) setSessionExpired(true);
        });
      return new Map(prev).set(stateName, { status: 'loading', rows: [] });
    });
  }, [geoMonth, brandFilter]);

  const toggleGeoCity = useCallback((stateName, cityName) => {
    const key = `${stateName}::${cityName}`;
    setExpandedGeoCities((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setGeoPincodes((prev) => {
      if (prev.has(key)) return prev;
      const p = new URLSearchParams({ op: 'geoCategory', level: 'pincode', month: geoMonth, state: stateName, city: cityName });
      if (brandFilter !== 'ALL') p.set('brand', brandFilter);
      getJson(`/api/delivery-escalation/record?${p.toString()}`)
        .then((d) => setGeoPincodes((m) => new Map(m).set(key, { status: 'loaded', rows: d.rows })))
        .catch((e) => {
          setGeoPincodes((m) => new Map(m).set(key, { status: 'error', rows: [] }));
          if (isSessionExpired(e)) setSessionExpired(true);
        });
      return new Map(prev).set(key, { status: 'loading', rows: [] });
    });
  }, [geoMonth, brandFilter]);

  // Builds the State -> City -> Pincode row tree the table actually renders from the raw
  // per-level responses plus which rows are currently expanded - a level not (yet) expanded
  // just has an empty cities/pincodes array, same "row exists, children lazy-load on expand"
  // idea as the ticket list's own AWB groups.
  const geoTree = useMemo(() => geoData.rows.map((s) => {
    const stateExpanded = expandedGeoStates.has(s.state);
    let cities = [];
    if (stateExpanded) {
      const entry = geoCities.get(s.state);
      const loaded = entry?.status === 'loaded' ? entry.rows : [];
      cities = loaded.length ? loaded.map((c) => {
        const cityKey = `${s.state}::${c.city}`;
        const cityExpanded = expandedGeoCities.has(cityKey);
        let pincodes = [];
        if (cityExpanded) {
          const pEntry = geoPincodes.get(cityKey);
          const pLoaded = pEntry?.status === 'loaded' ? pEntry.rows : [];
          pincodes = pLoaded.length
            ? pLoaded.map((p) => ({ ...p, key: `${cityKey}::${p.pincode}` }))
            : [{ pending: true, status: pEntry?.status || 'loading', key: `${cityKey}::pending` }];
        }
        return { ...c, key: cityKey, expanded: cityExpanded, pincodes };
      }) : [{ pending: true, status: entry?.status || 'loading', key: `${s.state}::pending` }];
    }
    return { ...s, key: s.state, expanded: stateExpanded, cities };
  }), [geoData.rows, expandedGeoStates, expandedGeoCities, geoCities, geoPincodes]);

  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [exporting, setExporting] = useState(false);
  const bulkFileInputRef = useRef(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('—');
  const [syncError, setSyncError] = useState(null);
  // Sticky once true - the fix is always "sign in again", and it needs to survive whatever
  // page/tab the agent is on when it's noticed (an export failure, a background poll, a save).
  const [sessionExpired, setSessionExpired] = useState(false);

  // Typing a search shouldn't fire a query per keystroke - the value the fetch actually uses
  // lags 350ms behind the input.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // dateDrill (set by clicking a day-wise bucket cell) overrides the manual date picker
  // entirely while active - the two are never combined. Memoized on the primitive values, not
  // just recomputed inline, so its identity is stable across renders it doesn't actually change
  // on - loadPage below depends on it, and an unstable identity would refire that effect (and
  // therefore refetch) on every render, not just on an actual filter change.
  const effectiveDateFilter = useMemo(() => (dateDrill
    ? { date: dateDrill.dateFrom, dateTo: dateDrill.dateTo, dateField: dateDrill.dateField, tatBucket: dateDrill.tatBucket }
    : { date: dateFilter, dateTo: dateFilterTo, dateField: dateFilterBasis, tatBucket: '' }
  ), [dateDrill, dateFilter, dateFilterTo, dateFilterBasis]);

  // Any change to what's being asked for restarts at page 1 - staying on page 12 of a filter
  // that now has 3 pages would just show an empty table.
  useEffect(() => { setPage(1); }, [tab, debouncedSearch, brandFilter, agentFilter, partnerFilter, dateFilter, dateFilterTo, dateFilterBasis, dateDrill, contactBucketFilter, perPage]);

  // Picking a preset (over)writes both dateFilter/dateFilterTo; 'custom' leaves them for the
  // agent to type; 'all' clears them (there's no preset that means "no filter" to compute a
  // range for).
  const handleDateRangePreset = (v) => {
    setDateRangePreset(v);
    safeStorage.setItem('de_date_range_preset', v);
    if (v === 'all') { setDateFilter(''); setDateFilterTo(''); return; }
    const range = dateRangeForPreset(v);
    if (range) { setDateFilter(range.from); setDateFilterTo(range.to); }
  };

  // Same shape as handleDateRangePreset above, own state - see daywiseDateRangePreset's comment.
  const handleDaywiseDateRangePreset = (v) => {
    setDaywiseDateRangePreset(v);
    safeStorage.setItem('de_daywise_date_range_preset', v);
    if (v === 'all') { setDaywiseDateFrom(''); setDaywiseDateTo(''); return; }
    const range = dateRangeForPreset(v);
    if (range) { setDaywiseDateFrom(range.from); setDaywiseDateTo(range.to); }
  };

  // Guards against a slow earlier request landing after a faster later one and overwriting the
  // newer rows - only the most recent request is allowed to apply its result.
  const reqIdRef = useRef(0);
  const listTab = tab === 'fresh' || tab === 'resolved' || tab === 'forced_rto' || tab === 'new_order_placed';

  const loadPage = useCallback(async (silent = false) => {
    if (!listTab) return;
    const reqId = ++reqIdRef.current;
    setSyncing(true);
    try {
      const res = await fetchPage({
        view: tab, page, perPage, search: debouncedSearch, brand: brandFilter, agent: agentFilter,
        contactBucket: contactBucketFilter, partner: partnerFilter, ...effectiveDateFilter,
      });
      if (reqId !== reqIdRef.current) return;
      setRows(res.rows);
      setTotal(res.total);
      setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setSyncError(null);
      if (!silent) showToast('Delivery-Escalation tickets synced');
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      console.error('Delivery-Escalation load failed:', e);
      setSyncError(e.message || 'Load failed');
      if (isSessionExpired(e)) setSessionExpired(true);
      else if (!silent) showToast(`⚠️ ${e.message}`);
    } finally {
      if (reqId === reqIdRef.current) setSyncing(false);
    }
  }, [listTab, tab, page, perPage, debouncedSearch, brandFilter, agentFilter, contactBucketFilter, partnerFilter, effectiveDateFilter, showToast]);

  const loadStats = useCallback(async () => {
    try {
      const { stats: s, agents: a, repeatStats: rs } = await fetchStats();
      setStats(s);
      setAgents(a);
      setRepeatStats(rs);
    } catch (e) {
      console.error('Delivery-Escalation stats failed:', e);
      setSyncError(e.message || 'Stats failed');
      if (isSessionExpired(e)) setSessionExpired(true);
    }
  }, []);

  // Overview-only, and unlike loadStats DOES take the current brand/agent filters (see
  // record.js's own op=daywise comment on why) - so it has to reload when either changes, not
  // just on the same interval/visibility ticks as the rest of the page.
  const loadDaywise = useCallback(async () => {
    if (tab !== 'overview') return;
    setDaywiseLoading(true);
    try {
      setDaywise(await fetchDaywiseStats({
        brand: brandFilter, agent: agentFilter, dateField: daywiseDateBasis,
        partner: daywisePartnerFilter, paymentMode: daywisePaymentModeFilter,
        dateFrom: daywiseDateFrom, dateTo: daywiseDateTo,
      }));
    } catch (e) {
      console.error('Delivery-Escalation daywise stats failed:', e);
      if (isSessionExpired(e)) setSessionExpired(true);
    } finally {
      setDaywiseLoading(false);
    }
  }, [tab, brandFilter, agentFilter, daywiseDateBasis, daywisePartnerFilter, daywisePaymentModeFilter, daywiseDateFrom, daywiseDateTo]);

  // Clicking a bucket cell in the day-wise table (a month/week's rolled-up count, or a single
  // day once expanded) jumps to the tab that actually holds those rows and filters the list down
  // to exactly this cell - the same brand/agent already applied to the table carries over
  // untouched. 'Forced to be marked as RTO' and 'unresolved' are each a whole view on their own
  // (see DE_DAYWISE_BUCKET_SQL's own comment), so no tatBucket is needed there; every other
  // bucket is a TAT slice WITHIN Resolved, so tatBucket narrows it to just that slice.
  const drillIntoDaywise = (dateFrom, dateTo, bucket) => {
    const view = bucket === 'Forced to be marked as RTO' ? 'forced_rto'
      : bucket === 'unresolved' ? 'fresh' : 'resolved';
    setDateDrill({ dateFrom, dateTo, dateField: daywiseDateBasis, tatBucket: view === 'resolved' ? bucket : '', bucket, view });
    setTab(view);
  };

  const refresh = useCallback(async (silent = true) => {
    // Once the session is known expired, every one of these will just 401 again - retrying
    // is dead weight (and, unsilenced, a fresh wall of identical toasts) until the agent
    // actually reloads and signs back in.
    if (sessionExpired) return;
    await Promise.all([loadPage(silent), loadStats(), loadDaywise()]);
  }, [loadPage, loadStats, loadDaywise, sessionExpired]);

  useEffect(() => { if (!sessionExpired) loadPage(true); }, [loadPage, sessionExpired]);
  useEffect(() => { if (!sessionExpired) loadStats(); }, [loadStats, sessionExpired]);
  useEffect(() => { if (!sessionExpired) loadDaywise(); }, [loadDaywise, sessionExpired]);
  // New rows land in Fresh from OUTSIDE this page entirely - the 2-hourly cron mirror and any
  // one-off backfill script write straight to MySQL, with no way to tell an open browser tab
  // it happened. Polling is the only way this page can find out, so Fresh polls 4x faster than
  // the other tabs (15s vs 60s) - its own page fetch measures ~200ms (see api/_lib/db.js's
  // getDeliveryEscalationPage), so the extra frequency costs nothing that matters for a handful
  // of concurrent agents. This is "shows up automatically within 15s", not a push/instant
  // update - a genuinely sub-second refresh would need a websocket/SSE channel this app has
  // nowhere else, for a data source (a 2-hourly cron) where 15s is already effectively instant.
  useEffect(() => {
    const intervalMs = tab === 'fresh' ? 15000 : 60000;
    const t = setInterval(() => { if (!document.hidden) refresh(true); }, intervalMs);
    return () => clearInterval(t);
  }, [refresh, tab]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) refresh(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const [detailTkt, setDetailTkt] = useState(null);
  // The label picked at each depth of the admin-configured disposition tree, e.g.
  // ["Escalated", "Awaiting Partner"] - same cascading-pick model as NDR's own ndrDispPath.
  // Truncated whenever a shallower level is re-picked; the written Outcome is this path joined
  // with " > ", not just the leaf, so a leaf label reused under two different parents (e.g.
  // "Others") stays unambiguous when read back later.
  const [dispPath, setDispPath] = useState([]);
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  // New Order Placed tab only: the reshipped order's own AWB, prefilled from the row (bulk
  // upload may already have set it) and editable. Mandatory when this tab's ticket is being
  // resolved to Delivered or RTO now - see newOrderAwbRequired below and
  // disposeDeliveryEscalationTicketById's own server-side copy of this rule.
  const [newOrderAwbInput, setNewOrderAwbInput] = useState('');
  // ANY tab: the ticket's own AWB, when it has none on file at all (order_id present, awb_code
  // missing/placeholder - see isAwbMissing/oldAwbRequired below). Nothing to prefill (that's the
  // whole problem), so this always starts blank.
  const [oldAwbInput, setOldAwbInput] = useState('');

  // dispLevels[i] = { type: 'single'|'multi'|'text', options }. Level 0 is always 'single' (the
  // top-level list has no parent to configure it); level i>0's type comes from whichever node
  // was picked at level i-1 (see api/_lib/db.js's children_input_type - Delivery-Escalation-only
  // control, see ProcessDispositionsCard's allowInputTypeControl prop below).
  //
  // multi and text are always a LEAF - picking a checkbox or typing text never drills into a
  // further level, even if the underlying option rows have children of their own (those rows
  // are simply not rendered in that case). single is the only type that keeps walking, exactly
  // like the old single-path-only behaviour this replaces.
  //
  // dispPath itself is unchanged: still one string per level - a label for 'single', a
  // ", "-joined string of checked labels for 'multi', or whatever was typed for 'text'. That's
  // deliberate: it's exactly the segment written into outcome (dispPath.join(' > ')) and read
  // back by openAction's split(' > '), so saving and re-opening needed no changes at all.
  const dispLevels = [{ type: 'single', options: processDispositions || [] }];
  {
    let nodes = processDispositions || [];
    for (let i = 0; ; i++) {
      if (dispLevels[i].type !== 'single') break; // multi/text already ended the path
      const node = dispPath[i] ? nodes.find(d => d.label === dispPath[i]) : null;
      if (!node) break;
      const childType = node.childrenInputType || 'single';
      if (childType !== 'single') {
        dispLevels.push({ type: childType, options: node.children || [] });
        break;
      }
      if (!node.children || !node.children.length) break; // true leaf, nothing further to pick
      nodes = node.children;
      dispLevels.push({ type: 'single', options: nodes });
    }
  }
  // "Complete" once every level up to the deepest one has a non-blank value - covers all three
  // types uniformly, since a 'single' pick is never blank by construction and 'multi'/'text'
  // are checked here instead of separately.
  const dispComplete = dispPath.length > 0 && dispLevels.length === dispPath.length && !!(dispPath[dispPath.length - 1] || '').trim();
  // New Order Placed only: dispPath[0] is the TOP-LEVEL outcome being picked right now (e.g.
  // "Delivered", "RTO", or still "Escalated" if left alone) - matches the top-level check
  // disposeDeliveryEscalationTicketById makes server-side off the SAME dispPath.join(' > ').
  const newOrderAwbRequired = tab === 'new_order_placed' && (dispPath[0] === 'Delivered' || dispPath[0] === 'RTO');
  // ANY tab: mandatory whenever this ticket has a real order_id but no AWB on file at all
  // (isAwbMissing mirrors DE_MISSING_AWB_WHERE) - unlike newOrderAwbRequired above, this doesn't
  // depend on which outcome is picked; disposing such a ticket at all requires the AWB.
  const oldAwbRequired = !!detailTkt && !detailTkt.readOnly
    && !!(detailTkt.orderId && String(detailTkt.orderId).trim()) && isAwbMissing(detailTkt.awb);
  const canSave = dispComplete && (!newOrderAwbRequired || !!newOrderAwbInput.trim())
    && (!oldAwbRequired || !!oldAwbInput.trim());
  const pickDisp = (level, label) => setDispPath(prev => [...prev.slice(0, level), label]);
  const toggleMultiDisp = (level, label) => setDispPath(prev => {
    const checked = (prev[level] || '').split(', ').filter(Boolean);
    const next = checked.includes(label) ? checked.filter(l => l !== label) : [...checked, label];
    return [...prev.slice(0, level), next.join(', ')];
  });
  const setTextDisp = (level, text) => setDispPath(prev => [...prev.slice(0, level), text]);

  const openAction = async (t) => {
    let ticket = t;
    if (!t.readOnly && !t.assignedAgent && googleUser?.email) {
      try {
        await claimMysqlTicket(t.mysqlId);
        ticket = { ...t, assignedAgent: googleUser.email };
        setRows(prev => prev.map(x => x.id === t.id ? ticket : x));
      } catch (e) {
        if (isSessionExpired(e)) setSessionExpired(true);
        else showToast(`⚠️ Could not claim ticket: ${e.message}`);
      }
    }
    setDetailTkt(ticket);
    // Best-effort re-walk of a previously-saved "A > B > C" path - if the tree changed since
    // (an option renamed/removed), this just falls short of dispComplete and the agent re-picks.
    setDispPath(ticket.outcome ? ticket.outcome.split(' > ').filter(Boolean) : []);
    setRemarks(ticket.remarks || '');
    setNewOrderAwbInput(ticket.newOrderAwb || '');
    setOldAwbInput('');
  };

  const saveAction = async () => {
    if (!detailTkt || !canSave) return;
    setSaving(true);
    try {
      const outcome = dispPath.join(' > ');
      const trimmedRemarks = remarks.trim();
      await disposeMysqlTicket(detailTkt.mysqlId, outcome, trimmedRemarks, newOrderAwbInput.trim(), oldAwbInput.trim());
      // The disposed ticket may now belong to the other tab (Delivered -> Resolved) or stay put
      // (Escalated/RTO are still Fresh) - refetch rather than guessing which, since the server
      // owns that classification.
      showToast('Resolution saved');
      // The server just cascaded this same outcome/remarks to every other still-open ticket for
      // this AWB (see disposeDeliveryEscalationTicketById's own comment) - if that AWB's
      // timeline is cached, it's now stale, so refetch it rather than leaving the expanded
      // children showing the pre-resolve outcome until next expand.
      if (detailTkt.awb && detailTkt.contactCount > 1) {
        const key = `${detailTkt.brand}|${detailTkt.awb}`;
        fetchAwbHistory(detailTkt.awb, detailTkt.brand)
          .then(rows => setAwbHistory(prev => new Map(prev).set(key, { status: 'loaded', rows })))
          .catch(() => setAwbHistory(prev => { const next = new Map(prev); next.delete(key); return next; }));
      }
      setDetailTkt(null);
      refresh(true);
    } catch (e) {
      if (isSessionExpired(e)) setSessionExpired(true);
      else showToast(`⚠️ Could not save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Fresh AND Forced RTO tabs' bulk outcome upload, AND New Order Placed's own bulk
  // `new_order_AWB` fill-in - parses client-side (so a header/column mistake shows up
  // immediately, before any network call) then sends the whole batch in one request, scoped
  // server-side to whichever tab is open (see bulkDisposeDeliveryEscalationByAwb's own
  // view-scoping). Resyncs after so every tab reflects whatever just moved - same reasoning as
  // saveAction's own post-dispose refresh.
  const handleBulkFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file (e.g. after fixing a typo) later
    if (!file) return;
    setBulkUploading(true);
    setBulkResult(null);
    try {
      const text = await file.text();
      const parsed = tab === 'new_order_placed' ? rowsFromNewOrderAwbCsv(text) : rowsFromBulkCsv(text);
      if (!parsed.length) {
        throw new Error(tab === 'new_order_placed'
          ? 'No valid rows found - need an AWB column and a New Order AWB column'
          : 'No valid rows found - need an AWB and an Outcome column');
      }
      const results = await bulkUploadOutcomes(parsed, tab);
      const unmatched = results.filter((r) => r.matched === 0);
      const matchedCount = results.length - unmatched.length;
      setBulkResult({ total: results.length, matchedCount, unmatched });
      showToast(`Bulk upload: ${matchedCount}/${results.length} matched`);
      // Could have touched any number of AWBs at once (each cascading, same as saveAction) -
      // no point diffing which; drop the timeline cache and collapse any open groups so
      // reopening one refetches fresh instead of showing a pre-upload outcome.
      setAwbHistory(() => new Map());
      setExpandedAwbGroups(() => new Set());
      refresh(true);
    } catch (err) {
      if (isSessionExpired(err)) setSessionExpired(true);
      else showToast(`⚠️ Bulk upload failed: ${err.message}`);
    } finally {
      setBulkUploading(false);
    }
  };

  // Exports the whole current view+filters, not the page on screen, no row-count ceiling - see
  // downloadCsv. A large table means several chunk requests, so the toast updates as they land
  // rather than sitting silent until the last one.
  const handleExport = async () => {
    setExporting(true);
    try {
      const { count } = await downloadCsv(
        { view: tab, search: debouncedSearch, brand: brandFilter, agent: agentFilter, contactBucket: contactBucketFilter, partner: partnerFilter, ...effectiveDateFilter },
        (soFar) => showToast(`Exporting… ${soFar.toLocaleString('en-IN')} rows so far`),
      );
      showToast(`Downloaded ${count.toLocaleString('en-IN')} rows`);
    } catch (e) {
      if (isSessionExpired(e)) setSessionExpired(true);
      else showToast(`⚠️ Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  // Collapses same-page duplicates (an AWB can legitimately appear more than once on one page)
  // down to a single row - NOT a re-sort, just a stable partition, so each group still surfaces
  // at the position of its first (i.e. newest, given the server's DESC order) member. That's
  // only ever a same-PAGE fix though: a repeat's other tickets usually land on a different page
  // entirely (this table isn't grouped by AWB server-side), which is what expanding via
  // contactCount + fetchAwbHistory below is actually for. Falls back to brand+orderId for the
  // ~144 rows with no AWB at all (see db.js's own note on those) - those can't repeat by AWB.
  const groupedTicketRows = useMemo(() => {
    const groups = new Map();
    const order = [];
    for (const t of rows) {
      const key = t.awb || `${t.brand}|${t.orderId}`;
      if (!groups.has(key)) { groups.set(key, t); order.push(key); }
    }
    return order.map((key) => groups.get(key));
  }, [rows]);

  const loadAwbHistoryInto = (key, awb, brand) => {
    setAwbHistory(prev => new Map(prev).set(key, { status: 'loading', rows: [] }));
    fetchAwbHistory(awb, brand)
      .then(rows => setAwbHistory(prev => new Map(prev).set(key, { status: 'loaded', rows })))
      .catch(e => setAwbHistory(prev => new Map(prev).set(key, { status: 'error', rows: [], error: e.message })));
  };

  // Expands one repeat row's timeline, fetching its full cross-view history the first time
  // (awbHistory is a cache, not just a loading flag - re-expanding after a collapse reuses it).
  const toggleAwbGroup = (parent) => {
    const opening = !expandedAwbGroups.has(parent.id);
    toggleExpanded(setExpandedAwbGroups, parent.id);
    if (!opening) return;
    const key = `${parent.brand}|${parent.awb}`;
    const existing = awbHistory.get(key);
    if (existing && existing.status !== 'error') return;
    loadAwbHistoryInto(key, parent.awb, parent.brand);
  };

  // A failed fetch retries without closing the row - clicking the error line itself, not the
  // parent row (which would just collapse it back).
  const retryAwbHistory = (parent) => loadAwbHistoryInto(`${parent.brand}|${parent.awb}`, parent.awb, parent.brand);

  // All counts come from SQL over the whole table (see fetchStats) rather than from the loaded
  // page - there's no client-side filtering or scoping left to do here.
  const unassignedCount = Math.max(stats.total - stats.assigned, 0);
  const resolutionRate = stats.assigned > 0 ? Math.round((stats.resolved / stats.assigned) * 100) : 0;

  const agentOptions = useMemo(
    () => [{ value: 'ALL', label: 'All Agents' }, ...agents.map(e => ({ value: e, label: e.split('@')[0] }))],
    [agents]
  );

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  // No per-process admin here (that concept comes from the roster this process doesn't have) -
  // only a company-wide admin manages the disposition list, same bar api/admin/[action].js's
  // handleDispositions enforces for POST/PUT/DELETE.
  // Filtered by this session's own Tab Access restriction (allowedDeTabs; null/empty =
  // unrestricted, same convention as invitedProcessKeys above) - 'admin' is never filtered by it,
  // that's gated by sessionIsAdmin alone (it's the panel THAT configures this restriction).
  const tabsList = [
    { key: 'overview', label: '📊 Overview', count: stats.total },
    { key: 'fresh', label: '⚡ Fresh', count: stats.fresh },
    { key: 'forced_rto', label: '↩️ Forced RTO', count: stats.forcedRto },
    { key: 'resolved', label: '✅ Resolved', count: stats.resolved },
    { key: 'new_order_placed', label: '🆕 New Order Placed', count: stats.newOrderPlaced },
    ...(sessionIsAdmin ? [{ key: 'admin', label: '🛡️ Admin Panel', count: (processDispositions || []).length }] : []),
  ].filter((t) => t.key === 'admin' || !allowedDeTabs || allowedDeTabs.includes(t.key));

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
                {syncError && !sessionExpired && (
                  <span className="text-rose-400 font-sans font-semibold" title={syncError}>
                    ⚠ Sync failed — showing cached data, retrying…
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2.5 flex-wrap justify-end">
            <button onClick={() => refresh(false)} disabled={syncing} className="h-8 px-2.5 sm:px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50 shrink-0" title="Refresh Delivery-Escalation data">
              <RefreshIcon className={syncing ? 'animate-spin text-indigo-400' : ''} />
              <span className="hidden md:inline">{syncing ? 'Syncing…' : 'Refresh'}</span>
            </button>
          </div>
        </div>
      </header>

      {toast && <div className="fixed top-16 right-5 z-50 animate-slideUp"><div className="px-4 py-2.5 rounded-xl bg-zinc-800/90 text-zinc-100 border border-zinc-700 text-[13px] shadow-2xl flex items-center gap-2.5 backdrop-blur-md"><CheckIcon className="text-emerald-400 shrink-0" />{toast}</div></div>}

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-5 py-5 space-y-5">
        {sessionExpired && (
          <div className="bg-amber-950/40 border border-amber-800/60 rounded-2xl p-5 shadow-xl backdrop-blur-md flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-[14px] font-bold text-amber-200">Your session has expired</h2>
              <p className="text-[13px] text-amber-100/80 mt-0.5">
                Reload the page and sign in again - nothing here will load or export until you do.
              </p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 text-[13px] font-semibold transition-colors shrink-0"
            >
              Reload page
            </button>
          </div>
        )}

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
                  onClick={() => { setDateDrill(null); setTab(t.key); }}
                  className={`relative px-4 py-2 rounded-xl text-[13px] font-bold whitespace-nowrap transition-all flex items-center gap-2.5 ${tab === t.key
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
              {syncError && !sessionExpired && (
                <div className="text-[12px] text-rose-400">⚠ {syncError} — retrying…</div>
              )}
              {bulkResult && (tab === 'fresh' || tab === 'forced_rto' || tab === 'new_order_placed') && (
                <div className="text-[12px] bg-zinc-900/70 border border-zinc-800 rounded-lg px-3 py-2 flex items-start justify-between gap-3">
                  <div>
                    <span className="text-zinc-300 font-semibold">Bulk upload: {bulkResult.matchedCount}/{bulkResult.total} matched.</span>
                    {bulkResult.unmatched.length > 0 && (
                      <div className="text-amber-400 mt-1">
                        Not matched (already resolved, or AWB not found): {bulkResult.unmatched.map(u => u.awb).join(', ')}
                      </div>
                    )}
                  </div>
                  <button onClick={() => setBulkResult(null)} className="text-zinc-500 hover:text-zinc-300 shrink-0"><XIcon /></button>
                </div>
              )}

              {tab === 'overview' && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Total Tickets</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{stats.total.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-500 mb-1">Assigned</p>
                    <p className="text-2xl font-extrabold text-indigo-400 tabular-nums">{stats.assigned.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-amber-900/50 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-1">Unassigned</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{unassignedCount.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-emerald-900/50 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-500 mb-1">Resolved</p>
                    <p className="text-2xl font-extrabold text-emerald-500 tabular-nums">{stats.resolved.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">{resolutionRate}% of assigned</p>
                  </div>
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Awaiting Resolution</p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{stats.fresh.toLocaleString('en-IN')}</p>
                  </div>
                </div>
              )}

              {tab === 'overview' && (
                <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                  <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                      TAT by {daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} Date
                    </p>
                    <div className="flex items-center gap-2">
                      {daywiseLoading && <span className="text-[11px] text-zinc-600">Loading…</span>}
                      <CustomSelect
                        value={daywiseDateBasis}
                        onChange={(v) => { setDaywiseDateBasis(v); safeStorage.setItem('de_daywise_date_basis', v); }}
                        options={[{ value: 'added_date', label: 'Query Date' }, { value: 'order_date', label: 'Order Date' }]}
                        placeholder="Date"
                      />
                      <CustomSelect
                        value={daywiseDateRangePreset}
                        onChange={handleDaywiseDateRangePreset}
                        options={DATE_RANGE_PRESET_OPTIONS}
                        placeholder="Date Range"
                      />
                      {daywiseDateRangePreset === 'custom' && (
                        <>
                          <input
                            type="date"
                            value={daywiseDateFrom}
                            onChange={(e) => setDaywiseDateFrom(e.target.value)}
                            title={`From (${daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} date)`}
                            className="h-8 px-3 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                          />
                          <input
                            type="date"
                            value={daywiseDateTo}
                            onChange={(e) => setDaywiseDateTo(e.target.value)}
                            title={`To (${daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} date)`}
                            className="h-8 px-3 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                          />
                        </>
                      )}
                      <CustomSelect
                        value={brandFilter}
                        onChange={(v) => { setBrandFilter(v); safeStorage.setItem('de_brand_filter', v); }}
                        options={[{ value: 'ALL', label: 'All Brands' }, ...BRANDS.map(b => ({ value: b, label: b }))]}
                        placeholder="Brand"
                      />
                      <CustomSelect
                        value={daywisePartnerFilter}
                        onChange={(v) => { setDaywisePartnerFilter(v); safeStorage.setItem('de_daywise_partner_filter', v); }}
                        options={[{ value: 'ALL', label: 'All Partners' }, ...PARTNER_FILTER_OPTIONS.map(p => ({ value: p, label: p }))]}
                        placeholder="Partner"
                      />
                      <CustomSelect
                        value={daywisePaymentModeFilter}
                        onChange={(v) => { setDaywisePaymentModeFilter(v); safeStorage.setItem('de_daywise_payment_mode_filter', v); }}
                        options={[{ value: 'ALL', label: 'All Payment Modes' }, ...PAYMENT_MODES.map(m => ({ value: m, label: m }))]}
                        placeholder="Payment Mode"
                      />
                    </div>
                  </div>
                  <p className="text-[12px] text-zinc-500 mb-3">
                    Every parcel (distinct AWB), bucketed by days since Query Date - resolved
                    parcels use their actual resolution date, still-open parcels use today's
                    date. % is each bucket's share of that date's own total.
                    {daywise.missingDateCount > 0 && (
                      <> {daywise.missingDateCount} parcel(s) have no {daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} date at all and can&apos;t
                        sit under any date row - counted only in Grand Total &rarr; unresolved.</>
                    )}
                  </p>
                  <div className="rounded-xl border border-zinc-800/80 overflow-hidden">
                    <div className="overflow-x-auto custom-scroll">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-zinc-800/80 text-zinc-500">
                            <th rowSpan={2} className="sticky left-0 z-10 bg-zinc-900 py-2 px-3 text-left font-medium align-bottom whitespace-nowrap">{daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} date</th>
                            {daywise.buckets.map((b) => (
                              <th key={b} colSpan={2} className="py-2 px-3 text-center font-medium border-l border-zinc-800/60 whitespace-nowrap">{b}</th>
                            ))}
                            <th rowSpan={2} className="py-2 px-3 text-right font-medium align-bottom border-l border-zinc-800/60 whitespace-nowrap">Grand Total</th>
                          </tr>
                          <tr className="border-b border-zinc-800/80 text-zinc-600 text-[11px]">
                            {daywise.buckets.flatMap((b) => ([
                              <th key={`${b}-n`} className="py-1 px-3 text-right font-medium border-l border-zinc-800/60"> </th>,
                              <th key={`${b}-pct`} className="py-1 px-3 text-right font-medium">%</th>,
                            ]))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {groupedDaywise.map((month) => {
                            const monthOpen = expandedMonths.has(month.key);
                            return (
                              <Fragment key={month.key}>
                                <tr
                                  onClick={() => toggleExpanded(setExpandedMonths, month.key)}
                                  className="group hover:bg-zinc-800/30 transition-colors cursor-pointer"
                                >
                                  <td className="sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800/30 transition-colors py-2 px-3 text-zinc-200 font-semibold whitespace-nowrap">
                                    <span className="inline-block w-4 text-zinc-500">{monthOpen ? '▾' : '▸'}</span>
                                    {formatDaywiseMonth(month.key)}
                                  </td>
                                  {daywise.buckets.flatMap((b) => {
                                    const count = month.counts[b] || 0;
                                    const days = month.days;
                                    return [
                                      <td
                                        key={`${b}-n`}
                                        onClick={count ? (e) => { e.stopPropagation(); drillIntoDaywise(days[0]?.date, days[days.length - 1]?.date, b); } : undefined}
                                        title={count ? `View these ${count.toLocaleString('en-IN')} ticket(s)` : undefined}
                                        className={`py-2 px-3 text-right text-zinc-200 font-semibold tabular-nums border-l border-zinc-800/60 ${count ? 'cursor-pointer hover:underline hover:text-indigo-400' : ''}`}
                                      >{count}</td>,
                                      <td key={`${b}-pct`} style={pctHeatStyle(month.pct[b])} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">{month.pct[b] || 0}%</td>,
                                    ];
                                  })}
                                  <td className="py-2 px-3 text-right text-zinc-100 font-bold tabular-nums border-l border-zinc-800/60">{month.total.toLocaleString('en-IN')}</td>
                                </tr>
                                {monthOpen && categoryBreakdownForDays(month.days, daywise.buckets).map((cat) => {
                                  const catKey = `${month.key}::${cat.category}`;
                                  const catOpen = expandedCategories.has(catKey);
                                  const catWeeks = catOpen ? buildCategoryWeeks(month.days, cat.category, daywise.buckets, catKey) : [];
                                  return (
                                    <Fragment key={catKey}>
                                      <tr
                                        onClick={() => toggleExpanded(setExpandedCategories, catKey)}
                                        className="group bg-zinc-950/10 hover:bg-zinc-800/30 transition-colors cursor-pointer"
                                      >
                                        <td className="sticky left-0 z-10 bg-zinc-950 group-hover:bg-zinc-800/30 transition-colors py-1.5 px-3 pl-8 text-zinc-500 text-[12px] italic whitespace-nowrap">
                                          <span className="inline-block w-4 text-zinc-600 not-italic">{catOpen ? '▾' : '▸'}</span>
                                          {cat.category}
                                        </td>
                                        {daywise.buckets.flatMap((b) => ([
                                          <td key={`${b}-n`} className="py-1.5 px-3 text-right text-zinc-500 text-[12px] tabular-nums border-l border-zinc-800/60">{cat.counts[b] || 0}</td>,
                                          <td key={`${b}-pct`} className="py-1.5 px-3 text-right text-zinc-600 tabular-nums text-[11px]">{cat.pct[b] || 0}%</td>,
                                        ]))}
                                        <td className="py-1.5 px-3 text-right text-zinc-400 text-[12px] tabular-nums border-l border-zinc-800/60">{cat.total.toLocaleString('en-IN')}</td>
                                      </tr>
                                      {catOpen && catWeeks.map((week) => {
                                        const weekOpen = expandedWeeks.has(week.key);
                                        return (
                                          <Fragment key={week.key}>
                                            <tr
                                              onClick={() => toggleExpanded(setExpandedWeeks, week.key)}
                                              className="group hover:bg-zinc-800/30 transition-colors cursor-pointer bg-zinc-950/20"
                                            >
                                              <td className="sticky left-0 z-10 bg-zinc-950 group-hover:bg-zinc-800/30 transition-colors py-1.5 px-3 pl-14 text-zinc-500 text-[12px] whitespace-nowrap">
                                                <span className="inline-block w-4 text-zinc-600">{weekOpen ? '▾' : '▸'}</span>
                                                {formatDaywiseWeek(week)}
                                              </td>
                                              {daywise.buckets.flatMap((b) => ([
                                                <td key={`${b}-n`} className="py-1.5 px-3 text-right text-zinc-400 text-[12px] tabular-nums border-l border-zinc-800/60">{week.counts[b] || 0}</td>,
                                                <td key={`${b}-pct`} className="py-1.5 px-3 text-right text-zinc-600 tabular-nums text-[11px]">{week.pct[b] || 0}%</td>,
                                              ]))}
                                              <td className="py-1.5 px-3 text-right text-zinc-300 text-[12px] tabular-nums border-l border-zinc-800/60">{week.total.toLocaleString('en-IN')}</td>
                                            </tr>
                                            {weekOpen && week.days.filter((r) => r.total > 0).map((r) => (
                                              <tr key={r.date} className="group hover:bg-zinc-800/30 transition-colors">
                                                <td className="sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800/30 transition-colors py-1.5 px-3 pl-20 text-zinc-500 text-[12px] whitespace-nowrap">{formatDaywiseDate(r.date)}</td>
                                                {daywise.buckets.flatMap((b) => ([
                                                  <td key={`${b}-n`} className="py-1.5 px-3 text-right text-zinc-500 text-[12px] tabular-nums border-l border-zinc-800/60">{r.counts[b] || 0}</td>,
                                                  <td key={`${b}-pct`} className="py-1.5 px-3 text-right text-zinc-600 tabular-nums text-[11px]">{r.pct[b] || 0}%</td>,
                                                ]))}
                                                <td className="py-1.5 px-3 text-right text-zinc-400 text-[12px] tabular-nums border-l border-zinc-800/60">{r.total.toLocaleString('en-IN')}</td>
                                              </tr>
                                            ))}
                                          </Fragment>
                                        );
                                      })}
                                    </Fragment>
                                  );
                                })}
                              </Fragment>
                            );
                          })}
                          {groupedDaywise.length === 0 && (
                            <tr><td colSpan={daywise.buckets.length * 2 + 2} className="py-8 text-center text-zinc-500">
                              {daywiseLoading ? 'Loading…' : 'No data.'}
                            </td></tr>
                          )}
                        </tbody>
                        {daywise.rows.length > 0 && (
                          <tfoot>
                            <tr className="border-t border-zinc-800/80 bg-zinc-950/40 font-semibold">
                              <td className="sticky left-0 z-10 bg-zinc-950 py-2 px-3 text-zinc-200 whitespace-nowrap">Grand Total</td>
                              {daywise.buckets.flatMap((b) => ([
                                <td key={`${b}-n`} className="py-2 px-3 text-right text-zinc-100 tabular-nums border-l border-zinc-800/60">{(daywise.grandTotal[b] || 0).toLocaleString('en-IN')}</td>,
                                <td key={`${b}-pct`} style={pctHeatStyle(daywise.grandTotalAll ? Math.round(((daywise.grandTotal[b] || 0) / daywise.grandTotalAll) * 100) : 0)} className="py-2 px-3 text-right text-zinc-500 tabular-nums text-[12px]">
                                  {daywise.grandTotalAll ? Math.round(((daywise.grandTotal[b] || 0) / daywise.grandTotalAll) * 100) : 0}%
                                </td>,
                              ]))}
                              <td className="py-2 px-3 text-right text-zinc-100 tabular-nums border-l border-zinc-800/60">{daywise.grandTotalAll.toLocaleString('en-IN')}</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'overview' && (
                <TatBreakdownTable
                  title="TAT by Delivery Partner"
                  description={`Same ${daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} Date buckets as above, grouped by delivery partner instead of by date.`}
                  rowHeader="Delivery Partner"
                  rows={groupedPartnerwise}
                  grandTotal={partnerwiseGrandTotal}
                  buckets={daywise.buckets}
                  loading={daywiseLoading}
                  expandedRows={expandedPartners}
                  toggleRow={(key) => toggleExpanded(setExpandedPartners, key)}
                  expandedMonths={expandedMonths}
                  toggleMonth={(key) => toggleExpanded(setExpandedMonths, key)}
                  expandedWeeks={expandedWeeks}
                  toggleWeek={(key) => toggleExpanded(setExpandedWeeks, key)}
                  getLabel={(row) => row.partner}
                  onDrill={drillIntoDaywise}
                />
              )}

              {tab === 'overview' && (
                <TatBreakdownTable
                  title="TAT by Query Class"
                  description={`Same ${daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} Date buckets as above, grouped by query class instead of by date.`}
                  rowHeader="Query Class"
                  rows={groupedCategorywise}
                  grandTotal={categorywiseGrandTotal}
                  buckets={daywise.buckets}
                  loading={daywiseLoading}
                  expandedRows={expandedQueryClasses}
                  toggleRow={(key) => toggleExpanded(setExpandedQueryClasses, key)}
                  expandedMonths={expandedMonths}
                  toggleMonth={(key) => toggleExpanded(setExpandedMonths, key)}
                  expandedWeeks={expandedWeeks}
                  toggleWeek={(key) => toggleExpanded(setExpandedWeeks, key)}
                  getLabel={(row) => row.category}
                  onDrill={drillIntoDaywise}
                />
              )}

              {tab === 'overview' && (
                <TatBreakdownTable
                  title="TAT by Repeat Contacts"
                  description={`Same ${daywiseDateBasis === 'order_date' ? 'Order' : 'Query'} Date buckets as above, grouped by how many times the customer came instead of by date.`}
                  rowHeader="Times Contacted"
                  rows={groupedContactBucketwise}
                  grandTotal={contactBucketwiseGrandTotal}
                  buckets={daywise.buckets}
                  loading={daywiseLoading}
                  expandedRows={expandedContactBuckets}
                  toggleRow={(key) => toggleExpanded(setExpandedContactBuckets, key)}
                  expandedMonths={expandedMonths}
                  toggleMonth={(key) => toggleExpanded(setExpandedMonths, key)}
                  expandedWeeks={expandedWeeks}
                  toggleWeek={(key) => toggleExpanded(setExpandedWeeks, key)}
                  getLabel={(row) => row.contactBucket}
                  onDrill={drillIntoDaywise}
                  subRowsFor={(row) => groupContactBucketPartnerwiseRows(daywise.rows, daywise.buckets, row.contactBucket)}
                  expandedSubRows={expandedContactBucketPartners}
                  toggleSubRow={(key) => toggleExpanded(setExpandedContactBucketPartners, key)}
                />
              )}

              {tab === 'overview' && (
                <GeoCategoryTable
                  month={geoMonth}
                  monthOptions={geoMonthOptions}
                  onMonthChange={setGeoMonth}
                  tree={geoTree}
                  categories={geoData.categories}
                  grandTotal={geoData.grandTotal}
                  grandTotalAll={geoData.grandTotalAll}
                  loading={geoLoading}
                  onToggleState={toggleGeoState}
                  onToggleCity={toggleGeoCity}
                />
              )}

              {tab === 'overview' && repeatStats.length > 0 && (
                <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">
                    Repeat contacts on unresolved complaints
                  </p>
                  <p className="text-[12px] text-zinc-500 mb-3">
                    Customers counted once per AWB, still waiting on a delivery.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {repeatStats.map(({ bucket, customers }) => (
                      <div key={bucket} className="bg-zinc-950/60 rounded-xl px-4 py-3 border border-zinc-800/80">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1">
                          Came {bucket}
                        </p>
                        <p className="text-xl font-extrabold text-zinc-100 tabular-nums">
                          {customers.toLocaleString('en-IN')}
                        </p>
                        <p className="text-[11px] text-zinc-500 font-medium mt-0.5">customers</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-3">
                    Total unresolved customers:{' '}
                    <span className="text-zinc-300 font-semibold tabular-nums">
                      {repeatStats.reduce((sum, r) => sum + r.customers, 0).toLocaleString('en-IN')}
                    </span>
                  </p>
                </div>
              )}

              {listTab && (
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
                        options={[{ value: 'ALL', label: 'All Brands' }, ...BRANDS.map(b => ({ value: b, label: b }))]}
                        placeholder="Brand"
                      />
                      {/* Everyone with access gets this - it is how an agent narrows the shared
                          desk down to their own tickets now that nothing is hidden from them. */}
                      <CustomSelect value={agentFilter} onChange={setAgentFilter} options={agentOptions} placeholder="Agent" />
                      <CustomSelect
                        value={partnerFilter}
                        onChange={(v) => { setPartnerFilter(v); safeStorage.setItem('de_partner_filter', v); }}
                        options={[{ value: 'ALL', label: 'All Partners' }, ...PARTNER_FILTER_OPTIONS.map(p => ({ value: p, label: p }))]}
                        placeholder="Partner"
                      />
                      {dateDrill ? (
                        // Set by clicking a day-wise bucket cell - a range plus a TAT bucket, which
                        // the plain date+basis inputs below can't represent, so they're swapped for
                        // one chip summarizing the drill-down until it's cleared.
                        <span className="h-8 px-3 flex items-center gap-2 text-[13px] bg-indigo-500/10 border border-indigo-500/40 rounded-lg text-indigo-300">
                          {dateDrill.dateFrom === dateDrill.dateTo
                            ? formatDaywiseDate(dateDrill.dateFrom)
                            : `${formatDaywiseDate(dateDrill.dateFrom)} – ${formatDaywiseDate(dateDrill.dateTo)}`}
                          {' · '}{dateDrill.bucket}
                          <button onClick={() => setDateDrill(null)} className="text-indigo-400 hover:text-white" title="Clear this drill-down">
                            <XIcon />
                          </button>
                        </span>
                      ) : (
                        <>
                          <CustomSelect
                            value={dateRangePreset}
                            onChange={handleDateRangePreset}
                            options={DATE_RANGE_PRESET_OPTIONS}
                            placeholder="Date Range"
                          />
                          {dateRangePreset === 'custom' && (
                            <>
                              <input
                                type="date"
                                value={dateFilter}
                                onChange={e => setDateFilter(e.target.value)}
                                title={`From (${dateFilterBasis === 'order_date' ? 'order' : 'query'} date)`}
                                className="h-8 px-3 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                              />
                              <input
                                type="date"
                                value={dateFilterTo}
                                onChange={e => setDateFilterTo(e.target.value)}
                                title={`To (${dateFilterBasis === 'order_date' ? 'order' : 'query'} date)`}
                                className="h-8 px-3 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                              />
                            </>
                          )}
                          <CustomSelect
                            value={dateFilterBasis}
                            onChange={(v) => { setDateFilterBasis(v); safeStorage.setItem('de_date_filter_basis', v); }}
                            options={[{ value: 'added_date', label: 'Query Date' }, { value: 'order_date', label: 'Order Date' }]}
                            placeholder="Date"
                          />
                        </>
                      )}
                      <CustomSelect
                        value={contactBucketFilter}
                        onChange={setContactBucketFilter}
                        options={CONTACT_BUCKET_OPTIONS}
                        placeholder="Total times user came"
                      />
                      {(tab === 'fresh' || tab === 'forced_rto' || tab === 'new_order_placed') && (
                        <>
                          <input
                            ref={bulkFileInputRef}
                            type="file"
                            accept=".csv,text/csv"
                            className="hidden"
                            onChange={handleBulkFile}
                          />
                          <button
                            onClick={() => bulkFileInputRef.current?.click()}
                            disabled={bulkUploading}
                            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                            title={tab === 'new_order_placed'
                              ? 'Bulk upload New Order AWB via CSV (columns: AWB, New Order AWB, optional Outcome - Outcome also disposes the ticket, e.g. Delivered or RTO).'
                              : 'Bulk upload outcomes via CSV (columns: AWB, Outcome, Remarks). For a child disposition, put the full path in Outcome, e.g. Escalated > Awaiting Partner.'}
                          >
                            {bulkUploading ? 'Uploading…' : '📤 Bulk Upload'}
                          </button>
                          <button
                            onClick={() => tab === 'new_order_placed' ? downloadNewOrderAwbSampleCsv() : downloadBulkSampleCsv(processDispositions)}
                            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors"
                            title="Download a sample CSV in the format Bulk Upload expects"
                          >
                            📋 Sample CSV
                          </button>
                        </>
                      )}
                      <button
                        onClick={handleExport}
                        disabled={exporting || total === 0}
                        className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                        title="Download every ticket matching the current filters as CSV"
                      >
                        {exporting ? 'Preparing…' : '⬇️ Download CSV'}
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                      <span>{total.toLocaleString('en-IN')} tickets</span>
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
                          {tab === 'new_order_placed' && <th className="py-3 px-4 text-left font-medium">New Order AWB</th>}
                          <th className="py-3 px-4 text-left font-medium">Delivery Partner</th>
                          <th className="py-3 px-4 text-left font-medium">Query Category</th>
                          <th className="py-3 px-4 text-left font-medium">Added Date</th>
                          <th className="py-3 px-4 text-left font-medium">Order Date</th>
                          <th className="py-3 px-4 text-left font-medium">TAT</th>
                          <th className="py-3 px-4 text-left font-medium">Times Contacted</th>
                          <th className="py-3 px-4 text-left font-medium">First Contact</th>
                          <th className="py-3 px-4 text-left font-medium">Agent Name</th>
                          <th className="py-3 px-4 text-left font-medium">Outcome</th>
                          <th className="py-3 px-4 text-left font-medium">Child Disposition</th>
                          {(tab === 'resolved' || tab === 'new_order_placed') && <th className="py-3 px-4 text-left font-medium">Action Date</th>}
                          {(tab === 'resolved' || tab === 'new_order_placed') && <th className="py-3 px-4 text-left font-medium">Remarks</th>}
                          {(tab === 'resolved' || tab === 'new_order_placed') && <th className="py-3 px-4 text-left font-medium">TAT Bucket</th>}
                          <th className="py-3 px-4 text-right font-medium">Action</th>
                        </tr></thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {groupedTicketRows.map((parent) => {
                            const hasRepeat = parent.contactCount !== '' && parent.contactCount > 1;
                            const isOpen = hasRepeat && expandedAwbGroups.has(parent.id);
                            const history = hasRepeat ? awbHistory.get(`${parent.brand}|${parent.awb}`) : null;
                            const childRows = history?.status === 'loaded'
                              ? history.rows.filter((t) => t.id !== parent.id) : [];
                            const colSpan = tab === 'new_order_placed' ? 18 : (tab === 'resolved' ? 17 : 14);
                            return (
                              <Fragment key={parent.id}>
                                <tr
                                  onClick={hasRepeat ? () => toggleAwbGroup(parent) : undefined}
                                  className={`hover:bg-zinc-800/30 active:bg-zinc-800/50 transition-colors ${hasRepeat ? 'cursor-pointer' : ''}`}
                                >
                                  <td className="py-3 px-4 text-zinc-300">
                                    {hasRepeat && (
                                      <span
                                        className={`inline-block w-4 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
                                      >▸</span>
                                    )}
                                    {parent.brand}
                                    {hasRepeat && (
                                      <span className="ml-1.5 text-[11px] tracking-wide text-amber-400 font-semibold tabular-nums">×{parent.contactCount}</span>
                                    )}
                                  </td>
                                  {ticketRowCells(parent, tab, openAction)}
                                </tr>
                                {isOpen && history?.status === 'loading' && (
                                  <tr className="animate-fadeIn"><td colSpan={colSpan} className="py-2 px-4 pl-8 text-zinc-500 text-[12px] border-l-2 border-indigo-500/20">
                                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 pulse-dot mr-2 align-middle"></span>
                                    Loading history…
                                  </td></tr>
                                )}
                                {isOpen && history?.status === 'error' && (
                                  <tr className="animate-fadeIn cursor-pointer" onClick={() => retryAwbHistory(parent)}>
                                    <td colSpan={colSpan} className="py-2 px-4 pl-8 text-rose-400 text-[12px] border-l-2 border-rose-500/30 hover:text-rose-300 transition-colors">
                                      Couldn&apos;t load history: {history.error} - click to retry
                                    </td>
                                  </tr>
                                )}
                                {isOpen && childRows.map((t) => (
                                  <tr key={t.id} className="bg-zinc-950/30 hover:bg-zinc-800/30 transition-colors animate-fadeIn">
                                    <td className="py-3 px-4 pl-8 text-zinc-500 text-[12px] whitespace-nowrap border-l-2 border-indigo-500/20">↳ {t.brand}</td>
                                    {ticketRowCells(t, tab, openAction, true)}
                                  </tr>
                                ))}
                              </Fragment>
                            );
                          })}
                          {groupedTicketRows.length === 0 && (
                            <tr><td colSpan={tab === 'new_order_placed' ? 18 : (tab === 'resolved' ? 17 : 14)} className="py-8 text-center text-zinc-500">
                              {syncing ? 'Loading…' : 'No tickets in this view.'}
                            </td></tr>
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

              {tab === 'admin' && sessionIsAdmin && (
                <ProcessDispositionsCard processLabel="Delivery-Escalation" disp={disp} allowInputTypeControl />
              )}
              {tab === 'admin' && sessionIsAdmin && <DeliveryPartnerAccessCard showToast={showToast} />}
            </div>
          </div>
        )}
      </main>

      {detailTkt && (
        <Overlay onClose={() => setDetailTkt(null)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 w-full max-w-lg space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-zinc-100">{detailTkt.readOnly ? 'Ticket Details' : 'Resolve Ticket'}</h3>
              <button onClick={() => setDetailTkt(null)} className="text-zinc-500 hover:text-zinc-300"><XIcon /></button>
            </div>
            <div className="text-[13px] text-zinc-400 space-y-1">
              <p><span className="text-zinc-500">Order ID:</span> {detailTkt.orderId} &nbsp; <span className="text-zinc-500">AWB:</span> {detailTkt.awb}</p>
              <p><span className="text-zinc-500">Brand:</span> {detailTkt.brand} &nbsp; <span className="text-zinc-500">Partner:</span> {detailTkt.deliveryPartner}</p>
              <p><span className="text-zinc-500">Query:</span> {detailTkt.queryClass} / {detailTkt.queryCategory}</p>
            </div>
            {detailTkt.readOnly ? (
              <div className="text-[13px] text-zinc-300 space-y-1 bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-2">
                <p><span className="text-zinc-500">Outcome:</span> {detailTkt.outcome || '—'}</p>
                <p><span className="text-zinc-500">Action Date:</span> {detailTkt.actionDate || '—'}</p>
                <p><span className="text-zinc-500">Agent:</span> {detailTkt.assignedAgent || '—'}</p>
                <p><span className="text-zinc-500">Remarks:</span> {detailTkt.remarks || '—'}</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[12px] font-semibold text-zinc-400 mb-1 block">Outcome</label>
                  {(processDispositions || []).length === 0 ? (
                    <p className="text-[12px] text-amber-400 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
                      No outcomes configured yet - an admin adds them from Admin Panel &rarr; Disposition List.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {dispLevels.map((lvl, level) => (
                        <div key={level}>
                          {lvl.type === 'text' ? (
                            <input
                              type="text"
                              value={dispPath[level] || ''}
                              onChange={(e) => setTextDisp(level, e.target.value)}
                              placeholder="Type the reason…"
                              className="w-full px-3 py-1.5 text-[12px] bg-zinc-950/60 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                            />
                          ) : (
                            <>
                              {lvl.type === 'multi' && (
                                <p className="text-[11px] text-zinc-500 mb-1">Select one or more:</p>
                              )}
                              <div className="flex flex-wrap gap-1.5">
                                {lvl.options.map(d => {
                                  const checked = lvl.type === 'multi'
                                    ? (dispPath[level] || '').split(', ').filter(Boolean).includes(d.label)
                                    : dispPath[level] === d.label;
                                  return (
                                    <button
                                      key={d.id}
                                      type="button"
                                      onClick={() => lvl.type === 'multi' ? toggleMultiDisp(level, d.label) : pickDisp(level, d.label)}
                                      title={d.description || undefined}
                                      className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors ${checked
                                          ? 'bg-indigo-600 border-indigo-500 text-white'
                                          : 'bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                                        }`}
                                    >
                                      {d.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {tab === 'new_order_placed' && (
                  <div>
                    <label className="text-[12px] font-semibold text-zinc-400 mb-1 block">
                      New Order AWB{newOrderAwbRequired && <span className="text-rose-400"> *</span>}
                    </label>
                    <input
                      type="text"
                      value={newOrderAwbInput}
                      onChange={e => setNewOrderAwbInput(e.target.value)}
                      placeholder="AWB the reshipped order closed out under"
                      className="w-full px-3 py-1.5 text-[13px] bg-zinc-950/60 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                    />
                    {newOrderAwbRequired && !newOrderAwbInput.trim() && (
                      <p className="text-[11px] text-rose-400 mt-1">Required to mark this Delivered or RTO.</p>
                    )}
                  </div>
                )}
                {oldAwbRequired && (
                  <div>
                    <label className="text-[12px] font-semibold text-zinc-400 mb-1 block">
                      AWB Number<span className="text-rose-400"> *</span>
                    </label>
                    <input
                      type="text"
                      value={oldAwbInput}
                      onChange={e => setOldAwbInput(e.target.value)}
                      placeholder="This ticket has no AWB on file - enter it to dispose"
                      className="w-full px-3 py-1.5 text-[13px] bg-zinc-950/60 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                    />
                    {!oldAwbInput.trim() && (
                      <p className="text-[11px] text-rose-400 mt-1">Required - this order has no AWB recorded yet.</p>
                    )}
                  </div>
                )}
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
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDetailTkt(null)} className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[13px] font-semibold transition-colors">{detailTkt.readOnly ? 'Close' : 'Cancel'}</button>
              {!detailTkt.readOnly && (
                <button
                  onClick={saveAction}
                  disabled={!canSave || saving}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[13px] font-semibold transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
