// Static self-check: db.js must still load (no syntax errors from the new CREATE TABLE block)
// and must export the functions later tasks in this plan add. Extended by Task 2's own test as
// those exports land - for now this only checks the module loads.
const assert = require('assert');
const db = require('./db');
assert.strictEqual(typeof db.ensureSchema, 'function', 'db.js must still export ensureSchema');
console.log('db.productCallingSchema.test.js: all assertions passed');
