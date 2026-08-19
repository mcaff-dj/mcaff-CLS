// Validates a public survey submission against its own question set - the trust boundary for
// answers coming from an unauthenticated customer-facing form (see api/nps/public/[token].js).
function validateAnswers(questions, answers) {
  const byQuestionId = new Map(answers.map((a) => [Number(a.questionId), a.value]));

  for (const q of questions) {
    const value = byQuestionId.get(q.id);
    const present = value !== undefined && value !== null && String(value).trim() !== '';

    if (!present) {
      if (q.required) return { valid: false, error: `Question ${q.id} is required.` };
      continue;
    }

    if (q.type === 'score') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        return { valid: false, error: `Question ${q.id} must be a score from 0 to 10.` };
      }
    }

    if (q.type === 'choice') {
      const options = q.options_json ? JSON.parse(q.options_json) : [];
      if (!options.includes(value)) {
        return { valid: false, error: `Question ${q.id}'s answer isn't one of its options.` };
      }
    }
  }

  return { valid: true };
}

module.exports = { validateAnswers };
