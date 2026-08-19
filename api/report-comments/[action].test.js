// Offline self-check for api/report-comments/[action].js - pure/offline, never opens a
// connection. Run with `node "api/report-comments/[action].test.js"`. getSession(req) with
// no cookie header returns null without touching the DB (see api/_lib/session.js's
// parseCookies/verify), so the 401 path is safely testable here; list/save's DB-touching
// happy paths are not (same convention as api/delivery-escalation/fresh-export.test.js).
const assert = require('assert');
const handler = require('./[action]');

(async () => {
  // 1. No session -> 401 on the list action.
  {
    let statusCode, body;
    const req = { method: 'GET', headers: {}, query: { action: 'list' } };
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    await handler(req, res);
    assert.strictEqual(statusCode, 401);
    assert.match(body.error, /Not signed in/);
  }

  // 2. No session -> 401 on the save action too (auth is checked before routing).
  {
    let statusCode, body;
    const req = { method: 'POST', headers: {}, query: { action: 'save' }, body: { page: 'mcaffeine', cellKey: 'x', text: 'y' } };
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    await handler(req, res);
    assert.strictEqual(statusCode, 401);
    assert.match(body.error, /Not signed in/);
  }

  // 3. No session -> 401 even for an unrecognized action (auth still checked first).
  {
    let statusCode, body;
    const req = { method: 'GET', headers: {}, query: { action: 'bogus' } };
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    await handler(req, res);
    assert.strictEqual(statusCode, 401);
    assert.match(body.error, /Not signed in/);
  }

  console.log('[action].test.js: all assertions passed');
})();
