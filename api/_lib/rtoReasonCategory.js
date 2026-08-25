// Buckets a free-text RTO reason into a fixed set of categories. Lives here (api/_lib/, CJS)
// rather than inside db.js because two separately-deployed bundles need the SAME buckets: the
// Lambda's getCallingRtoReasonBreakdown/-Funnel, and the Amplify app's Team Roster "Priority
// Reasons" picker, which groups its options under these headings so the roster and the
// Overview breakdown always name the same categories. Same shared-module pattern, and same
// deploy reason, as leadQuota.js / leadAssignmentRules.json beside it.
//
// rto_reason comes from the courier/system - not a controlled enum - so the same underlying
// reason shows up under several spellings ("Customer Refused To Accept" / "REFUSED TO ACCEPT"
// / "Customer refused to accept:Verified"), and new spellings can appear any time the sheet's
// upstream source changes. Keyword matching (rather than an exact-value map) is what makes
// this resilient to that drift; check order matters where a string could match more than one
// bucket (e.g. an OTP-flavoured cancellation must land in OTP, not Customer Refused/Cancelled).
function categorizeRtoReason(rawReason) {
  const r = (rawReason || '').toUpperCase();
  if (!r || r === 'UNKNOWN' || r === 'N/A' || r === 'OTHERS') return 'Unknown/Other';
  if (r.includes('OTP')) return 'OTP/Verified Cancellation';
  if (['ADDRESS', 'DELIVERY AREA', 'TRACEABLE', 'LOCATED', 'PINCODE', 'PIN CODE'].some((k) => r.includes(k))) {
    return 'Address Issue';
  }
  if (['REATTEMPT', 'FUTURE DELIVERY', 'RESCHEDULE', 'ANOTHER DATE', 'DELAY DELIVERY'].some((k) => r.includes(k))) {
    return 'Reattempt/Future Delivery';
  }
  if (r.includes('REFUS') || r.includes('CANCEL')) return 'Customer Refused/Cancelled';
  if (['UNAVAILABLE', 'NOT CONTACTABLE', 'NOT AVAILABLE', 'NOT ANSWERING', 'RECEIVER NOT', 'PNA',
       'OFFICE CLOSED', 'RESIDENCE CLOSED', 'HOUSE LOCKED', 'PERSON NOT MET', 'DOOR LOCK'].some((k) => r.includes(k))) {
    return 'Customer Unavailable/Unreachable';
  }
  return 'Unknown/Other';
}

// Display order for anything that lists the categories itself (the roster picker's group
// headers). The Overview breakdown does NOT use this - it sorts its own rows by volume.
// Unknown/Other last: it is the catch-all, not a real reason class.
const RTO_REASON_CATEGORIES = [
  'Customer Refused/Cancelled',
  'OTP/Verified Cancellation',
  'Customer Unavailable/Unreachable',
  'Address Issue',
  'Reattempt/Future Delivery',
  'Unknown/Other',
];

module.exports = { categorizeRtoReason, RTO_REASON_CATEGORIES };
