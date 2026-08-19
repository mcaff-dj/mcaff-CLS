// Self-check for the NPS aggregate calculation (npsScore.js) - turns raw 0-10 score-question
// answers into the promoter/passive/detractor buckets and the NPS number shown on the admin
// dashboard. Pure/offline: no DB. Run with `node api/_lib/npsScore.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) bucket boundaries off-by-one (6/7 and 8/9 are the actual NPS cutoffs) - would
//       silently misclassify scores right at the edge
//   (b) dividing by zero recipients producing NaN/Infinity instead of a "no data" state
const assert = require('assert');
const { computeNpsAggregate } = require('./npsScore');

// 1. Boundary scores classify correctly: 0-6 detractor, 7-8 passive, 9-10 promoter.
const boundaries = computeNpsAggregate([0, 6, 7, 8, 9, 10]);
assert.strictEqual(boundaries.detractors, 2); // 0, 6
assert.strictEqual(boundaries.passives, 2); // 7, 8
assert.strictEqual(boundaries.promoters, 2); // 9, 10
assert.strictEqual(boundaries.total, 6);

// 2. Known mix: 3 promoters, 2 passives, 3 detractors of 8 -> nps = (3-3)/8*100 = 0.
const mix = computeNpsAggregate([9, 9, 10, 8, 7, 6, 3, 0]);
assert.strictEqual(mix.promoters, 3);
assert.strictEqual(mix.passives, 2);
assert.strictEqual(mix.detractors, 3);
assert.strictEqual(mix.nps, 0);

// 3. All promoters -> nps = 100.
assert.strictEqual(computeNpsAggregate([9, 10, 10]).nps, 100);

// 4. All detractors -> nps = -100.
assert.strictEqual(computeNpsAggregate([0, 3, 6]).nps, -100);

// 5. No responses yet -> total 0, nps null (not NaN/Infinity) so the dashboard can show "no data".
const empty = computeNpsAggregate([]);
assert.strictEqual(empty.total, 0);
assert.strictEqual(empty.nps, null);

console.log('npsScore.test.js: all assertions passed');
