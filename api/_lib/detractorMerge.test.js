// Pure-function tests for merging NPS-Calling's two detractor pools (nps_delivery,
// nps_product) into one claim order. No DB, no network. Run: node api/_lib/detractorMerge.test.js
const assert = require('assert');
const { parseDdMmYyyy, pickOlderDetractorCandidate } = require('./detractorMerge');

// parseDdMmYyyy
assert.strictEqual(parseDdMmYyyy('27/04/2026'), new Date(2026, 3, 27).getTime());
assert.strictEqual(parseDdMmYyyy('01/12/2025'), new Date(2025, 11, 1).getTime());
assert.strictEqual(parseDdMmYyyy(null), null);
assert.strictEqual(parseDdMmYyyy(''), null);
assert.strictEqual(parseDdMmYyyy('not-a-date'), null);

// pickOlderDetractorCandidate: oldest-first (sortDirection 1, the default)
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', '15/01/2026'), 'delivery'); // delivery is older
assert.strictEqual(pickOlderDetractorCandidate('15/01/2026', '01/01/2026'), 'product'); // product is older
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', '01/01/2026'), 'delivery'); // tie -> deterministic

// newest-first (sortDirection -1) flips which pool wins
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', '15/01/2026', -1), 'product'); // product is newer
assert.strictEqual(pickOlderDetractorCandidate('15/01/2026', '01/01/2026', -1), 'delivery'); // delivery is newer

// One pool empty (its own claimFn returned nothing to peek): the other always wins, regardless
// of lead order.
assert.strictEqual(pickOlderDetractorCandidate(null, '01/01/2026'), 'product');
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', null), 'delivery');
assert.strictEqual(pickOlderDetractorCandidate(null, '01/01/2026', -1), 'product');
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', null, -1), 'delivery');

// Both pools empty: nothing to claim from either.
assert.strictEqual(pickOlderDetractorCandidate(null, null), null);

console.log('detractorMerge.test.js: all assertions passed');
