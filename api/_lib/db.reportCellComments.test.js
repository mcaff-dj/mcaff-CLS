// Offline self-check for shouldDeleteCellComment in db.js - pure/offline, never opens a
// connection. Run with `node api/_lib/db.reportCellComments.test.js`.
const assert = require('assert');
const { shouldDeleteCellComment } = require('./db');

(async () => {
  assert.strictEqual(shouldDeleteCellComment(''), true);
  assert.strictEqual(shouldDeleteCellComment('   '), true);
  assert.strictEqual(shouldDeleteCellComment(undefined), true);
  assert.strictEqual(shouldDeleteCellComment(null), true);
  assert.strictEqual(shouldDeleteCellComment('a note'), false);
  assert.strictEqual(shouldDeleteCellComment('  a note  '), false);

  console.log('db.reportCellComments.test.js: all assertions passed');
})();
