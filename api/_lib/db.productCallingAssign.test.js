// Self-check for assignProductCallingLeadsToAgent's loop control and topUpProductCallingAgent's
// guard order - pure once claimFn/deps are stubbed out, no database involved.
// Run with `node api/_lib/db.productCallingAssign.test.js`.
const assert = require('assert');
const { assignProductCallingLeadsToAgent, topUpProductCallingAgent } = require('./db');

(async () => {
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { lead_ref: `L${calls}` }; };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 3, claimFn);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(claimed.map((c) => c.lead_ref), ['L1', 'L2', 'L3']);
  }
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return calls <= 2 ? { lead_ref: `L${calls}` } : null; };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 5, claimFn);
    assert.strictEqual(calls, 3, 'must stop at the first null, not keep calling for the remaining slots');
    assert.strictEqual(claimed.length, 2);
  }
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { lead_ref: 'L1' }; };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 0, claimFn);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(claimed, []);
  }
  {
    let calls = 0;
    const claimFn = async () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error('Duplicate entry');
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      return { lead_ref: `L${calls}` };
    };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 2, claimFn);
    assert.strictEqual(calls, 3, 'must retry the colliding slot, not abort the loop');
    assert.deepStrictEqual(claimed.map((c) => c.lead_ref), ['L2', 'L3']);
  }
  {
    const claimFn = async () => { throw new Error('connection reset'); };
    await assert.rejects(
      () => assignProductCallingLeadsToAgent('a@x.com', 2, claimFn),
      /connection reset/,
    );
  }
  {
    let quotaCalls = 0, assignCalls = 0;
    const claimed = await topUpProductCallingAgent('a@x.com', {
      availabilityFn: async () => 'Offline',
      quotaLoadFn: async () => { quotaCalls += 1; return { quota: 15, load: 0 }; },
      assignFn: async () => { assignCalls += 1; return [{ lead_ref: 'L1' }]; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(quotaCalls, 0, 'must short-circuit before the quota lookup');
    assert.strictEqual(assignCalls, 0);
  }
  {
    let assignCalls = 0;
    const claimed = await topUpProductCallingAgent('a@x.com', {
      availabilityFn: async () => 'Online',
      quotaLoadFn: async () => ({ quota: 10, load: 12 }),
      assignFn: async () => { assignCalls += 1; return []; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(assignCalls, 0, 'over-quota must not reach assignProductCallingLeadsToAgent');
  }
  {
    let asked = null;
    const claimed = await topUpProductCallingAgent('a@x.com', {
      availabilityFn: async () => 'Online',
      quotaLoadFn: async () => ({ quota: 15, load: 11 }),
      assignFn: async (email, count) => { asked = { email, count }; return [{ lead_ref: 'L1' }]; },
    });
    assert.deepStrictEqual(asked, { email: 'a@x.com', count: 4 });
    assert.strictEqual(claimed.length, 1);
  }
  {
    let availabilityCalls = 0;
    const claimed = await topUpProductCallingAgent('', {
      availabilityFn: async () => { availabilityCalls += 1; return 'Online'; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(availabilityCalls, 0);
  }

  console.log('db.productCallingAssign.test.js: all assertions passed');
})();
