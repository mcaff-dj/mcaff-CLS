// Self-check for the short-lived read cache in db.js - the layer that keeps a few agents
// re-opening the Escalation desk from re-downloading the same multi-megabyte result set out of
// Supabase on every load. Pure/offline: it never opens a connection, the "queries" are counters.
// Run with `node api/_lib/db.cache.test.js`.
//
// The dangerous failure modes are (a) serving a stale set after a write - guarded by case 3 -
// and (b) pinning a rejected read for the whole TTL, so one blip breaks the desk for 30s -
// guarded by case 4.
const assert = require('assert');
const { cachedRead, invalidateCache, CACHE_TTL_MS } = require('./db');
const { etagMatches } = require('../escalation/[action]');

(async () => {
  // 1. A repeat read inside the TTL never reaches the database.
  let calls = 0;
  const read = () => cachedRead('escalation:orders:test', async () => { calls++; return ['row']; });
  assert.deepStrictEqual(await read(), ['row']);
  assert.deepStrictEqual(await read(), ['row']);
  assert.strictEqual(calls, 1, 'second read inside the TTL must be served from cache');

  // 2. Concurrent readers collapse onto ONE query - the page-load case (orders + assignments
  //    fired together), which a value-only cache would let race and run twice.
  calls = 0;
  const slow = () => cachedRead('escalation:concurrent', async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return 'rows';
  });
  const [a, b] = await Promise.all([slow(), slow()]);
  assert.strictEqual(a, 'rows');
  assert.strictEqual(b, 'rows');
  assert.strictEqual(calls, 1, 'concurrent identical reads must share one query');

  // 3. A write invalidates its own prefix and nothing else - an escalation resolve must not
  //    throw away the calling desk's cached lead dates.
  calls = 0;
  let otherCalls = 0;
  await cachedRead('escalation:orders:test2', async () => { calls++; return 1; });
  await cachedRead('calling:leadDates', async () => { otherCalls++; return 1; });
  invalidateCache('escalation:');
  await cachedRead('escalation:orders:test2', async () => { calls++; return 1; });
  await cachedRead('calling:leadDates', async () => { otherCalls++; return 1; });
  assert.strictEqual(calls, 2, 'invalidated key must be re-read');
  assert.strictEqual(otherCalls, 1, 'a different prefix must survive the invalidation');

  // 4. A failed read evicts itself instead of being replayed until the TTL expires.
  calls = 0;
  await assert.rejects(
    cachedRead('escalation:failing', async () => { calls++; throw new Error('connection terminated'); }),
    /connection terminated/
  );
  const recovered = await cachedRead('escalation:failing', async () => { calls++; return 'ok'; });
  assert.strictEqual(recovered, 'ok');
  assert.strictEqual(calls, 2, 'a rejected read must not be cached');

  // 5. The TTL is a real bound, not decorative - a stale entry is re-read once it lapses.
  assert.ok(CACHE_TTL_MS > 0 && CACHE_TTL_MS <= 120000, 'TTL must be short enough to bound staleness');

  // 6. ETag revalidation for /api/escalation/orders. A false positive here serves a stale queue,
  //    so the matching must be exact per tag - only the W/ prefix and surrounding space are
  //    ignored, never the tag body.
  const tag = 'W/"queue-1234-1699999999.5"';
  assert.strictEqual(etagMatches(tag, tag), true);
  assert.strictEqual(etagMatches('"queue-1234-1699999999.5"', tag), true, 'W/ prefix is not significant');
  assert.strictEqual(etagMatches(`W/"stale", ${tag}`, tag), true, 'If-None-Match is a list');
  assert.strictEqual(etagMatches('W/"queue-1234-1699999999.4"', tag), false, 'a changed table must not 304');
  assert.strictEqual(etagMatches('W/"fresh-leads-1234-1699999999.5"', tag), false, 'the other view must not 304');
  assert.strictEqual(etagMatches(undefined, tag), false, 'a client with no copy must not 304');
  assert.strictEqual(etagMatches('*', tag), false, 'wildcard must not 304 a client with no copy');

  console.log('db.cache.test.js: all cases passed');
})();
