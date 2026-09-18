// Pure-function tests for merging NPS-Calling's two detractor pools (nps_delivery,
// nps_product) into one claim order. No DB, no network. Run: node api/_lib/detractorMerge.test.js
const assert = require('assert');
const { parseDdMmYyyy, pickOlderDetractorCandidate, poolAllowedByLeadTypeFilter, ymd, resolveDetractorRecencyBounds } = require('./detractorMerge');

// parseDdMmYyyy
assert.strictEqual(parseDdMmYyyy('27/04/2026'), new Date(2026, 3, 27).getTime());
assert.strictEqual(parseDdMmYyyy('01/12/2025'), new Date(2025, 11, 1).getTime());
assert.strictEqual(parseDdMmYyyy(null), null);
assert.strictEqual(parseDdMmYyyy(''), null);
assert.strictEqual(parseDdMmYyyy('not-a-date'), null);

// pickOlderDetractorCandidate: oldest-first (sortDirection 1, the default), neither candidate
// has a known product yet - pure date comparison, same behavior as before hasProduct existed.
const d = (submittedDate, hasProduct = false) => ({ submittedDate, hasProduct });
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2026'), d('15/01/2026')), 'delivery'); // delivery is older
assert.strictEqual(pickOlderDetractorCandidate(d('15/01/2026'), d('01/01/2026')), 'product'); // product is older
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2026'), d('01/01/2026')), 'delivery'); // tie -> deterministic

// newest-first (sortDirection -1) flips which pool wins
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2026'), d('15/01/2026'), -1), 'product'); // product is newer
assert.strictEqual(pickOlderDetractorCandidate(d('15/01/2026'), d('01/01/2026'), -1), 'delivery'); // delivery is newer

// One pool empty (its own claimFn returned nothing to peek): the other always wins, regardless
// of lead order.
assert.strictEqual(pickOlderDetractorCandidate(null, d('01/01/2026')), 'product');
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2026'), null), 'delivery');
assert.strictEqual(pickOlderDetractorCandidate(null, d('01/01/2026'), -1), 'product');
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2026'), null, -1), 'delivery');

// Both pools empty: nothing to claim from either.
assert.strictEqual(pickOlderDetractorCandidate(null, null), null);

// hasProduct is a real priority bucket, not a tie-break: it wins even against a MUCH older
// candidate in the other pool, in either lead-order direction.
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2020'), d('15/01/2026', true)), 'product');
assert.strictEqual(pickOlderDetractorCandidate(d('15/01/2026', true), d('01/01/2020')), 'delivery');
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2020'), d('15/01/2026', true), -1), 'product');
assert.strictEqual(pickOlderDetractorCandidate(d('15/01/2026', true), d('01/01/2020'), -1), 'delivery');

// Both have a known product (or both don't) - falls through to plain date comparison within
// that shared bucket, exactly like the no-hasProduct cases above.
assert.strictEqual(pickOlderDetractorCandidate(d('01/01/2026', true), d('15/01/2026', true)), 'delivery');
assert.strictEqual(pickOlderDetractorCandidate(d('15/01/2026', true), d('01/01/2026', true)), 'product');

// hasProduct still beats "nothing to peek" the same way a date candidate would - covered by the
// one-pool-empty cases above (d() defaults hasProduct to false), so no separate case needed.

// poolAllowedByLeadTypeFilter: unset/'' means Both - every existing agent's unrestricted
// behavior. A set filter allows only its own pool.
assert.strictEqual(poolAllowedByLeadTypeFilter('delivery', ''), true);
assert.strictEqual(poolAllowedByLeadTypeFilter('product', ''), true);
assert.strictEqual(poolAllowedByLeadTypeFilter('delivery', null), true);
assert.strictEqual(poolAllowedByLeadTypeFilter('product', undefined), true);
assert.strictEqual(poolAllowedByLeadTypeFilter('delivery', 'delivery'), true);
assert.strictEqual(poolAllowedByLeadTypeFilter('product', 'delivery'), false);
assert.strictEqual(poolAllowedByLeadTypeFilter('product', 'product'), true);
assert.strictEqual(poolAllowedByLeadTypeFilter('delivery', 'product'), false);

// ymd
assert.strictEqual(ymd(new Date(2026, 0, 5)), '2026-01-05');
assert.strictEqual(ymd(new Date(2026, 11, 31)), '2026-12-31');

// resolveDetractorRecencyBounds: both set -> used as-is, no 30-day fallback consulted
assert.deepStrictEqual(
  resolveDetractorRecencyBounds('2026-08-01', '2026-08-31', new Date(2026, 8, 16)),
  { from: '2026-08-01', to: '2026-08-31' },
);

// neither set -> 30-day-back-from-today fallback
assert.deepStrictEqual(
  resolveDetractorRecencyBounds(null, null, new Date(2026, 8, 16)),
  { from: '2026-08-17', to: '2026-09-16' },
);

// one-sided (shouldn't happen via setCallingDateRange, but must not crash or half-apply) ->
// falls back exactly like neither being set
assert.deepStrictEqual(
  resolveDetractorRecencyBounds('2026-08-01', null, new Date(2026, 8, 16)),
  { from: '2026-08-17', to: '2026-09-16' },
);
assert.deepStrictEqual(
  resolveDetractorRecencyBounds(null, '2026-08-31', new Date(2026, 8, 16)),
  { from: '2026-08-17', to: '2026-09-16' },
);

console.log('detractorMerge.test.js: all assertions passed');
