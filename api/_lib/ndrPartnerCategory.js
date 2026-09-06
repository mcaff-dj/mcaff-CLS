// Buckets a raw NDR "Courier Company" cell into a fixed set of canonical partner names, the
// same way rtoReasonCategory.js buckets rto_reason. Lives here (api/_lib/, CJS) so both
// api/_lib/db.js's getNdrCallingPartnerReasonBreakdown and any future consumer share one mapping.
//
// Unlike CLS_RTO_calling's delivery_partner (already clean names - Bluedart, Shadowfax,
// Pikendel, ...), the NDR sheet's Courier Company column carries Shiprocket-style compound
// service codes (e.g. "XBSRF_ Air_Direct", "DELHIVERY_NDD_DIRECT_H", "Pikndel_H_SDD") that
// encode courier + delivery-speed + mode in one string. Keyword matching (rather than an exact
// map) is what survives new service-tier suffixes appearing without this needing an update -
// same resilience argument as categorizeRtoReason's own comment.
function categorizeNdrPartner(rawPartner) {
  const p = (rawPartner || '').toUpperCase();
  if (!p || p === 'UNKNOWN' || p === 'N/A') return 'Unknown/Other';
  if (p.includes('BLUE DART') || p.includes('BLUEDART')) return 'Bluedart';
  // DLSRF = "Delhivery Surface" - no other courier code in this sheet starts with DL.
  if (p.includes('DELHIVERY') || p.includes('DLSRF')) return 'Delhivery';
  if (p.includes('PIKNDEL') || p.includes('PIKENDEL')) return 'Pikendel';
  // XBSRF = "Xpressbees Surface".
  if (p.includes('XBSRF') || p.includes('XPRESSBEES')) return 'Xpressbees';
  if (p.includes('SHADOWFAX')) return 'Shadowfax';
  if (p.includes('ELASTICRUN') || p.includes('ELASTIC RUN')) return 'ElasticRun';
  if (p.includes('DTDC')) return 'DTDC';
  if (p.includes('BLITZ')) return 'Blitz';
  return 'Unknown/Other';
}

// Display order for anything that lists the categories itself. Unknown/Other last: it is the
// catch-all, not a real partner - a nonzero count here after real data flows in is exactly the
// signal that a new raw courier code needs its own keyword added above.
const NDR_PARTNER_CATEGORIES = [
  'Bluedart', 'Delhivery', 'Pikendel', 'Xpressbees', 'Shadowfax', 'ElasticRun', 'DTDC', 'Blitz',
  'Unknown/Other',
];

module.exports = { categorizeNdrPartner, NDR_PARTNER_CATEGORIES };
