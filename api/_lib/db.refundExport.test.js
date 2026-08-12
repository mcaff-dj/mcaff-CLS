// Offline self-check for the refund_all_brands export WHERE-builder in db.js - pure/offline,
// never opens a connection. Run with `node api/_lib/db.refundExport.test.js`.
const assert = require('assert');
const { buildRefundExportWhere } = require('./db');

(async () => {
  // 1. Date-only filter: half-open range on the parsed-date expression, `to` treated as
  //    end-of-day via DATE_ADD so a same-day range isn't empty.
  {
    const { where, params } = buildRefundExportWhere({ from: '2026-08-01', to: '2026-08-12' });
    assert.ok(where.includes('>= ?'), 'must have a lower bound');
    assert.ok(where.includes('DATE_ADD(?, INTERVAL 1 DAY)'), 'upper bound must be end-of-day inclusive');
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12']);
  }

  // 2. Missing from/to throws - this is the one enforcement point for "date range required".
  assert.throws(() => buildRefundExportWhere({ from: '', to: '2026-08-12' }), /from and to are required/);
  assert.throws(() => buildRefundExportWhere({ from: '2026-08-01', to: '' }), /from and to are required/);
  assert.throws(() => buildRefundExportWhere({}), /from and to are required/);

  // 3. A single status value becomes a one-item IN(...), appended after the date params.
  {
    const { where, params } = buildRefundExportWhere({ from: '2026-08-01', to: '2026-08-12', status: 'Completed' });
    assert.ok(where.includes('status IN (?)'));
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12', 'Completed']);
  }

  // 4. Comma-separated multi-value filters, whitespace trimmed, duplicates collapsed - and all
  //    three filter columns can combine in one query.
  {
    const { where, params } = buildRefundExportWhere({
      from: '2026-08-01', to: '2026-08-12',
      status: ' Completed, Failed ,Completed',
      refundType: 'Full',
      source: 'Shopify,Others',
    });
    assert.ok(where.includes('status IN (?,?)'));
    assert.ok(where.includes('refund_type IN (?)'));
    assert.ok(where.includes('source IN (?,?)'));
    assert.deepStrictEqual(params, [
      '2026-08-01', '2026-08-12', 'Completed', 'Failed', 'Full', 'Shopify', 'Others',
    ]);
  }

  // 5. An empty/whitespace-only filter value is the same as omitting it entirely.
  {
    const { where, params } = buildRefundExportWhere({ from: '2026-08-01', to: '2026-08-12', status: '  ,  ' });
    assert.ok(!where.includes('status IN'));
    assert.deepStrictEqual(params, ['2026-08-01', '2026-08-12']);
  }

  console.log('db.refundExport.test.js: all assertions passed');
})();
