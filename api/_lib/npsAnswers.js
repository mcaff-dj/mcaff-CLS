// Validates a public survey submission against its own question set - the trust boundary for
// answers coming from an unauthenticated customer-facing form (see api/nps/public/[token].js).
const { conditionsMet } = require('./npsConditions');

const SCALE_RANGE = { score: [0, 10], csat: [1, 5] };

function validateAnswers(questions, answers) {
  const byQuestionId = new Map(answers.map((a) => [Number(a.questionId), a.value]));
  const rawByQuestionId = Object.fromEntries(byQuestionId);

  for (const q of questions) {
    const value = byQuestionId.get(q.id);
    const present = value !== undefined && value !== null && String(value).trim() !== '';

    if (!present) {
      if (q.required && conditionsMet(q.conditions, q.conditionLogic, rawByQuestionId)) {
        return { valid: false, error: `Question ${q.id} is required.` };
      }
      continue;
    }

    if (SCALE_RANGE[q.type]) {
      const [min, max] = SCALE_RANGE[q.type];
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        return { valid: false, error: `Question ${q.id} must be a score from ${min} to ${max}.` };
      }
    }

    if (q.type === 'choice') {
      const options = q.options_json ? JSON.parse(q.options_json) : (q.options || []);
      if (!options.includes(value)) {
        return { valid: false, error: `Question ${q.id}'s answer isn't one of its options.` };
      }
    }
  }

  return { valid: true };
}

module.exports = { validateAnswers };
