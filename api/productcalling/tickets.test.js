const assert = require('assert');
const handler = require('./tickets');
assert.strictEqual(typeof handler, 'function');
console.log('api/productcalling/tickets.test.js: all assertions passed');
