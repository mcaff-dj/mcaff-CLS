// Self-check for the NDR courier-code buckets (api/_lib/db.js's getNdrCallingPartnerReasonBreakdown).
// Pure/offline: no DB, no sheet. Run with `node api/_lib/ndrPartnerCategory.test.js`.
const assert = require('assert');
const { categorizeNdrPartner, NDR_PARTNER_CATEGORIES } = require('./ndrPartnerCategory');

// Real raw values from the live NDR sheet's Courier Company column, each mapped to its
// canonical partner - the exact set the Calling Team Overview's Delivery Partner Breakdown
// needs collapsed into one row per courier regardless of service-tier suffix.
assert.strictEqual(categorizeNdrPartner('Blue Dart Surface'), 'Bluedart');
assert.strictEqual(categorizeNdrPartner('Bluedart brands 500 g Surface'), 'Bluedart');
assert.strictEqual(categorizeNdrPartner('DELHIVERY_NDD_DIRECT_H'), 'Delhivery');
assert.strictEqual(categorizeNdrPartner('DELHIVERY_NDD_MDIRECT'), 'Delhivery');
assert.strictEqual(categorizeNdrPartner('Delhivery_Direct'), 'Delhivery');
assert.strictEqual(categorizeNdrPartner('DLSRF_Direct'), 'Delhivery');
assert.strictEqual(categorizeNdrPartner('Pikndel_H_SDD'), 'Pikendel');
assert.strictEqual(categorizeNdrPartner('Pikndel_H_Rapid'), 'Pikendel');
assert.strictEqual(categorizeNdrPartner('Pikndel_M_Rapid'), 'Pikendel');
assert.strictEqual(categorizeNdrPartner('Pikndel_M_SDD'), 'Pikendel');
assert.strictEqual(categorizeNdrPartner('XBSRF_ Air_Direct'), 'Xpressbees');
assert.strictEqual(categorizeNdrPartner('XBSRF_Direct_NDD'), 'Xpressbees');
assert.strictEqual(categorizeNdrPartner('XBSRF_Direct'), 'Xpressbees');
assert.strictEqual(categorizeNdrPartner('Xpressbees_Direct'), 'Xpressbees');
assert.strictEqual(categorizeNdrPartner('Shadowfax_H_SDD'), 'Shadowfax');
assert.strictEqual(categorizeNdrPartner('Shadowfax_M_SDD'), 'Shadowfax');
assert.strictEqual(categorizeNdrPartner('Shadowfax_M_NDD'), 'Shadowfax');
assert.strictEqual(categorizeNdrPartner('Elasticrun_direct_M'), 'ElasticRun');
assert.strictEqual(categorizeNdrPartner('Elasticrun_direct_H'), 'ElasticRun');
assert.strictEqual(categorizeNdrPartner('DTDC_Surface_Direct'), 'DTDC');

// Casing shouldn't matter - the sheet's own spelling drifts case freely.
assert.strictEqual(categorizeNdrPartner('bluedart'), categorizeNdrPartner('BLUEDART'));

// Blank/unrecognized inputs fall to the catch-all rather than throwing or returning something
// that silently merges with a real partner's row.
for (const blank of ['', null, undefined, 'UNKNOWN', 'unknown', 'N/A']) {
  assert.strictEqual(categorizeNdrPartner(blank), 'Unknown/Other', `blank: ${blank}`);
}
assert.strictEqual(categorizeNdrPartner('Some Brand New Courier Co'), 'Unknown/Other');

// Every category the function can return must be listed, so a display ordering never silently
// drops a real partner to "wherever the caller happens to iterate it."
const produced = new Set(['Blue Dart Surface', 'DELHIVERY_NDD_DIRECT_H', 'Pikndel_H_SDD',
  'XBSRF_ Air_Direct', 'Shadowfax_H_SDD', 'Elasticrun_direct_M', 'DTDC_Surface_Direct',
  ''].map(categorizeNdrPartner));
for (const c of produced) assert.ok(NDR_PARTNER_CATEGORIES.includes(c), `unlisted category: ${c}`);

console.log('ndrPartnerCategory.test.js: all assertions passed');
