// Self-check for NDR's shared assignment rule (ndrAssignment.js) - the single definition the
// interactive top-up (api/ndr/next-lead.js) and the CRM's roster/Predicted tab both import, and
// that scripts/assign_ndr_leads.py hand-mirrors in Python.
// Pure/offline: no DB, no sheet, no React. Run with `node api/_lib/ndrAssignment.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) an unparseable Attempt Count failing CLOSED, so a lead nobody can read is never called
//   (b) a set reason filter failing OPEN on a blank reason, handing an agent leads they filtered
//       out - the opposite direction from (a), and deliberately so
//   (c) brand read from anything but the Order ID's "HYP" prefix
//   (d) an undated lead sorting FIRST and jumping the oldest-first queue
//   (e) quota treated as a lifetime total rather than a concurrent cap (computeFillTarget)
//   (f) eligibility failing open, topping up an agent who has gone Busy/OnCall/Offline or whose
//       heartbeat has gone stale
const assert = require('assert');
const {
  DEFAULT_QUOTA, STALE_MINUTES, attemptBucket, brandOf, parseLatestNdrDate, normalizeAgentFilters,
  filtersCoverLead, computeFillTarget, isEligibleNow,
} = require('./ndrAssignment');

// --- attemptBucket: buckets, and (a) fail-open on anything unreadable ------------------------
assert.strictEqual(attemptBucket('1'), '1');
assert.strictEqual(attemptBucket(' 3 '), '3', 'sheet cells carry stray whitespace');
assert.strictEqual(attemptBucket('4'), 'More than 3');
assert.strictEqual(attemptBucket(99), 'More than 3');
assert.strictEqual(attemptBucket(''), null, 'blank must fail open, not become bucket "1"');
assert.strictEqual(attemptBucket('N/A'), null);
assert.strictEqual(attemptBucket('0'), null, '0 attempts is not bucket "0" - it is unrestricted');
assert.strictEqual(attemptBucket(null), null);

// --- brandOf: (c) prefix only, case-insensitive ----------------------------------------------
assert.strictEqual(brandOf('HYP12345'), 'Hyphen');
assert.strictEqual(brandOf('hyp12345'), 'Hyphen');
assert.strictEqual(brandOf('MC12345'), 'mCaffeine');
assert.strictEqual(brandOf(''), 'mCaffeine', 'no order id must not become a third brand');
assert.strictEqual(brandOf('X-HYP-1'), 'mCaffeine', 'HYP must be a PREFIX, not a substring');

// --- parseLatestNdrDate: (d) undated sorts last ----------------------------------------------
assert.strictEqual(parseLatestNdrDate('01-02-2026'), new Date(2026, 1, 1).getTime());
assert.strictEqual(parseLatestNdrDate('1-2-2026'), new Date(2026, 1, 1).getTime(), 'unpadded is real sheet data');
assert.strictEqual(parseLatestNdrDate(''), Infinity);
assert.strictEqual(parseLatestNdrDate('2026-02-01'), Infinity, 'ISO is NOT this sheet format - must not silently parse');
assert.ok(parseLatestNdrDate('01-01-2026') < parseLatestNdrDate(''), 'a dated lead must outrank an undated one');

// --- normalizeAgentFilters: both column shapes, and "absent means unrestricted" --------------
const unrestricted = normalizeAgentFilters({ email: 'u@x.com' });
assert.strictEqual(unrestricted.quota, DEFAULT_QUOTA, 'no quota set must fall back, never to 0');
assert.deepStrictEqual(unrestricted.attemptFilter, []);
assert.strictEqual(unrestricted.paymentModeFilter, '');

const camel = normalizeAgentFilters({
  email: 'r@x.com', maxQuota: 5, attemptCountFilter: '3', ndrReasonFilter: 'Address issue, Not available',
  ndrPaymentModeFilter: 'COD', ndrBrandFilter: 'Hyphen',
});
assert.strictEqual(camel.quota, 5);
assert.deepStrictEqual(camel.attemptFilter, ['3']);
assert.deepStrictEqual(camel.reasonFilter, ['Address issue', 'Not available'], 'comma list, trimmed');

const snake = normalizeAgentFilters({
  email: 'r@x.com', max_quota: 5, attempt_count_filter: '3', ndr_reason_filter: 'Address issue, Not available',
  ndr_payment_mode_filter: 'COD', ndr_brand_filter: 'Hyphen',
});
assert.deepStrictEqual(snake, camel, 'the raw DB columns and the API shape must normalize identically');

assert.deepStrictEqual(
  normalizeAgentFilters({ email: 'e@x.com', attemptCountFilter: ' , ,' }).attemptFilter, [],
  'a filter of only separators is no filter at all - it must not become an unsatisfiable one',
);
assert.strictEqual(normalizeAgentFilters({ email: 'z@x.com', maxQuota: 0 }).quota, 0,
  'an explicit 0 quota is a real setting (agent paused), not "unset" - it must survive');

// --- filtersCoverLead ------------------------------------------------------------------------
const lead = (o) => ({ attempts: '3', latestNdrReason: 'Customer not available', paymentMode: 'COD', brand: 'Hyphen', ...o });

assert.ok(filtersCoverLead(unrestricted, lead()), 'no filters must accept everything');

