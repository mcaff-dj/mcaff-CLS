// Offline guard on bootstrapPgSchema's own statement list - reads db.js as TEXT, never opens a
// connection. Run with `node api/_lib/db.pgSchema.test.js`.
//
// Why this exists: bootstrapPgSchema wraps its whole ~45-statement DDL list in ONE try/catch
// that deliberately swallows "already exists" error codes and then marks the schema ready (see
// that catch's own comment for the concurrent-cold-start race it absorbs). That is safe only
// while every statement in the list is individually idempotent - `CREATE ... IF NOT EXISTS` /
// `ADD COLUMN IF NOT EXISTS` - because those only throw under a genuine, transient race that
// the NEXT container's run heals.
//
// Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so a bare `ADD CONSTRAINT` throws 42710
// (duplicate_object) on EVERY run after the first - permanently, not transiently. Swallowed by
// the function-level catch, that silently skipped every statement after it while still setting
// pgSchemaReady = true. Live consequence: the order_punch_* tables added below it on 2026-08-21
// were never created in production at all, and the Order Punch tab failed with
// `relation "order_punch_settings" does not exist` on a fully-deployed build.
//
// So: any non-idempotent DDL in that function needs its OWN try/catch, close enough to itself
// that a benign duplicate can't abort the statements after it. This test enforces that.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const lines = source.split(/\r?\n/);

// Bound the scan to bootstrapPgSchema's body - the MySQL ensureSchema() elsewhere in this file
// has its own separate error handling and is not what this guard is about.
const startIdx = lines.findIndex((l) => l.includes('async function bootstrapPgSchema()'));
assert.ok(startIdx !== -1, 'could not find bootstrapPgSchema in db.js - did it get renamed?');

// The function ends at the first line that is exactly a closing brace at column 0.
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i] === '}') { endIdx = i; break; }
}
assert.ok(endIdx !== -1, 'could not find the end of bootstrapPgSchema');

// Postgres DDL that has no IF NOT EXISTS form, so it throws a duplicate-object error on every
// run after the first rather than only under a race.
const NON_IDEMPOTENT = [/\bADD\s+CONSTRAINT\b/i];

const unguarded = [];
for (let i = startIdx; i < endIdx; i++) {
  const line = lines[i];
  if (line.trim().startsWith('//')) continue;
  if (!NON_IDEMPOTENT.some((re) => re.test(line))) continue;

  // Walk backwards over comments/blank lines looking for this statement's own `try {`. Three
  // code lines of slack is plenty for a `try {` plus the statement itself, while still
  // rejecting a statement that merely sits somewhere inside a much larger try block.
  let guarded = false;
  let codeLinesBack = 0;
  for (let j = i - 1; j >= startIdx && codeLinesBack < 3; j--) {
    const prev = lines[j].trim();
    if (!prev || prev.startsWith('//')) continue;
    codeLinesBack++;
    if (/\btry\s*\{/.test(prev)) { guarded = true; break; }
  }
  if (!guarded) unguarded.push(`db.js:${i + 1}: ${line.trim().slice(0, 110)}`);
}

assert.deepStrictEqual(
  unguarded, [],
  'Non-idempotent DDL in bootstrapPgSchema without its own try/catch. A benign duplicate error '
  + 'here is swallowed by the function-level catch, which then SKIPS every remaining statement '
  + 'while still marking the schema ready - see this file\'s header comment for the production '
  + `incident that caused. Offenders:\n  ${unguarded.join('\n  ')}`,
);

console.log('db.pgSchema.test.js: all assertions passed');
