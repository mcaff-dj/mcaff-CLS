// Offline self-check for the nps_product export WHERE-builder in db.js - pure/offline,
// never opens a connection. Run with `node api/_lib/db.npsProductExport.test.js`.
const assert = require('assert');
const { buildNpsProductExportWhere } = require('./db');

(async () => {
  // 1. Date-only filter: half-open range on the parsed-date expression, `to` treated as
  //    end-of-day via DATE_ADD so a same-day range isn't empty.
  {
    const { where, params } = buildNpsProductExportWhere({ from: '2026-08-01', to: '2026-08-12' });
    assert.ok(where.includes('>= ?'), 'must have a lower bound');
    assert.ok(where.includes('DATE_ADD(?, INTERVAL 1 DAY)'), 'upper bound must be end-of-day inclusive');
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12']);
  }

  // 2. Missing from/to throws - this is the one enforcement point for "date range required".
  assert.throws(() => buildNpsProductExportWhere({ from: '', to: '2026-08-12' }), /from and to are required/);
  assert.throws(() => buildNpsProductExportWhere({ from: '2026-08-01', to: '' }), /from and to are required/);
  assert.throws(() => buildNpsProductExportWhere({}), /from and to are required/);

  // 3. A single brand value becomes a one-item IN(...), appended after the date params.
  {
    const { where, params } = buildNpsProductExportWhere({ from: '2026-08-01', to: '2026-08-12', brand: 'Mcaffeine' });
    assert.ok(where.includes('brand IN (?)'));
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12', 'Mcaffeine']);
  }

  // 4. Comma-separated multi-value brand filter, whitespace trimmed, duplicates collapsed.
  {
    const { where, params } = buildNpsProductExportWhere({
      from: '2026-08-01', to: '2026-08-12', brand: ' Mcaffeine, Hyphen ,Mcaffeine',
    });
    assert.ok(where.includes('brand IN (?,?)'));
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12', 'Mcaffeine', 'Hyphen']);
  }

  // 5. An empty/whitespace-only brand value is the same as omitting it entirely.
  {
    const { where, params } = buildNpsProductExportWhere({ from: '2026-08-01', to: '2026-08-12', brand: '  ,  ' });
    assert.ok(!where.includes('brand IN'));
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12']);
  }

  console.log('db.npsProductExport.test.js: all assertions passed');
})();
