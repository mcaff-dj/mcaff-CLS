// Pure rules for merging NPS-Calling's two detractor pools (nps_delivery, nps_product) into one
// claim order - no DB, no network, so which pool's oldest/newest candidate wins is unit-testable
// without a database. See docs/superpowers/specs/2026-09-06-nps-calling-product-leads-design.md.

// nps_delivery/nps_product both store submitted_date as DD/MM/YYYY text, never a real DATE
// column (confirmed against both tables' data) - same reasoning as getNextDetractorLead's own
// STR_TO_DATE use in db.js. Returns epoch ms, or null for an absent/malformed string so a bad
// value loses every comparison rather than sorting as "smallest" (year zero) or throwing.
function parseDdMmYyyy(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dateStr).trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
}

// Which pool's top candidate should be claimed next: 'delivery', 'product', or null if neither
// pool has anything left to peek. sortDirection matches getNextDetractorLead's own convention (1
// = oldest-first, the admin default; -1 = newest-first) - the SAME setting the delivery-only
// claim already used, now applied across both pools instead of within one.
//
// A pool with nothing to peek (its caller already found no eligible row) always loses to the
// other pool, regardless of lead order - "nothing" never outranks "something". A tie (identical
// submitted_date down to the day) resolves to 'delivery' deterministically rather than being
// arbitrary between runs - ties are already rare (same-day submissions across two different
// surveys) and no ordering has ever been promised between them.
function pickOlderDetractorCandidate(deliverySubmittedDate, productSubmittedDate, sortDirection = 1) {
  const d = parseDdMmYyyy(deliverySubmittedDate);
  const p = parseDdMmYyyy(productSubmittedDate);
  if (d == null && p == null) return null;
  if (d == null) return 'product';
  if (p == null) return 'delivery';
  if (d === p) return 'delivery';
  return (d - p) * sortDirection < 0 ? 'delivery' : 'product';
}

// Whether `pool` ('delivery' or 'product') is claimable under an agent's
// detractor_lead_type_filter ('' / null / undefined = Both, unrestricted - the pre-existing
// behavior for every agent who never had this filter set).
function poolAllowedByLeadTypeFilter(pool, leadTypeFilter) {
  return !leadTypeFilter || leadTypeFilter === pool;
}

// 'YYYY-MM-DD' from a JS Date, using its LOCAL getters (not toISOString, which converts to UTC
// first and can shift the day for a caller running behind UTC) - same convention
// getCallingHourlyStats already uses for a DATE column coming back from mysql2.
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Effective recency window for detractor lead eligibility: the admin's explicit date_from/date_to
// (calling_process_settings, Admin Panel's "Lead Date Range" card) when BOTH are set, else the
// 30-day-back-from-today window this process used before that control existed. A one-sided value
// (only one of dateFrom/dateTo set) is never a state setCallingDateRange allows to be saved, but
// this still falls back safely rather than trusting a half-set pair. `today` is injected so this
// is testable without mocking the system clock.
function resolveDetractorRecencyBounds(dateFrom, dateTo, today = new Date()) {
  if (dateFrom && dateTo) return { from: dateFrom, to: dateTo };
  const to = new Date(today);
  const from = new Date(today);
  from.setDate(from.getDate() - 30);
  return { from: ymd(from), to: ymd(to) };
}

module.exports = {
  parseDdMmYyyy, pickOlderDetractorCandidate, poolAllowedByLeadTypeFilter,
  ymd, resolveDetractorRecencyBounds,
};
