/**
 * Client-side port of the baseline-dependent math in scripts/build_trend_digest.py, so the
 * KYC Complaint Trends tab can recompute every baseline-driven section when the user picks
 * a different baseline month range - no round trip to the server. Operates on
 * digest.raw (see build_raw() in build_trend_digest.py), which is already keyed by the
 * SAME pretty month labels (e.g. "Aug '25") the UI displays, for every brand.
 *
 * Mirrors the Python functions of the same name closely enough that
 * scripts/check_trend_client_math.js can assert this produces byte-identical output to
 * the server's own precomputed sections at the default baseline. Keep the two in sync.
 *
 * CommonJS (not ESM export) so scripts/check_trend_client_math.js can require() this
 * file directly under plain Node - same convention api/_lib/*.js already uses.
 */

const SEP = '||';
const MIN_WINDOW_CASES = 40;
const MIN_WINDOW_CASES_SKU = 20;
const MIN_RATE_DELTA_PP = 0.02;
const MAX_TRENDS_PER_DIMENSION = 6;
const PACKAGING_WORDS = ['spill', 'broken', 'seal', 'damage', 'leak', 'packaging', 'tamper'];

function rate(count, sales) {
  if (!sales) return null;
  return (count / sales) * 100.0;
}

function avg(vals) {
  const present = vals.filter((v) => v !== null && v !== undefined);
  if (!present.length) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function roundTo(v, n) {
  if (v === null || v === undefined) return null;
  const f = Math.pow(10, n);
  const nudge = v >= 0 ? 1e-9 : -1e-9;
  return Math.round(v * f + nudge) / f;
}

function fmtPct3(v) {
  return roundTo(v, 3);
}

function sum(vals) {
  return vals.reduce((a, b) => a + b, 0);
}

function splitOnce(key, sep) {
  const idx = key.indexOf(sep);
  if (idx === -1) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + sep.length)];
}

function salesFor(brand, months) {
  return months.map((m) => brand.sales[m] ?? 0);
}

function countsFor(store, key, months) {
  const perMonth = store[key] || {};
  return months.map((m) => perMonth[m] ?? 0);
}

function buildMetrics(raw, baselineMonths, windowMonths) {
  const METRICS = [
    ['csat', 'CSAT', 2],
    ['ai_csat', 'AI CSAT', 2],
    ['nps_overall', 'Overall NPS', 1],
    ['nps_product', 'Product NPS', 1],
  ];
  return raw.map((brand) => {
    const rows = METRICS.map(([key, label, nd]) => {
      const series = brand[key] || {};
      const val = (m) => (series[m] !== undefined ? series[m] : null);
      const base = avg(baselineMonths.map(val));
      const wins = windowMonths.map(val);
      const wavg = avg(wins);
      return {
        metric: label,
        baseline: base !== null ? roundTo(base, nd) : null,
        months: wins.map((v) => (v !== null ? roundTo(v, nd) : null)),
        window_avg: wavg !== null ? roundTo(wavg, nd) : null,
        delta: base !== null && wavg !== null ? roundTo(wavg - base, nd) : null,
        unit: key.startsWith('nps') ? 'pts' : '',
      };
    });
    return { brand: brand.brand, title: brand.title, rows };
  });
}

function buildRatio(raw, baselineMonths, windowMonths) {
  const rows = raw.map((brand) => {
    const r = (m) => rate(brand.tickets[m] ?? 0, brand.sales[m] ?? 0);
    const base = avg(baselineMonths.map(r));
    const wins = windowMonths.map(r);
    const wavg = avg(wins);
    return {
      label: brand.title,
      baseline: fmtPct3(base),
      months: wins.map(fmtPct3),
      window_avg: fmtPct3(wavg),
      delta: fmtPct3((wavg ?? 0) - (base ?? 0)),
    };
  });

  const pooled = (m) => {
    const t = sum(raw.map((b) => b.tickets[m] ?? 0));
    const s = sum(raw.map((b) => b.sales[m] ?? 0));
    return rate(t, s);
  };
  const pbase = avg(baselineMonths.map(pooled));
  const pwins = windowMonths.map(pooled);
  const pwavg = avg(pwins);
  rows.push({
    label: 'Total Brand Average',
    baseline: fmtPct3(pbase),
    months: pwins.map(fmtPct3),
    window_avg: fmtPct3(pwavg),
    delta: fmtPct3((pwavg ?? 0) - (pbase ?? 0)),
    combined: true,
  });
  return rows;
}

function buildClassTables(raw, baselineMonths, windowMonths) {
  return raw.map((brand) => {
    const bsales = salesFor(brand, baselineMonths);
    const wsales = salesFor(brand, windowMonths);
    const rows = [];
    for (const cls of brand.classes_order || []) {
      if (!brand.classes[cls]) continue;
      const bc = countsFor(brand.classes, cls, baselineMonths);
      const wc = countsFor(brand.classes, cls, windowMonths);
      if (sum(bc) + sum(wc) < MIN_WINDOW_CASES) continue;
      const brates = bc.map((c, i) => rate(c, bsales[i]));
      const wrates = wc.map((c, i) => rate(c, wsales[i]));
      const base = avg(brates);
      const wavg = avg(wrates);
      rows.push({
        label: cls,
        baseline: fmtPct3(base),
        months: wrates.map(fmtPct3),
        window_avg: fmtPct3(wavg),
        multiplier: base && base > 0.005 ? roundTo(wavg / base, 1) : null,
        baseline_cases: sum(bc),
        window_cases: sum(wc),
      });
    }
    const tb = baselineMonths.map((m) => brand.tickets[m] ?? 0);
    const tw = windowMonths.map((m) => brand.tickets[m] ?? 0);
    const tbase = avg(tb.map((c, i) => rate(c, bsales[i])));
    const twin = tw.map((c, i) => rate(c, wsales[i]));
    const twavg = avg(twin);
    rows.push({
      label: 'Total',
      baseline: fmtPct3(tbase),
      months: twin.map(fmtPct3),
      window_avg: fmtPct3(twavg),
      multiplier: tbase && tbase > 0.005 ? roundTo(twavg / tbase, 1) : null,
      total: true,
    });
    return { brand: brand.brand, title: brand.title, rows };
  });
}

