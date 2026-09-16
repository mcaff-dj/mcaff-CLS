// api/productcalling/upload.test.js
const assert = require('assert');
const handler = require('./upload');
assert.strictEqual(typeof handler, 'function', 'api/productcalling/upload.js must export a request handler');
console.log('api/productcalling/upload.test.js: all assertions passed');
