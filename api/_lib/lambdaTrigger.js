// Shared fire-and-forget Lambda invoke, used by every "don't make someone wait for the next
// scheduled pass" trigger in this app - originally lived only in api/auth/[action].js, pulled
// out here so api/rto/upload-start.js (the CSV upload feature) doesn't duplicate the AWS SDK
// invoke call in a second file.
let _lambdaClient = null;
function getLambdaClient() {
  if (!_lambdaClient) {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    _lambdaClient = new LambdaClient({});
  }
  return _lambdaClient;
}

// InvocationType 'Event' is fire-and-forget: this returns as soon as the invoke is *accepted*,
// not when the invoked function finishes. Best-effort by design - if the invoke call fails
// (e.g. a permissions gap), this silently no-ops rather than throwing, so a misconfigured
// setup never blocks whatever triggered it (an agent going online, a CSV upload finishing its
// fast half) from completing its own response.
//
// payload is optional and JSON-stringified when present - existing callers that pass nothing
// see byte-identical behavior to before this was extracted (no Payload key sent at all).
async function triggerLambda(functionName, payload) {
  try {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');
    const params = { FunctionName: functionName, InvocationType: 'Event' };
    if (payload !== undefined) {
      params.Payload = Buffer.from(JSON.stringify(payload));
    }
    const resp = await getLambdaClient().send(new InvokeCommand(params));
    if (resp.StatusCode !== 202) {
      console.error(`triggerLambda(${functionName}): unexpected StatusCode`, resp.StatusCode);
    }
  } catch (e) {
    console.error(`triggerLambda(${functionName}) error:`, e.message || e);
  }
}

module.exports = { triggerLambda, getLambdaClient };
