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

module.exports = { parseDdMmYyyy, pickOlderDetractorCandidate };
