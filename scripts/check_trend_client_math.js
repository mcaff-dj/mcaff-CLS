#!/usr/bin/env node
/**
 * Correctness check for app/orgoverview/trendMath.js: loads data/trend_digest.json and
 * asserts the JS port produces byte-identical output to the Python original
 * (scripts/build_trend_digest.py) at the default baseline - the one case provable against
 * a real fixture. Run manually after regenerating the digest:
 *
 *   node scripts/check_trend_client_math.js
 *
 * Not wired into CI - a one-off sanity check, same as this repo's other scripts/*.js.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { buildMetrics, buildRatio, buildClassTables, buildWorstTrends, buildPackagingBaseline } = require('../app/orgoverview/trendMath');

const DIGEST_PATH = path.join(__dirname, '..', 'data', 'trend_digest.json');

const digest = JSON.parse(fs.readFileSync(DIGEST_PATH, 'utf8'));
const { raw, axis, metrics, ratio, class_tables: classTables, worst_trends: worstTrends, packaging } = digest;
const baselineMonths = axis.default_baseline_months;
const windowMonths = axis.window_months;

let failures = 0;
function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`OK   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(e.message);
  }
}

check('buildMetrics', buildMetrics(raw, baselineMonths, windowMonths), metrics);
check('buildRatio', buildRatio(raw, baselineMonths, windowMonths), ratio);
check('buildClassTables', buildClassTables(raw, baselineMonths, windowMonths), classTables);
check('buildWorstTrends', buildWorstTrends(raw, baselineMonths, windowMonths), worstTrends);
check('buildPackagingBaseline', buildPackagingBaseline(raw, packaging, baselineMonths, windowMonths), packaging);

if (failures) {
  console.error(`\n${failures} check(s) failed - trendMath.js has drifted from build_trend_digest.py.`);
  process.exit(1);
}
console.log('\nAll checks passed - trendMath.js matches build_trend_digest.py at the default baseline.');
