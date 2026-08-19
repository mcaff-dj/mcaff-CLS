// Self-check for the NPS survey link token (npsToken.js) - the HMAC-signed, per-recipient
// token embedded in the public survey link. Pure/offline: no DB, no network.
// Run with `node api/_lib/npsToken.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) a tampered token (flipped payload byte) verifying as valid - would let anyone answer
//       on behalf of any recipient by editing the link
//   (b) an expired token still verifying as valid - would let a stale/leaked link keep working
//   (c) expired vs. tampered not distinguishable - the public route needs to show "link expired"
//       (403) for one and "invalid link" (400) for the other
process.env.NPS_TOKEN_SECRET = 'test-secret';
const assert = require('assert');
const { signNpsToken, verifyNpsToken } = require('./npsToken');

// 1. Round-trip: sign then verify returns the original payload.
const token = signNpsToken({ recipientId: 42, exp: Math.floor(Date.now() / 1000) + 3600 });
const ok = verifyNpsToken(token);
assert.strictEqual(ok.valid, true);
assert.strictEqual(ok.expired, false);
assert.strictEqual(ok.payload.recipientId, 42);

// 2. Tampered token (flip a char in the payload segment) fails verification, not expiry.
const [body, mac] = token.split('.');
const tamperedBody = body.slice(0, -1) + (body.slice(-1) === 'A' ? 'B' : 'A');
const tampered = verifyNpsToken(`${tamperedBody}.${mac}`);
assert.strictEqual(tampered.valid, false);
assert.strictEqual(tampered.expired, false);

// 3. Expired token: signature valid, exp in the past -> valid=false, expired=true.
const expiredToken = signNpsToken({ recipientId: 42, exp: Math.floor(Date.now() / 1000) - 10 });
const expiredResult = verifyNpsToken(expiredToken);
assert.strictEqual(expiredResult.valid, false);
assert.strictEqual(expiredResult.expired, true);

// 4. Malformed token (no '.' separator) fails cleanly, doesn't throw.
const malformed = verifyNpsToken('not-a-real-token');
assert.strictEqual(malformed.valid, false);
assert.strictEqual(malformed.expired, false);

console.log('npsToken.test.js: all assertions passed');
