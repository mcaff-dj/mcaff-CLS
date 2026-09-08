// Self-check for assignDetractorLeadsToAgent's loop control (db.js) - pure once claimFn is
// stubbed out, no database involved. Run with `node api/_lib/db.detractorAssign.test.js`.
const assert = require('assert');
const { assignDetractorLeadsToAgent, topUpDetractorAgent } = require('./db');

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

  // A duplicate-key race on one slot (two concurrent claims for the same oldest lead) retries
  // that same slot instead of aborting the whole batch - the loser eventually gets the next
  // lead once the collision clears, and remaining slots are unaffected.
  {
    let calls = 0;
    const claimFn = async () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error('Duplicate entry');
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      return { response_id: `L${calls}` };
    };
    const claimed = await assignDetractorLeadsToAgent('a@x.com', 2, claimFn);
    assert.strictEqual(calls, 3, 'must retry the colliding slot, not abort the loop');
    assert.deepStrictEqual(claimed.map((c) => c.response_id), ['L2', 'L3']);
  }

  // A non-duplicate-key error is a real failure, not a race - it must still propagate/abort the
  // whole batch exactly as before, not be swallowed like ER_DUP_ENTRY.
  {
    const claimFn = async () => { throw new Error('connection reset'); };
    await assert.rejects(
      () => assignDetractorLeadsToAgent('a@x.com', 2, claimFn),
      /connection reset/,
    );
  }

  // topUpDetractorAgent's guard order - the shared entry point all three auto-assign triggers
  // (going Online, presence heartbeat, admin roster toggle) now call.
  {
    // Offline for the process: never even looks at quota, never assigns.
    let quotaCalls = 0, assignCalls = 0;
    const claimed = await topUpDetractorAgent('a@x.com', {
      availabilityFn: async () => 'Offline',
      quotaLoadFn: async () => { quotaCalls += 1; return { quota: 15, load: 0 }; },
      assignFn: async () => { assignCalls += 1; return [{ response_id: 'L1' }]; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(quotaCalls, 0, 'must short-circuit before the quota lookup');
    assert.strictEqual(assignCalls, 0);
  }
  {
    // Online but already at quota: no assignment, and not a negative count.
    let assignCalls = 0;
    const claimed = await topUpDetractorAgent('a@x.com', {
      availabilityFn: async () => 'Online',
      quotaLoadFn: async () => ({ quota: 10, load: 12 }),
      assignFn: async () => { assignCalls += 1; return []; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(assignCalls, 0, 'over-quota must not reach assignDetractorLeadsToAgent');
  }
  {
    // Online and short: asks for exactly the shortfall, not the whole quota.
    let asked = null;
    const claimed = await topUpDetractorAgent('a@x.com', {
      availabilityFn: async () => 'Online',
      quotaLoadFn: async () => ({ quota: 15, load: 11 }),
      assignFn: async (email, count) => { asked = { email, count }; return [{ response_id: 'L1' }]; },
    });
    assert.deepStrictEqual(asked, { email: 'a@x.com', count: 4 });
    assert.strictEqual(claimed.length, 1);
  }
  {
    // No email (an admin row with nothing behind it): no lookups at all.
    let availabilityCalls = 0;
    const claimed = await topUpDetractorAgent('', {
      availabilityFn: async () => { availabilityCalls += 1; return 'Online'; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(availabilityCalls, 0);
  }

  console.log('db.detractorAssign.test.js: all assertions passed');
})();
