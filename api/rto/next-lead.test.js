// Self-check for the pure selection logic in next-lead.js - the pieces most likely to
// silently drift from scripts/lead_priority.py, since they are hand-mirrored in a second
// language rather than shared code. No network, no DB, no sheet.
// Run with `node api/rto/next-lead.test.js`.
const assert = require('assert');

// next-lead.js's primary export is still the plain (req,res) handler every route in this repo
// uses (see api/_lambda/app.js's mount()) - these pure helpers are attached to it as properties
// specifically so this test exercises the SAME code the request path runs, not a hand-copied
// duplicate of it. See next-lead.js's own comment next to these exports.
const {
  isPrepaid, priorityTier, parseRtoInitiatedDate, buildCandidateList,
} = require('./next-lead.js');

// 1. is_prepaid mirror: explicit COD/Cash is COD, everything else defaults Prepaid - matches
// scripts/lead_priority.py:is_prepaid exactly, including its "anything else is Prepaid" default.
assert.strictEqual(isPrepaid('COD'), false);
assert.strictEqual(isPrepaid('cod'), false);
assert.strictEqual(isPrepaid('Cash on Delivery'), false);
assert.strictEqual(isPrepaid('Prepaid'), true);
assert.strictEqual(isPrepaid('UPI'), true);
assert.strictEqual(isPrepaid(''), true);
assert.strictEqual(isPrepaid(null), true);

// 2. priority_tier mirror: 0 Prepaid always, else 1/2/3 by reason substring, case-insensitive.
assert.strictEqual(priorityTier('Prepaid', 'Consignee Refused to Accept'), 0, 'prepaid always tier 0 regardless of reason');
assert.strictEqual(priorityTier('COD', 'Consignee Refused to Accept'), 1, 'high-priority COD reason');
assert.strictEqual(priorityTier('COD', 'Something unrelated'), 2, 'no matching reason -> tier 2');
assert.strictEqual(priorityTier('COD', 'OTP Verified Cancellation'), 3, 'low-priority COD reason');
assert.strictEqual(priorityTier('COD', ''), 2, 'blank reason -> tier 2, not a crash');

// 3. Date parsing mirror: DD-MM-YYYY[ HH:MM], bad/blank -> null (sorts last).
assert.deepStrictEqual(parseRtoInitiatedDate('19-07-2026 07:40'), new Date(Date.UTC(2026, 6, 19, 7, 40)));
assert.deepStrictEqual(parseRtoInitiatedDate('19-07-2026'), new Date(Date.UTC(2026, 6, 19, 0, 0)));
assert.strictEqual(parseRtoInitiatedDate(''), null);
assert.strictEqual(parseRtoInitiatedDate('not a date'), null);
assert.strictEqual(parseRtoInitiatedDate('31-02-2026'), null, 'Feb 31 must not silently roll into March');
assert.strictEqual(parseRtoInitiatedDate('2026-07-19'), null, 'wrong field order must not parse');

// 4. buildCandidateList: worked/assigned rows excluded, dedup keeps the first row per order id,
// sort is tier ascending then newest-first within a tier, undated rows sort last within theirs.
{
  const orderRows = [['A1'], ['A2'], ['A3'], ['A1'], ['A4'], ['A5']];
  const workRows = [
    { paymentMethod: 'COD', rtoReason: '', rtoInitiatedDate: '01-01-2026' },               // tier 2, older
    { paymentMethod: 'COD', rtoReason: '', rtoInitiatedDate: '15-01-2026', agent: 'someone@x.com' }, // ASSIGNED - excluded
    { paymentMethod: 'Prepaid', rtoReason: '', rtoInitiatedDate: '10-01-2026' },            // tier 0
    { paymentMethod: 'COD', rtoReason: '', rtoInitiatedDate: '20-01-2026' },                // duplicate order id (A1) - must be ignored
    { paymentMethod: 'COD', rtoReason: '', disposition: 'Delivered' },                      // WORKED - excluded
    { paymentMethod: 'COD', rtoReason: '', rtoInitiatedDate: '' },                          // tier 2, undated
  ];
  const candidates = buildCandidateList(orderRows, workRows);
  const ids = candidates.map((c) => c.orderId);
  assert.deepStrictEqual(ids, ['A3', 'A1', 'A5'], `expected [A3,A1,A5] (prepaid first, then dated COD, then undated COD), got ${ids}`);
  assert.strictEqual(candidates[0].tier, 0);
  assert.strictEqual(candidates[1].date.getTime(), new Date(Date.UTC(2026, 0, 1)).getTime(),
    'A1 must use its FIRST row (01-01-2026), not the later duplicate (20-01-2026)');
  assert.strictEqual(candidates[2].date, null, 'undated row must sort last within its tier, not crash the comparator');
}

// 5. "Unassigned" (case-insensitive) is treated the same as genuinely blank.
{
  const orderRows = [['B1']];
  const workRows = [{ agent: 'Unassigned', paymentMethod: 'COD', rtoReason: '' }];
  const candidates = buildCandidateList(orderRows, workRows);
  assert.strictEqual(candidates.length, 1, '"Unassigned" text in Column Q must still be selectable');
}

console.log('next-lead.test.js: all assertions passed');
