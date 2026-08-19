// CSAT (1-5) aggregate: standard top-2-box (4, 5 = satisfied) percentage plus the raw average.
function computeCsatAggregate(scores) {
  const total = scores.length;
  if (total === 0) return { total: 0, average: null, satisfied: 0, satisfiedPct: null };

  const satisfied = scores.filter((s) => s >= 4).length;
  const average = Math.round((scores.reduce((sum, s) => sum + s, 0) / total) * 100) / 100;
  const satisfiedPct = Math.round((satisfied / total) * 100);
  return { total, average, satisfied, satisfiedPct };
}

module.exports = { computeCsatAggregate };
