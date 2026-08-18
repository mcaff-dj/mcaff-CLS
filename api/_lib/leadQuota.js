// How many undisposed leads an agent may hold, and how many they currently hold.
//
// Lives here, next to leadAssignmentRules.json, for the same reason that file does: it is the
// single definition shared by everything that enforces the cap. Three callers today -
// app/rto-crm/RtoCrmClient.js's single claim and its admin bulk reassign (both client-side,
// for immediate feedback) and api/rto/claim.js (server-side, the authoritative gate) - and
// they must not drift, because an agent blocked by one and waved through by another is how
// the cap silently stops meaning anything.
//
// Kept PURE (no DB, no fetch, no React) so it is directly testable - see leadQuota.test.js.
// CommonJS rather than ESM because api/ is CommonJS; Next transpiles it fine for the client
// import, the same way leadAssignmentRules.json is shared across that boundary.
//
// Background: quota used to be enforced ONLY inside scripts/assign_leads.py's auto-assignment.
// An agent's own "Claim" button wrote Column Q directly with no cap at all, which is how five
// of six online agents ended up over quota on 2026-08-18 (one at 34 against a cap of 20) - and
// since the auto-assigner then correctly refused to give an over-quota agent more work, it
// presented to those agents as "the robot stopped assigning me leads."

// A lead counts toward its holder's load until it has actually been worked. Mirrors both
// RtoCrmClient.js's own isDisposed test and scripts/assign_leads.py's (Connected / Attempt /
// Disposition / Remarks all mean "worked"), so the CRM, this gate and the cron cannot disagree
// about what "load" means.
function isTicketUndisposed(ticket) {
  if (!ticket) return false;
  return !(ticket.disposition || ticket.agentRemarks || ticket.status !== 'Pending');
}

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

function normalizeOrderKey(orderNumber) {
  return (orderNumber || '').toString().trim().toUpperCase();
}

// The agent's own per-process cap, or the process default when they have no row / an explicit
// NULL. A missing quota means "unset" and must fall back to the default - never 0, which would
// silently make them ineligible for every lead rather than merely uncapped.
function resolveAgentQuota(roster, email, defaultQuota) {
  const target = normalizeEmail(email);
  const entry = (roster || []).find((a) => normalizeEmail(a && a.email) === target);
  return entry && entry.maxQuota != null ? entry.maxQuota : defaultQuota;
}

// Undisposed leads currently held by `email`. excludeOrderKey drops the lead being claimed
// right now: it is still unassigned at the moment of the check, so counting it would let a
// stale local override make an agent look one lead fuller than they are.
function countUndisposedLoad(tickets, email, excludeOrderKey) {
  const target = normalizeEmail(email);
  const skip = normalizeOrderKey(excludeOrderKey);
  let load = 0;
  for (const t of tickets || []) {
    if (normalizeEmail(t && t.assignedAgent) !== target) continue;
    if (skip && normalizeOrderKey(t.orderNumber) === skip) continue;
    if (isTicketUndisposed(t)) load++;
  }
  return load;
}

// { allowed, load, quota, reason } - the whole decision in one call so every caller reports
// the same numbers back to the agent, not just the same verdict.
function checkClaimQuota({ tickets, roster, email, defaultQuota, excludeOrderKey }) {
  const quota = resolveAgentQuota(roster, email, defaultQuota);
  const load = countUndisposedLoad(tickets, email, excludeOrderKey);
  if (load >= quota) {
    return {
      allowed: false,
      load,
      quota,
      reason: `You already hold ${load} undisposed lead(s) - at your quota of ${quota}. Dispose some before claiming more.`,
    };
  }
  return { allowed: true, load, quota, reason: null };
}

module.exports = {
  isTicketUndisposed,
  resolveAgentQuota,
  countUndisposedLoad,
  checkClaimQuota,
};
