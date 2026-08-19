// Self-check for follow-up question conditions (npsConditions.js) - whether a question with
// a "show only if" rule set should actually appear, given the answers collected so far.
// Pure/offline: no DB. Run with `node api/_lib/npsConditions.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) AND/OR mixed up - a question meant to need ALL conditions showing on just one, or
//       vice versa, surfaces the wrong follow-up to the wrong customer
//   (b) a condition referencing an unanswered question treated as satisfied - would show a
//       follow-up before its trigger question was even answered
//   (c) range bounds off-by-one (inclusive both ends)
const assert = require('assert');
const { conditionsMet } = require('./npsConditions');

// 1. No conditions -> always shown.
assert.strictEqual(conditionsMet([], 'AND', {}), true);

// 2. Single range condition, inside/outside/boundary.
const scoreAnswers = (n) => ({ 1: String(n) });
const rangeCond = [{ questionId: 1, type: 'range', min: 7, max: 8 }];
assert.strictEqual(conditionsMet(rangeCond, 'AND', scoreAnswers(7)), true);
assert.strictEqual(conditionsMet(rangeCond, 'AND', scoreAnswers(8)), true);
assert.strictEqual(conditionsMet(rangeCond, 'AND', scoreAnswers(6)), false);
assert.strictEqual(conditionsMet(rangeCond, 'AND', scoreAnswers(9)), false);

// 3. Single equals condition (choice question).
const equalsCond = [{ questionId: 2, type: 'equals', value: 'Bad' }];
assert.strictEqual(conditionsMet(equalsCond, 'AND', { 2: 'Bad' }), true);
assert.strictEqual(conditionsMet(equalsCond, 'AND', { 2: 'Great' }), false);

// 4. AND: both conditions must hold.
const twoConds = [
  { questionId: 1, type: 'range', min: 0, max: 6 },
  { questionId: 2, type: 'equals', value: 'Bad' },
];
assert.strictEqual(conditionsMet(twoConds, 'AND', { 1: '3', 2: 'Bad' }), true);
assert.strictEqual(conditionsMet(twoConds, 'AND', { 1: '3', 2: 'Great' }), false);

// 5. OR: either condition holding is enough.
assert.strictEqual(conditionsMet(twoConds, 'OR', { 1: '3', 2: 'Great' }), true);
assert.strictEqual(conditionsMet(twoConds, 'OR', { 1: '9', 2: 'Great' }), false);

// 6. Referenced question not yet answered -> that condition is unmet, not "ignored as true".
assert.strictEqual(conditionsMet(rangeCond, 'AND', {}), false);

console.log('npsConditions.test.js: all assertions passed');
