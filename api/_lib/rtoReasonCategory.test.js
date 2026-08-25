// Self-check for the RTO-reason buckets shared by the Overview breakdown (api/_lib/db.js) and
// the RTO CRM roster's Priority Reasons picker. Pure/offline: no DB, no sheet, no React.
// Run with `node api/_lib/rtoReasonCategory.test.js`.
const assert = require('assert');
const { categorizeRtoReason, RTO_REASON_CATEGORIES } = require('./rtoReasonCategory');
const rules = require('./leadAssignmentRules.json');

// Order-sensitive: an OTP-flavoured cancellation must NOT fall through to Customer
// Refused/Cancelled, and an address problem must beat the UNAVAILABLE keywords.
assert.strictEqual(categorizeRtoReason('rto pending - otp validated cancellation'), 'OTP/Verified Cancellation');
assert.strictEqual(categorizeRtoReason('customer refused to accept:Verified'), 'Customer Refused/Cancelled');
assert.strictEqual(categorizeRtoReason('Address not traceable'), 'Address Issue');
assert.strictEqual(categorizeRtoReason('Customer not available at address'), 'Address Issue');
assert.strictEqual(categorizeRtoReason('Consignee not available'), 'Customer Unavailable/Unreachable');
assert.strictEqual(categorizeRtoReason('Customer asked to reattempt tomorrow'), 'Reattempt/Future Delivery');

// Blank/placeholder inputs, and casing, are the two ways the sheet's free text actually varies.
for (const blank of ['', null, undefined, 'UNKNOWN', 'unknown', 'N/A', 'Others']) {
  assert.strictEqual(categorizeRtoReason(blank), 'Unknown/Other', `blank: ${blank}`);
}
assert.strictEqual(categorizeRtoReason('REFUSED TO ACCEPT'), categorizeRtoReason('refused to accept'));

// Every category the function can return must be listed in RTO_REASON_CATEGORIES - the picker
// renders unlisted ones last instead of dropping them, but a missing entry means the intended
// display order silently stopped applying.
const produced = new Set([...rules.highPriorityCodRtoReasons, ...rules.lowPriorityCodRtoReasons,
  'address not traceable', 'consignee not available', 'reattempt requested', ''].map(categorizeRtoReason));
for (const c of produced) assert.ok(RTO_REASON_CATEGORIES.includes(c), `unlisted category: ${c}`);

// The roster picker's own options: none may land in the Unknown/Other catch-all, which would
// mean a priority reason the assignment queue matches on is shown under a meaningless heading.
for (const opt of [...rules.highPriorityCodRtoReasons, ...rules.lowPriorityCodRtoReasons]) {
  assert.notStrictEqual(categorizeRtoReason(opt), 'Unknown/Other', `uncategorized picker option: ${opt}`);
}

console.log('rtoReasonCategory.test.js: all assertions passed');
