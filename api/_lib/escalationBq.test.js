// Offline test for escalationBq.js's pure merge/filter logic - no BigQuery, no Postgres, no
// network. Run with `node api/_lib/escalationBq.test.js`.
const assert = require('assert');
const { mergeOrderRow } = require('./escalationBq');

(async () => {
  // 1. A BigQuery row with no matching Postgres resolution merges through with resolution
  //    fields empty - this is the common case (a pending, never-touched order).
  const bqRow = {
    brand: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1', rowNumber: 5,
    addedDate: 'Aug 1, 2026', queryClass: 'Delivery', queryCategory: 'Delayed Order',
    deliveryPartnerName: 'Delhivery', orderDate: 'Jul 30, 2026', orderMonth: "7_Jul'26",
    queryDate: 'Aug 1, 2026', queryMonth: "8_Aug'26", whName: 'WH1', ticketNumber: 'T1',
    totalTimesConsumerReached: '2', statusAsPerAwb: 'RTO', updateFromLogistics: 'RTO',
    tat: 'Forced to be marked as RTO', city: 'Mumbai', state: 'Maharashtra',
  };
  const merged = mergeOrderRow(bqRow, null);
  assert.strictEqual(merged.sheetTab, 'HYPHEN', 'sheetTab must be derived from brand');
  assert.strictEqual(merged.rowNumber, 5);
  assert.strictEqual(merged.status, '', 'no resolution -> blank status, same as an unwritten sheet cell');
  assert.strictEqual(merged.totalTimesConsumerReached, '2', 'field name unchanged for the frontend');

  // 2. A resolved order is identifiable via its merged status - the caller (getEligibleOrders)
  //    is responsible for filtering these out, this function only merges.
  const resolved = mergeOrderRow(bqRow, { resolution: 'Delivered', agentRemarks: 'ok', newOrderId: 'HYP2', newAwb: 'AWB2' });
  assert.strictEqual(resolved.status, 'Delivered');
  assert.strictEqual(resolved.notes, 'ok');
  assert.strictEqual(resolved.newOrderId, 'HYP2');
  assert.strictEqual(resolved.awb, 'AWB2', 'the original sheet field name is "awb", not "newAwb"');

  console.log('escalationBq.test.js: all assertions passed');
})();
