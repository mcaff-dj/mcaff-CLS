// Self-check for the claim-quota gate (leadQuota.js) - the cap that stops an agent's own
// "Claim" button from walking past the limit scripts/assign_leads.py already respects.
// Pure/offline: no DB, no sheet, no React. Run with `node api/_lib/leadQuota.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) an unset quota read as 0, which would block an agent from every lead (case 3)
//   (b) the lead being claimed counted against its own claim, blocking the last slot (case 5)
//   (c) disposed leads counted as load, so an agent who worked their queue stays blocked (case 2)
//   (d) case/whitespace drift in emails or order ids splitting one agent into two (case 6)
const assert = require('assert');
const { isTicketUndisposed, resolveAgentQuota, countUndisposedLoad, checkClaimQuota } = require('./leadQuota');

const ROSTER = [
  { email: 'Agent.One@x.com', maxQuota: 3 },
  { email: 'agent.two@x.com', maxQuota: null }, // unset -> default
];
const pending = (orderNumber, assignedAgent) => ({ orderNumber, assignedAgent, status: 'Pending' });

// 1. Undisposed test matches the CRM's own: any of disposition/remarks/non-Pending = worked.
assert.strictEqual(isTicketUndisposed(pending('A1', 'a@x.com')), true);
assert.strictEqual(isTicketUndisposed({ ...pending('A2', 'a@x.com'), disposition: 'Refunded' }), false);
assert.strictEqual(isTicketUndisposed({ ...pending('A3', 'a@x.com'), agentRemarks: 'called' }), false);
assert.strictEqual(isTicketUndisposed({ ...pending('A4', 'a@x.com'), status: 'Disposed' }), false);

// 2. Only this agent's UNDISPOSED leads count.
const tickets = [
  pending('A1', 'agent.one@x.com'),
  pending('A2', 'agent.one@x.com'),
  { ...pending('A3', 'agent.one@x.com'), disposition: 'Refunded' }, // worked - must not count
  pending('B1', 'someone.else@x.com'),                              // another agent
  pending('U1', ''),                                                // unassigned
];
assert.strictEqual(countUndisposedLoad(tickets, 'agent.one@x.com'), 2);

// 3. An unset (null) or absent quota falls back to the default - never 0.
assert.strictEqual(resolveAgentQuota(ROSTER, 'agent.two@x.com', 20), 20, 'null quota must mean default');
assert.strictEqual(resolveAgentQuota(ROSTER, 'nobody@x.com', 20), 20, 'absent agent must mean default');
assert.strictEqual(resolveAgentQuota(ROSTER, 'agent.one@x.com', 20), 3, 'explicit quota wins');
assert.strictEqual(resolveAgentQuota(ROSTER, 'a@x.com', 20), 20);
// An explicit 0 IS a real cap (admin deliberately benching someone), not "unset".
assert.strictEqual(resolveAgentQuota([{ email: 'z@x.com', maxQuota: 0 }], 'z@x.com', 20), 0);

// 4. At quota blocks; under quota allows.
const atQuota = [pending('A1', 'a@x.com'), pending('A2', 'a@x.com'), pending('A3', 'a@x.com')];
const blocked = checkClaimQuota({ tickets: atQuota, roster: [{ email: 'a@x.com', maxQuota: 3 }], email: 'a@x.com', defaultQuota: 20 });
assert.strictEqual(blocked.allowed, false);
assert.strictEqual(blocked.load, 3);
assert.strictEqual(blocked.quota, 3);
assert.match(blocked.reason, /quota of 3/);

const under = checkClaimQuota({ tickets: atQuota.slice(0, 2), roster: [{ email: 'a@x.com', maxQuota: 3 }], email: 'a@x.com', defaultQuota: 20 });
assert.strictEqual(under.allowed, true);
assert.strictEqual(under.reason, null);

// 5. The lead being claimed never counts against its own claim. Without this an agent whose
//    optimistic local override already tagged the row would be refused their own last slot.
const withSelf = [...atQuota]; // 3 held, quota 3
const selfExcluded = checkClaimQuota({
  tickets: withSelf, roster: [{ email: 'a@x.com', maxQuota: 3 }], email: 'a@x.com',
  defaultQuota: 20, excludeOrderKey: 'A3',
});
assert.strictEqual(selfExcluded.allowed, true, 'claiming a lead already tagged locally must not block itself');
assert.strictEqual(selfExcluded.load, 2);

// 6. Case/whitespace drift must not split one agent into two (Column Q is hand-editable).
const messy = [pending('a1', '  Agent.One@X.com '), pending('a2', 'AGENT.ONE@x.com')];
assert.strictEqual(countUndisposedLoad(messy, 'agent.one@x.com'), 2, 'email matching must be case/space insensitive');
assert.strictEqual(countUndisposedLoad(messy, 'agent.one@x.com', ' a1 '), 1, 'order key matching must be case/space insensitive');

// 7. Empty/missing inputs are safe - a roster that has not loaded yet must not crash the claim
//    path, and must not silently read as "no quota".
assert.strictEqual(countUndisposedLoad(undefined, 'a@x.com'), 0);
assert.strictEqual(resolveAgentQuota(undefined, 'a@x.com', 20), 20);
assert.strictEqual(checkClaimQuota({ tickets: [], roster: [], email: 'a@x.com', defaultQuota: 20 }).allowed, true);

console.log('leadQuota.test.js: all assertions passed');
