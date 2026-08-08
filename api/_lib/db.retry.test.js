// Self-check for the Postgres connect-retry helper in db.js - the one piece of branching logic
// added for the EMAXCONNSESSION fix. Pure/offline: it never opens a connection, it only feeds
// the helper synthetic errors. Run with `node api/_lib/db.retry.test.js`.
//
// The dangerous failure mode is retrying something that ISN'T a connect refusal: a query that
// already partly ran would be re-applied. Case 2 below is what guards that.
const assert = require('assert');
const { isPoolExhausted, withPgConnectRetry, toTransactionModePooler } = require('./db');

function poolError() {
  return new Error('(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15');
}

(async () => {
  // 1. Recognises the real pooler refusal, and nothing that merely resembles it.
  assert.strictEqual(isPoolExhausted(poolError()), true);
  assert.strictEqual(isPoolExhausted(new Error('duplicate key value violates unique constraint')), false);
  assert.strictEqual(isPoolExhausted(undefined), false, 'must tolerate a thrown non-Error');

  // 2. A normal query error propagates on the FIRST throw - never retried.
  let calls = 0;
  await assert.rejects(
    withPgConnectRetry(async () => { calls++; throw new Error('syntax error at or near "SELCT"'); }),
    /syntax error/
  );
  assert.strictEqual(calls, 1, 'non-pool errors must not be retried');

  // 3. A pooler refusal is retried, and succeeds once capacity frees up.
  calls = 0;
  const value = await withPgConnectRetry(async () => {
    calls++;
    if (calls < 3) throw poolError();
    return 'rows';
  });
  assert.strictEqual(value, 'rows');
  assert.strictEqual(calls, 3);

  // 4. Retries are bounded - a permanently full pool eventually surfaces the real error
  //    rather than looping forever.
  calls = 0;
  await assert.rejects(
    withPgConnectRetry(async () => { calls++; throw poolError(); }),
    /EMAXCONNSESSION/
  );
  assert.strictEqual(calls, 5, 'initial attempt + PG_CONNECT_RETRIES (4)');

  // 5. Session-mode pooler URLs are moved to the transaction-mode port...
  const T = toTransactionModePooler;
  assert.strictEqual(
    T('postgres://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'),
    'postgres://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres'
  );
  // ...including when the port is omitted, since Postgres defaults it to 5432 anyway.
  assert.strictEqual(
    T('postgres://u:p@aws-0-ap-south-1.pooler.supabase.com/postgres?sslmode=require'),
    'postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require'
  );

  // 6. Everything else is left byte-for-byte alone. A direct Postgres host has nothing on
  //    6543, so rewriting one would be an outage, not a fix.
  for (const untouched of [
    'postgres://u:p@db.abcdefgh.supabase.co:5432/postgres',
    'postgres://u:p@mydb.abc123.ap-south-1.rds.amazonaws.com:5432/postgres',
    'postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    'postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:5433/postgres',
  ]) {
    assert.strictEqual(T(untouched), untouched, `must not rewrite: ${untouched}`);
  }

  // 7. A password containing the host pattern or reserved characters survives intact - the
  //    reason this is regex surgery on the host segment and not a URL parse/serialize.
  const trickyPw = 'postgres://u:5432%40aws-0-x.pooler.supabase.com@aws-0-ap-south-1.pooler.supabase.com:5432/db';
  assert.strictEqual(
    T(trickyPw),
    'postgres://u:5432%40aws-0-x.pooler.supabase.com@aws-0-ap-south-1.pooler.supabase.com:6543/db'
  );

  console.log('db.retry.test.js: all assertions passed');
})();
