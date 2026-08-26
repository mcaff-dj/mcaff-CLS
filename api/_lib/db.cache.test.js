// Self-check for the short-lived read cache in db.js - the layer that keeps a few agents
// re-loading the same desk from re-downloading the same multi-megabyte result set out of
// Supabase on every load. Pure/offline: it never opens a connection, the "queries" are counters.
// Run with `node api/_lib/db.cache.test.js`.
//
// The dangerous failure modes are (a) serving a stale set after a write - guarded by case 3 -
// and (b) pinning a rejected read for the whole TTL, so one blip breaks the desk for 30s -
// guarded by case 4.
const assert = require('assert');
const { cachedRead, invalidateCache, CACHE_TTL_MS } = require('./db');

(async () => {
  // 1. A repeat read inside the TTL never reaches the database.
  let calls = 0;
  const read = () => cachedRead('test:orders:test', async () => { calls++; return ['row']; });
  assert.deepStrictEqual(await read(), ['row']);
  assert.deepStrictEqual(await read(), ['row']);
  assert.strictEqual(calls, 1, 'second read inside the TTL must be served from cache');

  // 2. Concurrent readers collapse onto ONE query - the page-load case (orders + assignments
  //    fired together), which a value-only cache would let race and run twice.
  calls = 0;
  const slow = () => cachedRead('test:concurrent', async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return 'rows';
  });
  const [a, b] = await Promise.all([slow(), slow()]);
  assert.strictEqual(a, 'rows');
  assert.strictEqual(b, 'rows');
  assert.strictEqual(calls, 1, 'concurrent identical reads must share one query');

  // 3. A write invalidates its own prefix and nothing else - a write to one desk must not
  //    throw away another desk's cached lead dates.
  calls = 0;
  let otherCalls = 0;
  await cachedRead('test:orders:test2', async () => { calls++; return 1; });
  await cachedRead('calling:leadDates', async () => { otherCalls++; return 1; });
  invalidateCache('test:');
  await cachedRead('test:orders:test2', async () => { calls++; return 1; });
  await cachedRead('calling:leadDates', async () => { otherCalls++; return 1; });
  assert.strictEqual(calls, 2, 'invalidated key must be re-read');
  assert.strictEqual(otherCalls, 1, 'a different prefix must survive the invalidation');

  // 4. A failed read evicts itself instead of being replayed until the TTL expires.
  calls = 0;
  await assert.rejects(
    cachedRead('test:failing', async () => { calls++; throw new Error('connection terminated'); }),
    /connection terminated/
  );
  const recovered = await cachedRead('test:failing', async () => { calls++; return 'ok'; });
  assert.strictEqual(recovered, 'ok');
  assert.strictEqual(calls, 2, 'a rejected read must not be cached');

  // 5. The TTL is a real bound, not decorative - a stale entry is re-read once it lapses.
  //
  // The ceiling is 5 minutes, not the 2 this originally asserted. The TTL was deliberately
  // widened from 30s to 300000ms in f123568 ("widen Postgres read-cache TTL to cut Supabase
  // egress"): the NDR/RTO lead-date full-table reads were cached for less time than the client's
  // own 5-minute poll interval, so nearly every poll re-pulled the whole table and pushed egress
  // past its 5GB quota. This assertion was never updated to match, so it failed silently -
  // nothing in this repo ran the tests until `npm test` was wired up.
  //
  // The bound itself still matters and is deliberately pinned to the current value rather than
  // given headroom: readCache is per-warm-container, so this figure is the ONLY thing bounding
  // how long one container serves data another container has already overwritten. Raising it
  // again should require editing this line and thinking about that.
  assert.ok(CACHE_TTL_MS > 0 && CACHE_TTL_MS <= 300000, 'TTL must be a real, finite bound on staleness');

  console.log('db.cache.test.js: all cases passed');
})();
