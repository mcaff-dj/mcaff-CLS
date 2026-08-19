// Self-check for public survey submission validation (npsAnswers.js) - this is the trust
// boundary: answers arrive from an unauthenticated customer-facing form, so every shape/range
// check the DB can't enforce itself has to happen here before a row gets written.
// Pure/offline: no DB. Run with `node api/_lib/npsAnswers.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) a required question left unanswered - would let responses through with silent gaps
//   (b) a score outside 0-10 - would corrupt the NPS aggregate (npsScore.js buckets on it)
//   (c) a choice answer that isn't one of the question's own options - free-text injected
//       into a field the dashboard treats as a closed set
const assert = require('assert');
const { validateAnswers } = require('./npsAnswers');

const scoreQ = { id: 1, type: 'score', required: 1 };
const choiceQ = { id: 2, type: 'choice', required: 1, options_json: JSON.stringify(['Great', 'Okay', 'Bad']) };
const textQ = { id: 3, type: 'text', required: 0 };

// 1. All required questions answered with valid values -> passes.
const good = validateAnswers([scoreQ, choiceQ, textQ], [
  { questionId: 1, value: '9' },
  { questionId: 2, value: 'Great' },
]);
assert.strictEqual(good.valid, true);

// 2. Required question missing entirely -> fails.
const missingRequired = validateAnswers([scoreQ, choiceQ], [{ questionId: 1, value: '9' }]);
assert.strictEqual(missingRequired.valid, false);

// 3. Optional (required: 0) question missing -> still passes.
const optionalMissing = validateAnswers([scoreQ, choiceQ, textQ], [
  { questionId: 1, value: '9' },
  { questionId: 2, value: 'Okay' },
]);
assert.strictEqual(optionalMissing.valid, true);

// 4. Score out of range (0-10) -> fails.
const outOfRange = validateAnswers([scoreQ], [{ questionId: 1, value: '11' }]);
assert.strictEqual(outOfRange.valid, false);

// 5. Score non-numeric -> fails.
const nonNumeric = validateAnswers([scoreQ], [{ questionId: 1, value: 'great' }]);
assert.strictEqual(nonNumeric.valid, false);

// 6. Choice answer not among the question's own options -> fails.
const badChoice = validateAnswers([choiceQ], [{ questionId: 2, value: 'Amazing' }]);
assert.strictEqual(badChoice.valid, false);

// 7. CSAT (1-5): in range passes, out of range fails.
const csatQ = { id: 4, type: 'csat', required: 1 };
assert.strictEqual(validateAnswers([csatQ], [{ questionId: 4, value: '5' }]).valid, true);
assert.strictEqual(validateAnswers([csatQ], [{ questionId: 4, value: '6' }]).valid, false);
assert.strictEqual(validateAnswers([csatQ], [{ questionId: 4, value: '0' }]).valid, false);

// 8. Conditional required: a follow-up whose trigger condition ISN'T met is not required,
// even though it's flagged required=1 and was left unanswered.
const followUp = {
  id: 5, type: 'text', required: 1,
  conditions: [{ questionId: 1, type: 'range', min: 0, max: 6 }], conditionLogic: 'AND',
};
const conditionNotMet = validateAnswers([scoreQ, followUp], [{ questionId: 1, value: '9' }]);
assert.strictEqual(conditionNotMet.valid, true);

// 9. Conditional required: same follow-up IS required once its trigger condition holds.
const conditionMet = validateAnswers([scoreQ, followUp], [{ questionId: 1, value: '3' }]);
assert.strictEqual(conditionMet.valid, false);

console.log('npsAnswers.test.js: all assertions passed');
