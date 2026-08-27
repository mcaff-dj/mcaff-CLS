// Self-check for the Sheets 429 retry in upload-start.js - the fix for a chunked upload dying
// mid-file on the app-wide "Read requests per minute per user" quota (see that file's comment on
// sheetsRequest). No network, no DB, no sheet: the client is a stub that counts calls.
// Run with `node api/rto/upload-start.test.js`.
const assert = require('assert');

// Attached to the handler export, same precedent as api/rto/next-lead.test.js - this exercises
// the code the request path actually runs, not a copy of it.
const { sheetsRequest, isRateLimited, SHEETS_MAX_ATTEMPTS } = require('./upload-start.js');

function quotaError(shape) {
  const e = new Error(
    "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per "
    + "user' of service 'sheets.googleapis.com' for consumer 'project_number:466555307255'."
  );
  if (shape === 'flat') e.status = 429; // newer gaxios
  else e.response = { status: 429 };    // older gaxios
  return e;
}

// 1. Both gaxios error shapes count as rate-limited; nothing else does.
assert.strictEqual(isRateLimited(quotaError('flat')), true);
assert.strictEqual(isRateLimited(quotaError('nested')), true);
const notQuota = new Error('bad range');
notQuota.status = 400;
assert.strictEqual(isRateLimited(notQuota), false);
assert.strictEqual(isRateLimited({ response: { status: 500 } }), false);
assert.strictEqual(isRateLimited(undefined), false);

// A stub client that throws `failures` times before succeeding, counting every attempt.
function stubClient(failures, err = () => quotaError('flat')) {
  let calls = 0;
  return {
    calls: () => calls,
    request: async () => {
      calls++;
      if (calls <= failures) throw err();
      return { data: { values: [['ok']] } };
    },
  };
}

(async () => {
  // 2. A transient 429 is retried and the call succeeds - this is the case that used to abort a
  // whole 16-chunk upload at chunk 3.
  const flaky = stubClient(2);
  const data = await sheetsRequest(flaky, 'GET', '/values/A1', undefined, 1);
  assert.deepStrictEqual(data, { values: [['ok']] });
  assert.strictEqual(flaky.calls(), 3, 'should have retried twice then succeeded');

  // 3. A non-429 is NOT retried - a bad range or a revoked credential must fail immediately
  // rather than burning 30s of backoff first.
  const hardFail = stubClient(1, () => notQuota);
  await assert.rejects(() => sheetsRequest(hardFail, 'GET', '/values/A1', undefined, 1), /bad range/);
  assert.strictEqual(hardFail.calls(), 1, 'non-429 must not be retried');

  // 4. Retrying is bounded - a sustained quota outage still surfaces the real Google message
  // instead of looping forever - bounded so API Gateway's 29s timeout never fires mid-backoff.
  const dead = stubClient(Infinity);
  await assert.rejects(
    () => sheetsRequest(dead, 'GET', '/values/A1', undefined, 1),
    /Quota exceeded for quota metric 'Read requests'/,
  );
  assert.strictEqual(dead.calls(), SHEETS_MAX_ATTEMPTS, `should stop after ${SHEETS_MAX_ATTEMPTS} attempts`);

  console.log('upload-start.test.js: all assertions passed');
})();
