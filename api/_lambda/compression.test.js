// Self-check for the gzip layer in app.js - the thing standing between the RTO sheet read and
// API Gateway's hard 6 MB response ceiling. Pure/offline: it builds a throwaway Express app with
// the same middleware and runs it through the real serverless-http handler with a synthetic
// API Gateway v2 event. No AWS, no network, no secrets.
// Run with `node api/_lambda/compression.test.js`.
//
// Why this test exists rather than "it obviously works": the failure mode is silent and total.
// If serverless-http does NOT flag the compressed body as base64, API Gateway ships the raw
// base64 text to the browser and every response becomes garbage - the same blank CRM, from the
// opposite direction. That contract lives in a dependency, so it gets asserted here rather than
// assumed.
//
// The things that must hold together (any one alone is not enough):
//   1. a large JSON response is actually compressed
//   2. serverless-http marks it isBase64Encoded, so API Gateway decodes rather than forwards
//   3. the round trip is byte-identical - compression must not corrupt the payload
//   4. the resulting Lambda envelope is comfortably under 6 MB
//   5. a gzip-only client still works
//   6. no Accept-Encoding degrades safely rather than corrupting
const assert = require('assert');
const zlib = require('zlib');
const express = require('express');
const compression = require('compression');
const serverlessHttp = require('serverless-http');

