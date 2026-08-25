// Self-check for the "Avg Time to Dispose" maths (disposalGaps.js). No DB, no DOM.
// Run with `node api/_lib/disposalGaps.test.js`.
const assert = require('assert');
const { disposalGaps } = require('./disposalGaps');

// Timestamps are written in UTC with the IST time they represent noted beside them - the
// module keys days on a fixed +05:30, so the test has to be explicit about which day a
// timestamp lands in rather than relying on the machine's zone.
const utc = (day, h, m) => `2026-08-${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

// 1. The ordinary case. First disposal of the day has nothing to measure from, so it is null -
// not 0, which would read as "answered instantly" and drag the average down.
{
  const { gapByKey, averageMinutes } = disposalGaps([
    { key: 'a', disposedAt: utc('25', 4, 35) },   // 10:05 IST
    { key: 'b', disposedAt: utc('25', 4, 49) },  // 10:19 -> 14m
    { key: 'c', disposedAt: utc('25', 4, 56) },  // 10:26 -> 7m
  ]);
  assert.strictEqual(gapByKey.get('a'), null);
  assert.strictEqual(gapByKey.get('b'), 14);
  assert.strictEqual(gapByKey.get('c'), 7);
  assert.strictEqual(averageMinutes, 11); // (14 + 7) / 2 = 10.5 -> 11
}

// 2. Input order must not matter - the gap is against whatever disposal actually preceded it,
// and the caller's list is sorted by agent/order, not by time.
{
  const { gapByKey } = disposalGaps([
    { key: 'c', disposedAt: utc('25', 4, 56) },
    { key: 'a', disposedAt: utc('25', 4, 35) },
    { key: 'b', disposedAt: utc('25', 4, 49) },
  ]);
  assert.deepStrictEqual([gapByKey.get('a'), gapByKey.get('b'), gapByKey.get('c')], [null, 14, 7]);
}

// 3. A long same-day gap (a lunch break, a stretch away from the desk) counts at its real
// duration - no cutoff. The number is the actual time an agent took, breaks included.
{
  const { gapByKey, averageMinutes } = disposalGaps([
    { key: 'a', disposedAt: utc('25', 4, 35) },
    { key: 'b', disposedAt: utc('25', 4, 49) },  // 14m
    { key: 'lunch', disposedAt: utc('25', 6, 24) },  // 95m
    { key: 'd', disposedAt: utc('25', 6, 35) },  // 11m
  ]);
  assert.strictEqual(gapByKey.get('lunch'), 95);
  assert.strictEqual(averageMinutes, 40, 'mean of 14, 95 and 11, unfiltered');
}

// 4. Gaps never span a calendar day, or every agent's first call of the morning would carry
// the whole night. Yesterday's last disposal is not the predecessor of today's first.
{
  const { gapByKey, averageMinutes } = disposalGaps([
    { key: 'yesterday', disposedAt: utc('24', 14, 30) },
    { key: 'today1', disposedAt: utc('25', 4, 30) },
    { key: 'today2', disposedAt: utc('25', 4, 50) },
  ]);
  assert.strictEqual(gapByKey.get('today1'), null, 'first of the day, despite a previous entry');
  assert.strictEqual(gapByKey.get('today2'), 20);
  assert.strictEqual(averageMinutes, 20);
}

// 5. An agent with a single disposal has no measurable gap. null, not 0: "never got a second
// lead" and "answered instantly" are different facts.
assert.strictEqual(disposalGaps([{ key: 'a', disposedAt: utc('25', 4, 35) }]).averageMinutes, null);
assert.strictEqual(disposalGaps([]).averageMinutes, null);
assert.strictEqual(disposalGaps(null).averageMinutes, null);

// 6. Unparseable or missing timestamps are dropped rather than guessed into an order.
{
  const { gapByKey, averageMinutes } = disposalGaps([
    { key: 'bad', disposedAt: 'not a date' },
    { key: 'missing', disposedAt: null },
    { key: 'a', disposedAt: utc('25', 4, 35) },
    { key: 'b', disposedAt: utc('25', 4, 45) },
  ]);
  assert.strictEqual(gapByKey.has('bad'), false);
  assert.strictEqual(gapByKey.has('missing'), false);
  assert.strictEqual(averageMinutes, 10);
}

// 7. Date objects and epoch ms are accepted alongside ISO strings - leadDates hands back
// strings, but a caller holding a Date should not have to stringify it first.
{
  const base = Date.parse(utc('25', 4, 35));
  const { averageMinutes } = disposalGaps([
    { key: 'a', disposedAt: new Date(base) },
    { key: 'b', disposedAt: base + 9 * 60000 },
  ]);
  assert.strictEqual(averageMinutes, 9);
}

console.log('disposalGaps.test.js: all assertions passed');
