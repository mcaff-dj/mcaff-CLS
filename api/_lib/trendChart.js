// Pure axis/bucket math for the RTO CRM Overview's Call Trend chart. Lives here, CJS, for the
// same reason leadQuota.js does: the browser bundle (app/rto-crm/CallTrendChart.js) imports it
// while `node` can run its self-check directly - no JSX, no React, no DOM. The SQL side of the
// same chart is getCallingCallTrend in db.js; this file never talks to a database.

// Bucket keys the query returns, as the chart's x labels. Deliberately NOT Intl/toLocaleString:
// the server groups in IST (CONVERT_TZ in getCallingCallTrend) and a browser in another zone
// would re-interpret a parsed Date and shift the label off by a day.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function bucketLabel(key, grain) {
  const s = String(key);
  if (grain === 'month') {           // '2026-08'
    const [y, m] = s.split('-');
    return `${MONTHS[Number(m) - 1] || m} ${y}`;
  }
  if (grain === 'week') {            // '202634' from YEARWEEK(..., 3) - ISO week
    return `W${s.slice(4)} '${s.slice(2, 4)}`;
  }
  const [, m, d] = s.split('-');     // '2026-08-25'
  return `${d} ${MONTHS[Number(m) - 1] || m}`;
}

// A gap in the data is a real zero (nobody dispositioned anything that day), not a missing
// point - dropping it would silently compress the x axis and make a dead week look busy.
// Only day/week grains can be enumerated safely from the range; month is enumerated too, but
// all three go through the same walker so the chart never has to special-case a hole.
function fillBuckets(rows, grain, fromKey, toKey) {
  const byKey = new Map(rows.map((r) => [String(r.bucket), r]));
  const keys = enumerateKeys(grain, fromKey, toKey, [...byKey.keys()]);
  return keys.map((k) => {
    const r = byKey.get(k) || {};
    return {
      bucket: k,
      label: bucketLabel(k, grain),
      dialled: Number(r.dialled) || 0,
      connected: Number(r.connected) || 0,
      converted: Number(r.converted) || 0,
    };
  });
}

// The key sequence to draw, inclusive. Falls back to whatever keys the data has (sorted) when
// no range is given, so an "everything" view still renders rather than showing nothing.
function enumerateKeys(grain, fromKey, toKey, presentKeys) {
  const present = [...presentKeys].sort();
  if (!fromKey || !toKey) return present;
  const out = [];
  if (grain === 'month') {
    let [y, m] = fromKey.split('-').map(Number);
    const [ty, tm] = toKey.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  if (grain === 'week') {
    // Walk real dates a week at a time and re-derive the key, rather than incrementing the
    // YEARWEEK integer - a year does not have a fixed 52 weeks, and 202653 + 1 is not 202701.
    let d = mondayOf(isoWeekStart(fromKey));
    const end = mondayOf(isoWeekStart(toKey));
    while (d <= end) {
      out.push(isoWeekKey(d));
      d = new Date(d.getTime() + 7 * 86400000);
    }
    return out;
  }
  let d = new Date(`${fromKey}T00:00:00Z`);
  const end = new Date(`${toKey}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

// MySQL YEARWEEK(d, 3) = ISO-8601 week: weeks start Monday, week 1 is the one holding Jan 4th.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;            // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);         // the Thursday of this week decides the year
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}${String(week).padStart(2, '0')}`;
}
function isoWeekStart(key) {
  // Accepts either a YEARWEEK key or a plain YYYY-MM-DD - the chart passes dates, the data
  // passes keys, and both need to land on the same Monday.
  const s = String(key);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`);
  const isoYear = Number(s.slice(0, 4));
  const week = Number(s.slice(4));
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  return new Date(jan4.getTime() + ((week - 1) * 7 - jan4Day) * 86400000);
}
function mondayOf(date) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Axis ceiling on a 1/2/5 x 10^n ladder, so gridlines land on numbers a human reads at a
// glance (0/50/100) instead of the data's own maximum (0/37/74). Never returns 0 - a
// zero-height axis divides by zero when the chart scales a value onto it.
function niceMax(value) {
  const v = Math.max(0, Number(value) || 0);
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// `count` evenly spaced gridline values from 0 to niceMax(max), inclusive of both ends.
function axisTicks(max, count = 4) {
  const top = niceMax(max);
  return Array.from({ length: count + 1 }, (_, i) => Math.round((top / count) * i * 100) / 100);
}

// Rolls DAILY rows up to the requested grain. The query deliberately groups by day only and
// never by YEARWEEK/DATE_FORMAT: one code path in SQL, one here, and the week boundary is then
// the same tested isoWeekKey the axis labels use instead of a second definition living in the
// database. A year of daily rows is ~365, so the roll-up is free next to the round trip.
function rollup(dailyRows, grain) {
  if (grain === 'day') return dailyRows.map((r) => ({ ...r, bucket: String(r.bucket) }));
  const acc = new Map();
  for (const r of dailyRows) {
    const day = String(r.bucket);
    const key = grain === 'month' ? day.slice(0, 7) : isoWeekKey(new Date(`${day}T00:00:00Z`));
    const cur = acc.get(key) || { bucket: key, dialled: 0, connected: 0, converted: 0 };
    cur.dialled += Number(r.dialled) || 0;
    cur.connected += Number(r.connected) || 0;
    cur.converted += Number(r.converted) || 0;
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

// The one call the chart makes: daily rows in, plotted buckets out. from/to are 'YYYY-MM-DD'
// (the range the user picked), converted to this grain's own key space so an empty leading or
// trailing bucket still draws rather than silently narrowing the axis to where data happens
// to exist.
function buildSeries(dailyRows, grain, from, to) {
  const key = (d) => {
    if (!d) return null;
    if (grain === 'month') return String(d).slice(0, 7);
    if (grain === 'week') return isoWeekKey(new Date(`${String(d).slice(0, 10)}T00:00:00Z`));
    return String(d).slice(0, 10);
  };
  return fillBuckets(rollup(dailyRows, grain), grain, key(from), key(to));
}

module.exports = { bucketLabel, fillBuckets, enumerateKeys, isoWeekKey, niceMax, axisTicks, rollup, buildSeries };