// Shaped like the real thing, and deliberately NOT more compressible than it. Sheet JSON is a mix
// of highly repetitive columns (dates, payment mode, disposition text) and high-entropy ones
// (names, addresses, phone numbers, order ids), and it is that mix that produces the ~75-85%
// reduction measured on production. An all-repetition fixture compresses ~98%, which would make
// the headroom assertion below pass no matter how badly the real ratio regressed - so the varied
// columns here are load-bearing, not decoration. Built inline so the test stays offline.
function makeSheetBody(rows) {
  const FIRST = ['Ashish', 'Alisha', 'Mansi', 'Arvind', 'Rohini', 'Salman', 'Madhavi', 'Prasanth', 'Naziya', 'Tanisha'];
  const LAST = ['Kumar', 'Hoda', 'Gupta', 'Singh', 'Sonwane', 'Khan', 'Derangula', 'Reddy', 'Sawant', 'Jain'];
  const CITY = ['Mumbai', 'Pune', 'Hyderabad', 'Chennai', 'Kolkata', 'Jaipur', 'Indore', 'Lucknow'];
  const REASON = ['Customer not available', 'Address incomplete', 'OTP verified cancellation',
    'RTO Pending - OTP validation', 'Consignee refused to accept', 'N/A'];
  const values = [];
  for (let i = 0; i < rows; i++) {
    // A cheap deterministic spread - no Math.random, so the fixture is stable run to run.
    const a = (i * 7919) % FIRST.length;
    const b = (i * 6271) % LAST.length;
    const c = (i * 4801) % CITY.length;
    const d = (i * 3313) % REASON.length;
    values.push([
      `HYP${41000000 + i * 13}`,
      `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      i % 3 === 0 ? 'Prepaid' : 'COD',
      REASON[d],
      `SRTP${5000000 + i * 17}`,
      `${FIRST[a]} ${LAST[b]}`,
      `9${String(800000000 + ((i * 31337) % 99999999)).slice(0, 9)}`,
      `${(i % 400) + 1}, ${CITY[c]} Road, ${CITY[c]} ${400000 + (i % 9999)}`,
      i % 5 === 0 ? 'agent.name@mcaffeine.com' : '',
      i % 5 === 0 ? 'Pending' : '',
    ]);
  }
  return JSON.stringify({ range: 'Data!A:Z', majorDimension: 'ROWS', values });
}

function v2Event(acceptEncoding) {
  const headers = { host: 'example.execute-api.ap-south-1.amazonaws.com' };
  if (acceptEncoding) headers['accept-encoding'] = acceptEncoding;
  return {
    version: '2.0',
    routeKey: 'GET /api/test',
    rawPath: '/api/test',
    rawQueryString: '',
    headers,
    requestContext: {
      http: { method: 'GET', path: '/api/test', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4' },
      stage: '$default',
    },
    isBase64Encoded: false,
  };
}

const BODY = makeSheetBody(14000);
const RAW_MB = Buffer.byteLength(BODY) / 1048576;

function buildHandler() {
  const app = express();
  app.use(compression({ level: 1 })); // same options as api/_lambda/app.js
  app.get('/api/test', (req, res) => res.json(JSON.parse(BODY)));
  return serverlessHttp(app);
}

(async () => {
  const handler = buildHandler();

  // ---- 1/2/3/4: a real browser, which offers brotli as well as gzip ----
  // Either encoding is acceptable and both are safe: serverless-http treats gzip, deflate AND br
  // as binary, and API Gateway only cares about the isBase64Encoded flag, not which codec produced
  // the bytes. Asserting "one of" rather than pinning one keeps this from failing the day
  // negotiation changes, while still proving the flag and the round trip.
  const res = await handler(v2Event('gzip, deflate, br'), {});
  const headers = res.headers || {};
  const encoding = headers['content-encoding'] || headers['Content-Encoding'];

  assert.ok(['gzip', 'br', 'deflate'].includes(encoding),
    `a large JSON response must be compressed, got content-encoding=${encoding}`);
  assert.strictEqual(res.isBase64Encoded, true,
    'serverless-http must flag a compressed body as base64 - without this API Gateway forwards raw base64 text to the browser');

  const compressed = Buffer.from(res.body, 'base64');
  const decode = { gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, deflate: zlib.inflateSync }[encoding];
  assert.strictEqual(decode(compressed).toString('utf8'), BODY,
    'decompressing must reproduce the exact payload, byte for byte');

  // What API Gateway actually measures against its 6 MB ceiling.
  const envelopeMb = Buffer.byteLength(JSON.stringify(res)) / 1048576;
  assert.ok(envelopeMb < 6, `Lambda response envelope must stay under 6 MB, got ${envelopeMb.toFixed(2)} MB`);
  // Guard the margin too, not just the pass/fail line - a regression that quietly halved the
  // compression ratio would still "pass" a bare < 6 check while eating all the headroom.
  assert.ok(envelopeMb < 3, `expected roughly 3x headroom, got ${envelopeMb.toFixed(2)} MB`);

  // ---- 5: a gzip-only client (older browser, some proxies) takes the gzip path ----
  const gzOnly = await handler(v2Event('gzip'), {});
  assert.strictEqual((gzOnly.headers || {})['content-encoding'], 'gzip');
  assert.strictEqual(gzOnly.isBase64Encoded, true);
  assert.strictEqual(zlib.gunzipSync(Buffer.from(gzOnly.body, 'base64')).toString('utf8'), BODY,
    'the gzip path must round-trip exactly too');

  // ---- 6: no Accept-Encoding must degrade safely, never corrupt ----
  const plain = await handler(v2Event(null), {});
  const plainEnc = (plain.headers || {})['content-encoding'];
  assert.ok(!plainEnc, 'without Accept-Encoding the response must not claim an encoding');
  assert.ok(!plain.isBase64Encoded, 'an uncompressed response must not be flagged base64');
  assert.strictEqual(plain.body, BODY, 'uncompressed path must return the payload unchanged');

  console.log(`  raw body                  ${RAW_MB.toFixed(2)} MB`);
  console.log(`  compressed envelope       ${envelopeMb.toFixed(2)} MB   (ceiling 6.00 MB, encoding ${encoding})`);
  console.log(`  reduction                 ${(100 - (envelopeMb / RAW_MB) * 100).toFixed(0)}%`);
  console.log('compression.test.js: all assertions passed');
})().catch((e) => {
  console.error('compression.test.js FAILED:', e.message);
  process.exit(1);
});
