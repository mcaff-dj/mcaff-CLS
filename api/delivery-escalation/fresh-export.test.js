// Offline self-check for fresh-export.js - pure/offline, never opens a connection. Run with
// `node api/delivery-escalation/fresh-export.test.js`. This endpoint has no auth (see its own
// header comment on why) - the only thing left to check without a live DB is the method guard.
const assert = require('assert');
const handler = require('./fresh-export');

(async () => {
  let statusCode, body;
  const req = { method: 'POST', headers: {} };
  const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await handler(req, res);
  assert.strictEqual(statusCode, 405);
  assert.match(body.error, /Method not allowed/);

  console.log('fresh-export.test.js: all assertions passed');
})();
