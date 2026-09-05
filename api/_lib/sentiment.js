// One-shot Anthropic call that labels a detractor's free-text additional_feedback
// Positive/Neutral/Negative plus a one-line reason - see getNextDetractorLead's own call site
// in db.js, which fires this once per lead at assignment time and stores the result on
// CLS_NPS_calling (scripts/add_sentiment_to_calling.py), same "computed once at assign, never
// re-derived" shape the rest of that copy-on-assign row already has.
//
// ANTHROPIC_API_KEY isn't configured anywhere in this app yet (checked: not in .env.local, not
// referenced by api/_lib/secrets.js's Secrets Manager blob) - add it to that blob (or
// .env.local for local runs) to turn this on. Until then classifyFeedbackSentiment throws
// "Missing ANTHROPIC_API_KEY", which the caller in db.js catches and just skips sentiment for
// that lead, same fail-open contract sendWhatsApp's own caller already uses for a failed send.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // fast/cheap - a one-line classification, not a long answer
const VALID_SENTIMENTS = ['Positive', 'Neutral', 'Negative'];

async function classifyFeedbackSentiment(feedbackText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY env var');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      system: 'You classify customer feedback sentiment for a support agent about to call the '
        + 'customer back. Reply with ONLY a JSON object, no other text: '
        + '{"sentiment": "Positive"|"Neutral"|"Negative", "reason": "<one short sentence>"}. '
        + '"reason" summarizes WHY, in the customer\'s own terms - it is shown to the agent '
        + 'before they dial, not published anywhere.',
      messages: [{ role: 'user', content: feedbackText }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic sentiment call failed: HTTP ${res.status} - ${text}`);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Anthropic response was not JSON: ${text}`); }
  const raw = (data.content && data.content[0] && data.content[0].text) || '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Model reply was not JSON: ${raw}`); }
  if (!VALID_SENTIMENTS.includes(parsed.sentiment)) {
    throw new Error(`Model returned an unexpected sentiment value: ${JSON.stringify(parsed)}`);
  }
  return { sentiment: parsed.sentiment, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : null };
}

module.exports = { classifyFeedbackSentiment };
