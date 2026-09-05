// Self-check for assignDetractorLeadsToAgent's loop control (db.js) - pure once claimFn is
// stubbed out, no database involved. Run with `node api/_lib/db.detractorAssign.test.js`.
const assert = require('assert');
const { assignDetractorLeadsToAgent } = require('./db');

(async () => {
  // Stops exactly at maxCount when the pool never runs out.
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { response_id: `L${calls}` }; };
    const claimed = await assignDetractorLeadsToAgent('a@x.com', 3, claimFn);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(claimed.map((c) => c.response_id), ['L1', 'L2', 'L3']);
  }

  // Stops early the moment the pool is exhausted (null) - never calls claimFn again after.
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return calls <= 2 ? { response_id: `L${calls}` } : null; };
    const claimed = await assignDetractorLeadsToAgent('a@x.com', 5, claimFn);
    assert.strictEqual(calls, 3, 'must stop at the first null, not keep calling for the remaining slots');
    assert.strictEqual(claimed.length, 2);
  }

  // maxCount 0 (agent already at/over quota): never calls claimFn at all.
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { response_id: 'L1' }; };
    const claimed = await assignDetractorLeadsToAgent('a@x.com', 0, claimFn);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(claimed, []);
  }

  console.log('db.detractorAssign.test.js: all assertions passed');
})();
