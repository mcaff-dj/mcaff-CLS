// Offline self-check for triggerLambda's success/failure REPORTING - no AWS call, no network.
// Run with `node api/_lib/lambdaTrigger.test.js`.
//
// This return value is load-bearing: api/order-punch/start.js branches on it to mark a job
// 'failed' when the worker invoke never lands. Before it existed, a dropped invoke (worker
// Lambda not deployed, or the API's role missing lambda:InvokeFunction on it) left the job row
// at 'queued' forever with nothing anywhere explaining why - the 2026-08-21 Order Punch
// incident. If this contract silently regresses to always-undefined, that silence comes back,
// so it is pinned here.
//
// The AWS SDK is stubbed by pre-seeding require.cache before lambdaTrigger.js is loaded - it
// require()s '@aws-sdk/client-lambda' lazily inside its own functions, so a cache entry planted
// now is what it picks up. Plain Node, no mocking library, consistent with every other test in
// this repo.
const assert = require('assert');

const sdkPath = require.resolve('@aws-sdk/client-lambda');

// What the stubbed client should do on the next send() - reassigned per scenario below.
let sendBehavior = null;
const sent = [];

class FakeLambdaClient {
  async send(command) {
    sent.push(command.input);
    return sendBehavior();
  }
}
class FakeInvokeCommand {
  constructor(input) { this.input = input; }
}

require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: { LambdaClient: FakeLambdaClient, InvokeCommand: FakeInvokeCommand },
};

const { triggerLambda } = require('./lambdaTrigger');

// console.error is noise here - all three scenarios below log deliberately. Silenced so a
// passing run stays readable, restored before the final assertions print.
const realError = console.error;
console.error = () => {};

(async () => {
  // 1. AWS accepted the invoke (202) -> true, and the payload is passed through as JSON bytes.
  sendBehavior = () => ({ StatusCode: 202 });
  assert.strictEqual(await triggerLambda('some-fn', { jobId: 7 }), true, '202 must report success');
  assert.strictEqual(sent[0].FunctionName, 'some-fn');
  assert.strictEqual(sent[0].InvocationType, 'Event', 'must stay fire-and-forget');
  assert.deepStrictEqual(JSON.parse(sent[0].Payload.toString()), { jobId: 7 });

  // 2. Any other StatusCode -> false. AWS returns 202 for a successful async invoke, so
  //    anything else means the work was not queued, even though no error was thrown.
  sendBehavior = () => ({ StatusCode: 500 });
  assert.strictEqual(await triggerLambda('some-fn', { jobId: 8 }), false, 'non-202 must report failure');

  // 3. A thrown error (ResourceNotFoundException for an undeployed function,
  //    AccessDeniedException for a missing IAM grant - the two real 2026-08-21 causes) must be
  //    reported as false, NOT re-thrown: callers depend on this never breaking their own
  //    response.
  sendBehavior = () => { throw new Error('ResourceNotFoundException: Function not found'); };
  assert.strictEqual(await triggerLambda('missing-fn', { jobId: 9 }), false, 'a thrown SDK error must report failure');

  // 4. No payload -> no Payload key at all, preserving the original pre-extraction behavior
  //    that api/auth/[action].js's presence trigger relies on.
  sendBehavior = () => ({ StatusCode: 202 });
  assert.strictEqual(await triggerLambda('no-payload-fn'), true);
  assert.ok(!('Payload' in sent[sent.length - 1]), 'omitted payload must not send a Payload key');

  console.error = realError;
  console.log('lambdaTrigger.test.js: all assertions passed');
})().catch((e) => {
  console.error = realError;
  console.error(e);
  process.exit(1);
});
