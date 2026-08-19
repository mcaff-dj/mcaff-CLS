// Self-check for the CSAT (1-5) aggregate (npsCsat.js) - separate from npsScore.js's NPS
// (0-10) bucketing since the two scales and their "satisfied" definitions don't share math.
// Pure/offline: no DB. Run with `node api/_lib/npsCsat.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) "satisfied" boundary wrong - CSAT's standard top-2-box is 4 and 5, not just 5
//   (b) dividing by zero responses producing NaN instead of a "no data" state
const assert = require('assert');
const { computeCsatAggregate } = require('./npsCsat');

// 1. Top-2-box (4, 5) counted as satisfied; 1-3 not.
const mix = computeCsatAggregate([5, 5, 4, 3, 2, 1]);
assert.strictEqual(mix.total, 6);
assert.strictEqual(mix.satisfied, 3); // 5, 5, 4
assert.strictEqual(mix.satisfiedPct, 50);
assert.strictEqual(mix.average, 3.33);

// 2. All satisfied -> 100%.
assert.strictEqual(computeCsatAggregate([4, 5, 5]).satisfiedPct, 100);

// 3. None satisfied -> 0%.
assert.strictEqual(computeCsatAggregate([1, 2, 3]).satisfiedPct, 0);

// 4. No responses yet -> total 0, average/satisfiedPct null (not NaN).
const empty = computeCsatAggregate([]);
assert.strictEqual(empty.total, 0);
assert.strictEqual(empty.average, null);
assert.strictEqual(empty.satisfiedPct, null);

console.log('npsCsat.test.js: all assertions passed');
