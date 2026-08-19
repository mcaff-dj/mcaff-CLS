// Offline self-check for resolveStatusForDeletion in db.js - pure/offline, never opens a
// connection. Run with `node api/_lib/db.mom.test.js`.
const assert = require('assert');
const { resolveStatusForDeletion } = require('./db');

(async () => {
  // 1. Orphaned tasks move to the remaining status with the lowest position.
  {
    const statuses = [
      { status_key: 'todo', position: 0 },
      { status_key: 'in_progress', position: 1 },
      { status_key: 'done', position: 2 },
    ];
    assert.strictEqual(resolveStatusForDeletion(statuses, 'in_progress'), 'todo');
  }

  // 2. Deleting the lowest-position status falls through to the next lowest.
  {
    const statuses = [
      { status_key: 'todo', position: 0 },
      { status_key: 'in_progress', position: 1 },
    ];
    assert.strictEqual(resolveStatusForDeletion(statuses, 'todo'), 'in_progress');
  }

  // 3. Position order is respected regardless of array order.
  {
    const statuses = [
      { status_key: 'done', position: 2 },
      { status_key: 'todo', position: 0 },
      { status_key: 'blocked', position: 1 },
    ];
    assert.strictEqual(resolveStatusForDeletion(statuses, 'todo'), 'blocked');
  }

  // 4. Refuses to delete the last remaining status.
  {
    const statuses = [{ status_key: 'todo', position: 0 }];
    assert.throws(() => resolveStatusForDeletion(statuses, 'todo'), /last status/);
  }

  // 5. Unknown key is an error, not a silent no-op.
  {
    const statuses = [{ status_key: 'todo', position: 0 }, { status_key: 'done', position: 1 }];
    assert.throws(() => resolveStatusForDeletion(statuses, 'missing'), /not found/);
  }

  console.log('db.mom.test.js: all assertions passed');
})();
