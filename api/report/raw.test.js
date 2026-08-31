// Offline self-check for raw.js's date-range filter (filterRawCsv/toIsoDate) - pure/offline,
// never touches S3/session, same pattern as fresh-export.test.js. Run with
// `node api/report/raw.test.js`.
const assert = require('assert');
const { filterRawCsv, toIsoDate } = require('./raw');

// 1. toIsoDate normalizes the sheet's M/D/YYYY (no leading zeros) to YYYY-MM-DD.
assert.strictEqual(toIsoDate('8/4/2026'), '2026-08-04');
assert.strictEqual(toIsoDate('12/1/2026'), '2026-12-01');
assert.strictEqual(toIsoDate('not a date'), null);
assert.strictEqual(toIsoDate(''), null);

// 2. filterRawCsv keeps only rows whose Created Date falls in [from, to] inclusive,
//    drops rows with an unparseable date, and keeps the header even on an empty result.
const csv = '"Created Date","SKU"\r\n"8/1/2026","A"\r\n"8/4/2026","B"\r\n"8/10/2026","C"\r\n"garbage","D"\r\n';

assert.strictEqual(filterRawCsv(csv, '2026-08-02', '2026-08-04'), 'Created Date,SKU\n8/4/2026,B');
assert.strictEqual(
  filterRawCsv(csv, '2026-08-01', '2026-08-10'),
  'Created Date,SKU\n8/1/2026,A\n8/4/2026,B\n8/10/2026,C'
);
assert.strictEqual(filterRawCsv(csv, '2027-01-01', '2027-01-02'), 'Created Date,SKU');

console.log('raw.test.js: all assertions passed');