// Rasika's real configuration as of 2026-09-04: Attempt Count = 3 and nothing else.
const attempt3 = normalizeAgentFilters({ email: 'r@x.com', attemptCountFilter: '3' });
assert.ok(filtersCoverLead(attempt3, lead({ attempts: '3' })));
assert.ok(!filtersCoverLead(attempt3, lead({ attempts: '2' })), '"3" means exactly 3 - 1 and 2 are excluded');
assert.ok(!filtersCoverLead(attempt3, lead({ attempts: '7' })), '7 buckets to "More than 3", also excluded');
assert.ok(filtersCoverLead(attempt3, lead({ attempts: '' })),
  '(a) a blank Attempt Count fails OPEN even against a set filter - an unreadable cell must not strand a lead');

// (b) the deliberate asymmetry: a set reason filter does NOT fail open on a blank reason.
const reasonFiltered = normalizeAgentFilters({ email: 'r@x.com', ndrReasonFilter: 'address issue' });
assert.ok(filtersCoverLead(reasonFiltered, lead({ latestNdrReason: 'ADDRESS ISSUE - incomplete' })),
  'substring match, case-insensitive');
assert.ok(!filtersCoverLead(reasonFiltered, lead({ latestNdrReason: '' })),
  '(b) a blank reason matches no substring - it must NOT fail open like the attempt count does');

const codOnly = normalizeAgentFilters({ email: 'r@x.com', ndrPaymentModeFilter: 'COD' });
assert.ok(filtersCoverLead(codOnly, lead({ paymentMode: ' cod ' })), 'exact value, case/space-insensitive');
assert.ok(!filtersCoverLead(codOnly, lead({ paymentMode: 'Prepaid' })));
assert.ok(!filtersCoverLead(codOnly, lead({ paymentMode: '' })), 'a blank payment mode is not COD');

const hyphenOnly = normalizeAgentFilters({ email: 'r@x.com', ndrBrandFilter: 'Hyphen' });
assert.ok(filtersCoverLead(hyphenOnly, lead({ brand: 'Hyphen' })));
assert.ok(!filtersCoverLead(hyphenOnly, lead({ brand: 'mCaffeine' })));

// The pair that left Ashar idle ~20h on 2026-08-20: COD + mCaffeine matched 0 of 905 leads,
// because every COD lead was Hyphen and every mCaffeine lead was Prepaid. All four filters are
// ANDed, so an individually-reasonable pair can still be jointly unsatisfiable.
const ashar = normalizeAgentFilters({ email: 'a@x.com', ndrPaymentModeFilter: 'COD', ndrBrandFilter: 'mCaffeine' });
assert.ok(!filtersCoverLead(ashar, lead({ paymentMode: 'COD', brand: 'Hyphen' })));
assert.ok(!filtersCoverLead(ashar, lead({ paymentMode: 'Prepaid', brand: 'mCaffeine' })));
assert.ok(filtersCoverLead(ashar, lead({ paymentMode: 'COD', brand: 'mCaffeine' })), 'the pair is satisfiable in principle');

// --- computeFillTarget: (e) quota is a concurrent cap, and every bound holds ------------------
assert.strictEqual(computeFillTarget(20, 0, 100, 25), 20, 'headroom is the binding limit here');
assert.strictEqual(computeFillTarget(20, 18, 100, 25), 2, 'only the remaining headroom, not a full refill');
assert.strictEqual(computeFillTarget(20, 20, 100, 25), 0, 'at quota hands out nothing');
assert.strictEqual(computeFillTarget(20, 34, 100, 25), 0, 'OVER quota must clamp to 0, never go negative');
assert.strictEqual(computeFillTarget(100, 0, 100, 25), 25, 'the per-request ceiling binds');
assert.strictEqual(computeFillTarget(20, 0, 3, 25), 3, 'never more than actually exist');

// --- isEligibleNow: (f) fails closed on every path -------------------------------------------
const now = Date.UTC(2026, 8, 4, 10, 0, 0);
const fresh = { status: 'Online', updatedAt: new Date(now - 60 * 1000).toISOString() };
assert.ok(isEligibleNow(fresh, 'Online', now), 'fresh heartbeat + Online for the process');
assert.ok(!isEligibleNow(fresh, 'Offline', now), 'not available for NDR specifically');
assert.ok(!isEligibleNow(fresh, null, now), 'per-process lookup failed - must fail closed');
assert.ok(!isEligibleNow({ ...fresh, status: 'OnCall' }, 'Online', now),
  'OnCall must not be topped up - the RTO side shipped without this and kept assigning for 14+ min');
assert.ok(!isEligibleNow({ ...fresh, status: 'Busy' }, 'Online', now));
assert.ok(!isEligibleNow(null, 'Online', now), 'never reported in at all');
assert.ok(!isEligibleNow({ status: 'Online', updatedAt: 'not a date' }, 'Online', now));
assert.ok(!isEligibleNow({ status: 'Online', updatedAt: null }, 'Online', now));
assert.ok(
  !isEligibleNow({ status: 'Online', updatedAt: new Date(now - STALE_MINUTES * 60 * 1000).toISOString() }, 'Online', now),
  'exactly at the staleness boundary is already stale - same >= comparison the sweep uses',
);
assert.ok(
  isEligibleNow({ status: 'Online', updatedAt: new Date(now - (STALE_MINUTES * 60 * 1000 - 1)).toISOString() }, 'Online', now),
  'one millisecond inside the window is still fresh',
);

console.log('ndrAssignment.test.js: all assertions passed');