function verb(delta) {
  return delta > 0 ? 'rose' : 'fell';
}

function commaNum(n) {
  return n.toLocaleString('en-US');
}

function candidates(brand, store, dimension, baselineMonths, windowMonths, minCases) {
  const sb = sum(salesFor(brand, baselineMonths));
  const sw = sum(salesFor(brand, windowMonths));
  const found = [];
  for (const key of Object.keys(store)) {
    const perMonth = store[key];
    const bc = sum(baselineMonths.map((m) => perMonth[m] ?? 0));
    const wc = sum(windowMonths.map((m) => perMonth[m] ?? 0));
    if (wc < minCases) continue;
    const br = rate(bc, sb);
    const wr = rate(wc, sw);
    const delta = wr - br;
    if (Math.abs(delta) < MIN_RATE_DELTA_PP) continue;
    found.push({
      dimension,
      key,
      parts: key.split(SEP),
      baseline_rate: fmtPct3(br),
      window_rate: fmtPct3(wr),
      delta: fmtPct3(delta),
      baseline_cases: bc,
      window_cases: wc,
      multiplier: br > 0.005 ? roundTo(wr / br, 1) : null,
    });
  }
  found.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return found.slice(0, MAX_TRENDS_PER_DIMENSION);
}

// Python's str(float) always shows at least one decimal ("0.0", "3.0"), unlike JS's
// Number#toString ("0", "3") - matters here because these numbers are interpolated
// straight into a sentence Python built with an f-string, not compared numerically.
function pyFloatStr(v) {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

function sentence(c, baselineLabel, windowLabel) {
  const parts = c.parts;
  let subject;
  if (c.dimension === 'class') subject = `${parts[0]} complaints`;
  else if (c.dimension === 'category') subject = `${parts[1]} (${parts[0]})`;
  else subject = `${parts[0]} - ${parts[1]}`;
  const mult = c.multiplier ? `, ${pyFloatStr(c.multiplier)}x` : '';
  return (
    `${subject} ${verb(c.delta)} from ${pyFloatStr(c.baseline_rate)}% of orders (${baselineLabel}) to ` +
    `${pyFloatStr(c.window_rate)}% (${windowLabel}) - ${commaNum(c.baseline_cases)} to ` +
    `${commaNum(c.window_cases)} cases${mult}.`
  );
}

function rangeLabel(months) {
  return months.length > 1 ? `${months[0]}-${months[months.length - 1]}` : months[0];
}

function buildWorstTrends(raw, baselineMonths, windowMonths) {
  const baselineLabel = rangeLabel(baselineMonths);
  const windowLabel = rangeLabel(windowMonths);
  const specs = [
    ['class', 'classes', 'Query class', MIN_WINDOW_CASES],
    ['category', 'cats', 'Complaint category', MIN_WINDOW_CASES],
    ['courier', 'partner_cats', 'Courier x issue', MIN_WINDOW_CASES],
    ['sku', 'product_cats', 'SKU x issue', MIN_WINDOW_CASES_SKU],
  ];
  const groups = [];
  for (const [dim, storeKey, title, floor] of specs) {
    const byBrand = [];
    for (const brand of raw) {
      const items = candidates(brand, brand[storeKey] || {}, dim, baselineMonths, windowMonths, floor).map((c) => {
        const withBrand = { ...c, brand: brand.brand, brand_title: brand.title };
        withBrand.sentence = sentence(withBrand, baselineLabel, windowLabel);
        return withBrand;
      });
      if (items.length) byBrand.push({ brand: brand.brand, title: brand.title, items });
    }
    if (byBrand.length) groups.push({ dimension: dim, title, by_brand: byBrand });
  }
  return { baseline_label: baselineLabel, window_label: windowLabel, groups };
}

function skuPackagingPerMonth(brand, product) {
  const perMonth = {};
  for (const [key, pm] of Object.entries(brand.product_cats || {})) {
    const [prod, cat] = splitOnce(key, SEP);
    if (prod !== product) continue;
    if (!PACKAGING_WORDS.some((w) => cat.toLowerCase().includes(w))) continue;
    for (const [m, n] of Object.entries(pm)) perMonth[m] = (perMonth[m] || 0) + n;
  }
  return perMonth;
}

function buildPackagingBaseline(raw, packaging, baselineMonths, windowMonths) {
  return packaging.map((brandPkg) => {
    const brand = raw.find((r) => r.brand === brandPkg.brand);
    const bsales = sum(salesFor(brand, baselineMonths));
    const wsales = sum(salesFor(brand, windowMonths));
    const skus = brandPkg.skus.map((row) => {
      const perMonth = skuPackagingPerMonth(brand, row.product);
      const bc = sum(baselineMonths.map((m) => perMonth[m] ?? 0));
      const wc = sum(windowMonths.map((m) => perMonth[m] ?? 0));
      const br = rate(bc, bsales);
      const wr = rate(wc, wsales);
      return { ...row, baseline_rate: fmtPct3(br), window_rate: fmtPct3(wr), delta: fmtPct3(wr - br) };
    });
    skus.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
    return { ...brandPkg, skus };
  });
}

module.exports = {
  rate,
  avg,
  roundTo,
  buildMetrics,
  buildRatio,
  buildClassTables,
  buildWorstTrends,
  buildPackagingBaseline,
};
