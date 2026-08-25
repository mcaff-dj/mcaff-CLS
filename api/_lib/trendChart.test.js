// Self-check for the Call Trend chart's pure axis/bucket math (trendChart.js). No DB, no DOM.
// Run with `node api/_lib/trendChart.test.js`.
const assert = require('assert');
const { bucketLabel, fillBuckets, enumerateKeys, isoWeekKey, niceMax, axisTicks, rollup, buildSeries } = require('./trendChart');

// 1. Labels. Fixed month table rather than Intl: the server buckets in IST, and letting a
// browser in another zone re-parse the key would shift a day-grain label by one day.
assert.strictEqual(bucketLabel('2026-08', 'month'), 'Aug 2026');
assert.strictEqual(bucketLabel('2026-01', 'month'), 'Jan 2026');
assert.strictEqual(bucketLabel('202634', 'week'), "W34 '26");
assert.strictEqual(bucketLabel('2026-08-25', 'day'), '25 Aug');

// 2. isoWeekKey must agree with MySQL YEARWEEK(d, 3), which is what the query groups by.
// 2026-01-01 is a Thursday, so it belongs to ISO week 1 of 2026 - the naive "first Monday"
// reading would put it in the previous year's last week.
assert.strictEqual(isoWeekKey(new Date('2026-01-01T00:00:00Z')), '202601');
assert.strictEqual(isoWeekKey(new Date('2026-08-25T00:00:00Z')), '202635');
// 2027-01-01 is a Friday: still ISO week 53 OF 2026, and the year prefix must follow the week,
// not the calendar - getting this wrong is what makes a year-boundary chart draw a phantom gap.
assert.strictEqual(isoWeekKey(new Date('2027-01-01T00:00:00Z')), '202653');

// 3. Gap filling: a day nobody dispositioned is a real zero, not a missing point. Dropping it
// would compress the x axis and make a dead stretch look busy.
{
  const filled = fillBuckets(
    [{ bucket: '2026-08-01', dialled: 10, connected: 4, converted: 2 },
     { bucket: '2026-08-03', dialled: 6, connected: 1, converted: 0 }],
    'day', '2026-08-01', '2026-08-04',
  );
  assert.deepStrictEqual(filled.map((b) => b.bucket),
    ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
  assert.deepStrictEqual(filled.map((b) => b.dialled), [10, 0, 6, 0]);
  assert.deepStrictEqual(filled.map((b) => b.label), ['01 Aug', '02 Aug', '03 Aug', '04 Aug']);
}

// 4. Month enumeration rolls the year over rather than running 13, 14, 15.
assert.deepStrictEqual(enumerateKeys('month', '2026-11', '2027-02', []),
  ['2026-11', '2026-12', '2027-01', '2027-02']);

// 5. Week enumeration walks real dates, because a year is not a fixed 52 weeks and
// 202653 + 1 is not 202701.
assert.deepStrictEqual(enumerateKeys('week', '2026-12-21', '2027-01-11', []),
  ['202652', '202653', '202701', '202702']);

// 6. No range given (the "everything" view): fall back to the keys the data actually has,
// sorted, rather than rendering nothing.
assert.deepStrictEqual(enumerateKeys('day', null, null, ['2026-08-03', '2026-08-01']),
  ['2026-08-01', '2026-08-03']);

// 7. Axis ceiling on the 1/2/5 ladder so gridlines read as round numbers.
assert.strictEqual(niceMax(37), 50);
assert.strictEqual(niceMax(204), 500);
assert.strictEqual(niceMax(1), 1);
assert.strictEqual(niceMax(0), 1, 'never 0 - the chart divides by the axis height');
assert.strictEqual(niceMax(-5), 1);
assert.deepStrictEqual(axisTicks(37, 4), [0, 12.5, 25, 37.5, 50]);
assert.deepStrictEqual(axisTicks(0, 2), [0, 0.5, 1]);

// 8. Roll-up. The query only ever groups by day; week/month are summed here so the week
// boundary has ONE definition (isoWeekKey above) rather than a second one in SQL.
{
  const daily = [
    { bucket: '2026-07-30', dialled: 5, connected: 2, converted: 1 },  // ISO week 202631
    { bucket: '2026-08-01', dialled: 3, connected: 1, converted: 0 },  // same week: Sat
    { bucket: '2026-08-03', dialled: 4, connected: 4, converted: 2 },  // Mon -> 202632
  ];
  assert.deepStrictEqual(rollup(daily, 'week'), [
    { bucket: '202631', dialled: 8, connected: 3, converted: 1 },
    { bucket: '202632', dialled: 4, connected: 4, converted: 2 },
  ], 'a week spanning a month boundary stays one bucket');
  assert.deepStrictEqual(rollup(daily, 'month'), [
    { bucket: '2026-07', dialled: 5, connected: 2, converted: 1 },
    { bucket: '2026-08', dialled: 7, connected: 5, converted: 2 },
  ]);
  assert.deepStrictEqual(rollup(daily, 'day').map((r) => r.bucket),
    ['2026-07-30', '2026-08-01', '2026-08-03'], 'day grain passes through untouched');
}

// 9. buildSeries end to end: roll up, then pad the picked range so an empty leading month
// still draws instead of the axis quietly starting where the data does.
{
  const series = buildSeries(
    [{ bucket: '2026-08-10', dialled: 9, connected: 3, converted: 1 }],
    'month', '2026-06-01', '2026-08-31',
  );
  assert.deepStrictEqual(series.map((b) => b.label), ['Jun 2026', 'Jul 2026', 'Aug 2026']);
  assert.deepStrictEqual(series.map((b) => b.dialled), [0, 0, 9]);
  assert.deepStrictEqual(series.map((b) => b.converted), [0, 0, 1]);
}

console.log('trendChart.test.js: all assertions passed');
