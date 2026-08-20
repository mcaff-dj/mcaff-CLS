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
  isPrepaid, priorityTier, parseRtoInitiatedDate, buildCandidateList, isEligibleNow,
  computeFillTarget, planFillRound,
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

// 6. isEligibleNow - the gate missing from the first version of this endpoint (Sayli,
// 2026-08-20: kept getting assigned for 14+ minutes after going OnCall, because nothing
// checked presence at all, only quota). Fresh-Online globally AND Online for rto, both
// required - matches scripts/assign_leads.py's fetch_online_agents intersection.
const NOW = new Date('2026-08-20T08:30:00Z').getTime();
const freshOnline = { status: 'Online', updatedAt: '2026-08-20T08:25:00Z' }; // 5 min old

assert.strictEqual(isEligibleNow(freshOnline, 'Online', NOW), true, 'Online both places, fresh heartbeat -> eligible');
assert.strictEqual(isEligibleNow({ status: 'OnCall', updatedAt: '2026-08-20T08:29:00Z' }, 'Online', NOW), false,
  'global status OnCall must block, even with a fresh heartbeat and Online-for-rto - this is the exact Sayli case');
assert.strictEqual(isEligibleNow(freshOnline, 'Busy', NOW), false, 'per-process Busy must block even if globally Online');
assert.strictEqual(isEligibleNow(freshOnline, 'Offline', NOW), false, 'per-process Offline must block');
assert.strictEqual(isEligibleNow(freshOnline, null, NOW), false, 'a failed per-process lookup must fail closed, not assume Online');
assert.strictEqual(isEligibleNow(null, 'Online', NOW), false, 'a failed/missing presence row must fail closed');

const staleOnline = { status: 'Online', updatedAt: '2026-08-20T08:15:00Z' }; // 15 min old
assert.strictEqual(isEligibleNow(staleOnline, 'Online', NOW), false, 'a stale heartbeat (>10min) must not count as Online');

const exactlyAtEdge = { status: 'Online', updatedAt: new Date(NOW - 10 * 60 * 1000).toISOString() };
assert.strictEqual(isEligibleNow(exactlyAtEdge, 'Online', NOW), false, 'exactly at the 10-minute boundary must be treated as stale, not fresh');

assert.strictEqual(isEligibleNow({ status: 'Online', updatedAt: 'not a date' }, 'Online', NOW), false,
  'an unparseable updatedAt must fail closed, not throw or be treated as fresh');

// 7. computeFillTarget - the arithmetic behind the fix for Rasika's exact case (1/20 with a
// huge backlog available): must fill the real gap, but never past whichever of the three
// bounds (headroom, per-request ceiling, candidates available) is tightest.
assert.strictEqual(computeFillTarget(20, 1, 1000, 25), 19, 'Rasika-shaped case: fill the full 19-lead gap');
assert.strictEqual(computeFillTarget(20, 19, 1000, 25), 1, 'near-quota: fill just the one open slot');
assert.strictEqual(computeFillTarget(20, 20, 1000, 25), 0, 'exactly at quota: nothing to fill');
assert.strictEqual(computeFillTarget(20, 1, 1000, 5), 5, 'per-request ceiling wins over a large headroom');
assert.strictEqual(computeFillTarget(20, 1, 3, 25), 3, 'candidate count wins when the pool itself is smaller than the gap');
assert.strictEqual(computeFillTarget(20, 25, 1000, 25), 0,
  'over quota (e.g. from a manual claim) must clamp to 0, never go negative');
assert.strictEqual(computeFillTarget(20, 1, 0, 25), 0, 'zero candidates -> zero target, not a crash');

// 8. planFillRound - the batched verify-response parser that replaced one GET per candidate
// (the direct cause of a real Sheets API 429 outage on 2026-08-20 once fills started handing
// out up to 25 leads per disposal). Google's batchGet omits `values` entirely for a genuinely
// blank cell rather than returning an empty array - the sparse-response case a naive
// `vr.values[0][0]` would throw on.
{
  const target = [{ orderId: 'A1', row: 5 }, { orderId: 'A2', row: 9 }, { orderId: 'A3', row: 12 }];
  const valueRanges = [
    {}, // A1's cell: genuinely blank - Google omits `values` entirely, not an empty array
    { values: [['someone.else@x.com']] }, // A2: lost the race to another claim/fill
    { values: [['Unassigned']] }, // A3: literal "Unassigned" text must count as free
  ];
  const { free, taken } = planFillRound(target, valueRanges);
  assert.deepStrictEqual(free.map((c) => c.orderId), ['A1', 'A3']);
  assert.deepStrictEqual(taken.map((c) => c.orderId), ['A2']);
}
{
  // A missing entry in valueRanges (shorter array than target, defensive against an
  // unexpected Sheets response shape) must not throw - treat as free rather than crash the fill.
  const target = [{ orderId: 'B1', row: 5 }];
  const { free, taken } = planFillRound(target, []);
  assert.deepStrictEqual(free.map((c) => c.orderId), ['B1']);
  assert.strictEqual(taken.length, 0);
}

console.log('next-lead.test.js: all assertions passed');
