// Self-check for db.js's sql`` text/parameter split and its LIMIT sanitizer - pure, no database
// involved. Run with `node api/_lib/db.sqlLimit.test.js` (or via `npm test`).
//
// Why this exists: LIMIT cannot be a bound placeholder on this stack. mysql2 3.23.1 against
// PEP_CLS rejects `LIMIT ?` with ER_WRONG_ARGUMENTS ("Incorrect arguments to
// mysqld_stmt_execute"), which took out every NPS-Calling pool query at once - both the
// Next-to-Assign preview and every auto-assign trigger - while thousands of unclaimed Detractor
// leads sat in nps_delivery/nps_product. The fix splices the limit into the SQL text via raw(),
// which makes it the ONE spot in this file where a non-integer would be injectable, and makes
// bound-parameter ORDER something a silent typo could break. Both are asserted here.
const assert = require('assert');
const { buildSqlText, raw, safeLimit } = require('./db');

// safeLimit: only ever yields an integer in [1, 1000], and never throws.
assert.strictEqual(safeLimit(20, 20), 20);
assert.strictEqual(safeLimit(1, 1), 1);
assert.strictEqual(safeLimit('7', 20), 7);
assert.strictEqual(safeLimit(2.9, 20), 2, 'truncates rather than rounding');
assert.strictEqual(safeLimit(99999, 20), 1000, 'capped so a caller cannot ask for the whole table');
// Anything that is not a usable count falls back, rather than throwing - a preview or a peek is
// better served a sane page than a 500.
assert.strictEqual(safeLimit(undefined, 20), 20);
assert.strictEqual(safeLimit(null, 20), 20);
assert.strictEqual(safeLimit(0, 20), 20);
assert.strictEqual(safeLimit(-5, 20), 20);
assert.strictEqual(safeLimit('abc', 20), 20);
assert.strictEqual(safeLimit(NaN, 20), 20);
assert.strictEqual(safeLimit(Infinity, 20), 20);
// The injection cases: parseInt stops at the first non-digit, so no SQL ever survives the trip.
assert.strictEqual(safeLimit('7; DROP TABLE CLS_NPS_calling', 20), 7);
assert.strictEqual(safeLimit('1 OR 1=1', 20), 1);
assert.strictEqual(safeLimit('20 UNION SELECT password FROM users', 20), 20);
for (const bad of ['; DROP TABLE x', '-- x', "' OR '1'='1", '/**/', {}, [], () => {}]) {
  assert.strictEqual(safeLimit(bad, 20), 20, `must fall back for ${JSON.stringify(String(bad))}`);
}

// buildSqlText: ordinary values bind, in order.
{
  const { text, params } = buildSqlText(['SELECT ', ' AS a, ', ' AS b'], [1, 'x']);
  assert.strictEqual(text, 'SELECT ? AS a, ? AS b');
  assert.deepStrictEqual(params, [1, 'x']);
}

// null and undefined are real bound values, not raw markers - mysql2 rejects an undefined bind
// outright, and mistaking either for a marker would splice the string "null" into the SQL.
{
  const { text, params } = buildSqlText(['SELECT ', ', ', ''], [null, undefined]);
  assert.strictEqual(text, 'SELECT ?, ?');
  assert.deepStrictEqual(params, [null, undefined]);
}

// A raw() marker is spliced into the text and takes no parameter slot - the bound values on
// either side of it must keep their original order.
{
  const { text, params } = buildSqlText(
    ['SELECT ', ' WHERE b = ', ' LIMIT ', ''],
    ['a', 'b', raw(safeLimit(20, 20))],
  );
  assert.strictEqual(text, 'SELECT ? WHERE b = ? LIMIT 20');
  assert.deepStrictEqual(params, ['a', 'b'], 'raw() must not shift the bound-parameter order');
}

// A raw() marker before a bound value - same invariant from the other side.
{
  const { text, params } = buildSqlText(['SELECT ', ' , ', ''], [raw(1), 'x']);
  assert.strictEqual(text, 'SELECT 1 , ?');
  assert.deepStrictEqual(params, ['x']);
}

// An object that merely looks adjacent to a marker must still bind, not splice.
{
  const { text, params } = buildSqlText(['SELECT ', ''], [{ __raw: 5 }]);
  assert.strictEqual(text, 'SELECT ?', '__raw must be a string to count as a marker');
  assert.deepStrictEqual(params, [{ __raw: 5 }]);
}

// A template with no values at all still produces its literal text.
{
  const { text, params } = buildSqlText(['SELECT 1'], []);
  assert.strictEqual(text, 'SELECT 1');
  assert.deepStrictEqual(params, []);
}

console.log('db.sqlLimit.test.js: all assertions passed');
