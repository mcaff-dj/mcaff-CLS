// Answer key for the Onboarding Test (api/_reports/onboarding.html). Server-only - never
// require() this from anything that ships to the client, since it holds the graded concepts
// behind each question. Grading is deterministic keyword-concept matching (no AI call): each
// question has a list of "concepts", each concept a list of synonym phrases: a concept counts
// as covered if the user's answer contains ANY one of its phrases. Score = (concepts covered /
// total concepts) * POINTS_PER_QUESTION, rounded to the nearest whole point.

const POINTS_PER_QUESTION = 5;

const QUESTIONS = [
  {
    id: 1,
    text: 'A customer added only one product during a "Buy 1 Get 1" offer. It is her birthday and her first order. What should be done?',
    concepts: [
      ['b1g1', 'buy 1 get 1', 'buy one get one'],
      ['birthday', 'gift'],
      ['one product', 'one free', 'give them one', 'provide one', 'send one'],
    ],
  },
  {
    id: 2,
    text: 'A customer claims a delivery boy abused and misbehaved with her. What should be done?',
    concepts: [
      ['call'],
      ['delivery team', 'mail', 'escalate'],
      ['50%', 'refund', 'exception'],
    ],
  },
  {
    id: 3,
    text: 'A customer is unable to apply the coupon "B2799" on Power Peptide. What should be done?',
    concepts: [
      ['not valid', 'invalid', 'not applicable', "doesn't apply", 'not eligible', "won't work"],
      ['this product', 'power peptide', 'coupon'],
    ],
  },
  {
    id: 4,
    text: 'A customer mentioned that the Google coupon code for "Buy 2 Get 7" is not working, even though the "Buy 3 at 999" offer is already live on the site. (a) What should be done if the coupon code provided was wrong? (b) What should be done if the customer is applying it incorrectly?',
    concepts: [
      ['check', 'verify'],
      ['escalate', 'wrong code', 'wrong coupon'],
      ['assist', 'help', 'guide'],
    ],
  },
  {
    id: 5,
    text: 'A customer mentioned the product is not effective after using it for two months and has reached out on different platforms. What should be done?',
    concepts: [
      ['call'],
      ['alternate product', 'different product', 'replacement', 'exchange', 'alternative'],
    ],
  },
  {
    id: 6,
    text: "A customer mentioned they added two products to their cart and wants to know why they didn't receive three free products. What should be done?",
    concepts: [
      ['b2g3', 'buy 2 get 3'],
      ['explain', 'how it works', 'how b2g3 works'],
      ['one freebie', 'exception', 'one free'],
    ],
  },
  {
    id: 7,
    text: 'A customer ordered from Amazon and the product caused a skin reaction (acne/pimples). What should be done?',
    concepts: [
      ['call'],
      ['alternate product', 'different product', 'pitch another', 'another product'],
      ['refund'],
    ],
  },
  {
    id: 8,
    text: 'A customer ordered from Blinkit and the products arrived totally broken. What should be done?',
    concepts: [
      ['blinkit support', 'blinkit'],
      ['screenshot', 'ss', 'proof', 'footage'],
      ['resolve', 'help', 'refund', 'replace'],
    ],
  },
  {
    id: 9,
    text: 'A customer purchased body lotion but cannot use it because the pump is missing or not working. What should be done?',
    concepts: [
      ['image', 'video', 'photo'],
      ['check', 'verify', 'using correctly', 'correct usage', 'trying correctly'],
      ['resolve', 'replace', 'refund', 'clear'],
    ],
  },
  {
    id: 10,
    text: 'A customer reached out regarding a refund not reflecting in their bank account. We shared screenshots from all three platforms, but the customer has now shared their UPI statement with us. What should be done?',
    concepts: [
      ['bank statement', 'bank history', 'bank account'],
      ['upi'],
      ['delay', 'time', 'reflect'],
    ],
  },
  {
    id: 11,
    text: "A customer reached out with a screenshot of a payment issue, mentioning they haven't received an order ID or a refund yet. What should be done?",
    concepts: [
      ['screenshot', 'ss'],
      ['poc'],
      ['auto refund', 'auto-refund', 'order placed', 'verify', 'dropped'],
    ],
  },
  {
    id: 12,
    text: 'A customer shared an unboxing video showing she received Mamaearth products in her box instead of ours. What should be done?',
    concepts: [
      ['first time', 'replacement', 'comp', 'complimentary'],
      ['repeat', 'footage', 'wait', 'review'],
    ],
  },
  {
    id: 13,
    text: 'A customer who has spoken to 4+ agents is now assigned to you; they are highly frustrated and asking for a freebie (Stanley). What should be done?',
    concepts: [
      ['not able to share', 'cannot share', "can't share", 'not possible'],
      ['freebie', 'exception'],
    ],
  },
  {
    id: 14,
    text: 'An order has been delayed for over 8 days and the customer has reached out to our founder to raise a formal complaint. What should be done?',
    concepts: [
      ['prioritize', 'priority', 'shipment'],
      ['freebie', 'coupon'],
      ['half refund', 'exception', 'poc'],
    ],
  },
  {
    id: 15,
    text: 'An order was placed on 1 June and the status is still reflecting as "Pickup Generated." What should be done?',
    concepts: [
      ['pe case', 'pickup exception', 'pe '],
      ['reorder', 're-order', 'resend'],
    ],
  },
  {
    id: 16,
    text: 'An order was placed on 14 April (RTO) and the customer is now asking for a refund. What should be done?',
    concepts: [
      ['rto'],
      ['refund', 'cod'],
    ],
  },
  {
    id: 17,
    text: 'If a customer mentions they are trying to apply a Google Form coupon code but are unable to do so, what should be done?',
    concepts: [
      ['screenshot', 'ss'],
      ['applicable', 'specific products', 'listed products', 'link'],
      ['escalate'],
    ],
  },
  {
    id: 18,
    text: 'If an order was split (two products), one was delivered and the second was partially dispatched. The order was COD and the customer reached out after 25 days. What should be done?',
    concepts: [
      ['not possible', 'ndr', 'nsz'],
      ['wrong', 'invalid question', 'not applicable'],
    ],
  },
  {
    id: 19,
    text: 'We mistakenly promised a customer they would receive a Stanley, and now they have reached out to us over Twitter. What should be done?',
    concepts: [
      ['not able to share', 'cannot provide', "can't provide", 'not possible'],
      ['exception', 'alternative', 'offer'],
    ],
  },
  {
    id: 20,
    text: 'What is the difference between "Buy 2 Get 3" and "Buy 2 Get 5"?',
    concepts: [
      ['same offer', 'same', 'identical'],
      ['different name', 'marketed differently', 'rebrand', 'different names'],
    ],
  },
];

function gradeAnswer(question, answerText) {
  const answer = (answerText || '').toLowerCase();
  if (!answer.trim()) return 0;
  const covered = question.concepts.filter((synonyms) =>
    synonyms.some((phrase) => answer.includes(phrase))
  ).length;
  return Math.round((covered / question.concepts.length) * POINTS_PER_QUESTION);
}

module.exports = { QUESTIONS, POINTS_PER_QUESTION, gradeAnswer };
