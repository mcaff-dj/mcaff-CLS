// Standard NPS bucketing: 0-6 detractor, 7-8 passive, 9-10 promoter.
// nps = (promoters - detractors) / total * 100, rounded to a whole number.
function computeNpsAggregate(scores) {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (const score of scores) {
    if (score >= 9) promoters++;
    else if (score >= 7) passives++;
    else detractors++;
  }
  const total = scores.length;
  const nps = total === 0 ? null : Math.round(((promoters - detractors) / total) * 100);
  return { promoters, passives, detractors, total, nps };
}

module.exports = { computeNpsAggregate };
