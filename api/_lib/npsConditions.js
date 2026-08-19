// Whether a follow-up question's "show only if" rule set is satisfied by the answers
// collected so far. Shared by the public form (client-side, to decide what to render next)
// and the submit endpoint (server-side, to decide what's actually required) - see
// api/_lib/npsAnswers.js.
function evaluateOne(condition, answersByQuestionId) {
  const value = answersByQuestionId[condition.questionId];
  if (value === undefined || value === null) return false;

  if (condition.type === 'range') {
    const n = Number(value);
    return Number.isFinite(n) && n >= condition.min && n <= condition.max;
  }
  if (condition.type === 'equals') {
    return value === condition.value;
  }
  return false;
}

function conditionsMet(conditions, logic, answersByQuestionId) {
  if (!conditions || conditions.length === 0) return true;
  const results = conditions.map((c) => evaluateOne(c, answersByQuestionId));
  return logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

module.exports = { conditionsMet };
