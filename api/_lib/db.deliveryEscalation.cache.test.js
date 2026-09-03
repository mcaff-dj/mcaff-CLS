// Self-check for the Delivery-Escalation Overview read cache - the guard added after every
// op=stats/op=daywise request died at the 30s gateway ceiling, because each mount, retry and
// 60s auto-refresh submitted another set of full-table aggregates on top of the ones still
// running. Pure/offline: it never opens a connection, the "queries" are counters. Run with
// `node api/_lib/db.deliveryEscalation.cache.test.js`.
//
// The dangerous failure mode here is NOT slowness, it's the cache key: allowedPartners is the
// per-session access floor (see deFilterSql), so a key that ignores it would serve a partner-
// restricted agent another caller's whole-desk numbers. Case 1 is that check.
const assert = require('assert');
const { cachedRead, invalidateCache, deCacheKey, DE_OVERVIEW_CACHE_TTL_MS, rtoMbpOutcome } = require('./db');

(async () => {
  // 0. rtoMbpOutcome: a Partner-role RTO dispose is relabeled to RTO_MBP, preserving any
  //    ' > '-joined sub-reason; every other role/outcome combination passes through untouched.
  assert.strictEqual(rtoMbpOutcome('RTO', 'Partner'), 'RTO_MBP');
  assert.strictEqual(rtoMbpOutcome('RTO > Refused Delivery', 'Partner'), 'RTO_MBP > Refused Delivery');
  assert.strictEqual(rtoMbpOutcome('RTO', 'Agent'), 'RTO', 'non-Partner roles must not be relabeled');
  assert.strictEqual(rtoMbpOutcome('RTO', 'Team Leader'), 'RTO');
  assert.strictEqual(rtoMbpOutcome('Delivered', 'Partner'), 'Delivered', 'only an RTO root is relabeled');
  assert.strictEqual(rtoMbpOutcome('', 'Partner'), '', 'a blank/omitted outcome must pass through as-is');
  assert.strictEqual(rtoMbpOutcome(null, 'Partner'), null);

  // 1. Different access floors NEVER share a cache entry, and an unrestricted caller is
  //    distinct from a restricted one.
  const wide = deCacheKey('stats', { allowedPartners: [] });
  const bd = deCacheKey('stats', { allowedPartners: ['Bluedart'] });
  const dl = deCacheKey('stats', { allowedPartners: ['Delhivery'] });
  assert.notStrictEqual(wide, bd, 'unrestricted and restricted must not share a key');
  assert.notStrictEqual(bd, dl, 'two different partner floors must not share a key');

  // 2. The same floor listed in a different order DOES share one entry - order is meaningless
  //    to the IN() this builds, so treating them as different keys would just halve the hit rate.
  assert.strictEqual(
    deCacheKey('stats', { allowedPartners: ['Bluedart', 'Delhivery'] }),
    deCacheKey('stats', { allowedPartners: ['Delhivery', 'Bluedart'] }),
  );

  // 3. Every other filter still separates entries - a brand-filtered view must not be served
  //    the unfiltered numbers.
  assert.notStrictEqual(
    deCacheKey('daywise', { allowedPartners: [], brand: 'HYPHEN' }),
    deCacheKey('daywise', { allowedPartners: [] }),
  );

  // 3b. allowedQueryCategories is its own access floor (see getDeliveryEscalationQueryCategoryAccess)
  //     - same order-insensitive-but-must-differ-from-unrestricted behavior as allowedPartners above.
  assert.notStrictEqual(
    deCacheKey('stats', { allowedQueryCategories: [] }),
    deCacheKey('stats', { allowedQueryCategories: ['Delivery Delay'] }),
  );
  assert.strictEqual(
    deCacheKey('stats', { allowedQueryCategories: ['Delivery Delay', 'Damaged'] }),
    deCacheKey('stats', { allowedQueryCategories: ['Damaged', 'Delivery Delay'] }),
  );
  // ...and the two ops never collide with each other.
  assert.notStrictEqual(deCacheKey('stats', {}), deCacheKey('daywise', {}));

  // 4. The Overview TTL is short enough that a stale tile can't outlive the tab's own 60s
  //    refresh by much - the whole point of the per-key override.
  assert.ok(DE_OVERVIEW_CACHE_TTL_MS <= 60000, 'Overview TTL must stay <= the 60s refresh');

  // 5. The storm case: N concurrent reads for one key collapse onto ONE query. This is what
  //    turns a mount's duplicate + retry traffic back into a single full-table scan.
  let calls = 0;
  const slow = () => cachedRead('de-test:storm', async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { total: 1 };
  }, DE_OVERVIEW_CACHE_TTL_MS);
  await Promise.all([slow(), slow(), slow(), slow(), slow(), slow()]);
  assert.strictEqual(calls, 1, 'concurrent identical Overview reads must share one query');

  // 6. A custom TTL actually expires - a 1ms TTL must re-query rather than pin the first answer.
  calls = 0;
  const brief = () => cachedRead('de-test:ttl', async () => { calls++; return 1; }, 1);
  await brief();
  await new Promise((r) => setTimeout(r, 5));
  await brief();
  assert.strictEqual(calls, 2, 'an expired custom TTL must re-query');

  // 7. A disposal's invalidateCache('de-') clears Overview entries and nothing else.
  calls = 0;
  let otherCalls = 0;
  await cachedRead('de-test:tile', async () => { calls++; return 1; }, DE_OVERVIEW_CACHE_TTL_MS);
  await cachedRead('calling:leadDates', async () => { otherCalls++; return 1; });
  invalidateCache('de-');
  await cachedRead('de-test:tile', async () => { calls++; return 1; }, DE_OVERVIEW_CACHE_TTL_MS);
  await cachedRead('calling:leadDates', async () => { otherCalls++; return 1; });
  assert.strictEqual(calls, 2, 'a disposal must invalidate the Overview tiles it changed');
  assert.strictEqual(otherCalls, 1, "a disposal must not throw away another desk's cache");

  console.log('db.deliveryEscalation.cache.test.js: all cases passed');
})();
