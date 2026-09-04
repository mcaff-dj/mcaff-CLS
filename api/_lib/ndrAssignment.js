// Who may be given which NDR lead, and how many - the one definition of NDR's assignment rule.
//
// Lives here, alongside leadQuota.js, for exactly the reason that file gives: it is the single
// definition shared by everything that enforces the rule, and they must not drift. Three callers
// today, in two languages:
//
//   - scripts/assign_ndr_leads.py    the periodic sweep (Python - the ORIGINAL, and still the
//                                    authority on anything not exported here)
//   - api/ndr/next-lead.js           the interactive top-up an agent's own disposal triggers
//   - app/ndr-calling/NdrCallingClient.js  the roster's coverage count and the Predicted tab
//
// The Python side cannot import this, so that copy stays hand-mirrored (each function below
// names its Python twin). The two JavaScript callers MUST import it rather than re-deriving it:
// this week produced two separate bugs from exactly that drift - the Predicted tab kept its own
// pointer round-robin after the sweep moved off it, and separately ignored an agent's open load
// while the sweep subtracted it, so the tab confidently showed leads going to an agent who could
// not receive any.
//
// Kept PURE (no DB, no fetch, no React, no Sheets) so it is directly testable - see
// ndrAssignment.test.js. CommonJS rather than ESM because api/ is CommonJS; Next transpiles it
// fine for the client import, the same way leadQuota.js is already shared across that boundary.

// scripts/assign_ndr_leads.py's DEFAULT_QUOTA. NDR's own fallback, deliberately independent of
// RTO's leadAssignmentRules.json value.
const DEFAULT_QUOTA = 20;

// scripts/assign_ndr_leads.py's STALE_MINUTES - an agent_presence row older than this is not "at
// their desk", whatever the roster says. Must match the CRM's own heartbeat cadence.
const STALE_MINUTES = 10;

const ATTEMPT_BUCKETS = ['1', '2', '3', 'More than 3'];

// Attempt Count (a sheet cell, so a string) -> one of ATTEMPT_BUCKETS, or null when it cannot be
// parsed. Mirrors attempt_bucket() in scripts/assign_ndr_leads.py, including its fail-OPEN
// contract: null means "don't restrict", because an unreadable attempt count must never be the
// reason a lead is never called.
function attemptBucket(raw) {
  const n = parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 3 ? String(n) : 'More than 3';
}

// Brand has no column of its own in this sheet, so the Order ID prefix is the only source of
// truth for it. Mirrors brand_of() in scripts/assign_ndr_leads.py - tests the "HYP" PREFIX only.
function brandOf(orderId) {
  return String(orderId == null ? '' : orderId).toUpperCase().startsWith('HYP') ? 'Hyphen' : 'mCaffeine';
}

// 'DD-MM-YYYY' -> epoch ms, or Infinity when unparseable so an undated lead sorts LAST and can
// never jump the oldest-first queue. Mirrors parse_latest_ndr_date() in assign_ndr_leads.py
// (which returns None and is sorted with datetime.max for the same effect).
function parseLatestNdrDate(raw) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(raw == null ? '' : raw).trim());
  return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : Infinity;
}

// A calling_agent_process row (either the API's camelCase shape or the raw snake_case columns)
// -> the normalized filter shape every predicate below expects. '' / absent / null means
// unrestricted throughout, matching assign_ndr_leads.py's "absent means no restriction".
function normalizeAgentFilters(a) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const quota = a.maxQuota != null ? a.maxQuota : (a.max_quota != null ? a.max_quota : DEFAULT_QUOTA);
  return {
    email: a.email,
    quota,
    attemptFilter: list(a.attemptCountFilter != null ? a.attemptCountFilter : a.attempt_count_filter),
    reasonFilter: list(a.ndrReasonFilter != null ? a.ndrReasonFilter : a.ndr_reason_filter),
    paymentModeFilter: (a.ndrPaymentModeFilter != null ? a.ndrPaymentModeFilter : a.ndr_payment_mode_filter) || '',
    brandFilter: (a.ndrBrandFilter != null ? a.ndrBrandFilter : a.ndr_brand_filter) || '',
  };
}

// _covers() in assign_ndr_leads.py. An unparseable bucket (null) passes even against a set
// filter - the same fail-open the Python side documents.
const attemptCovers = (f, bucket) => !f.attemptFilter.length || bucket === null || f.attemptFilter.includes(bucket);

// reason_covers(). Free-text substring match. Unlike attemptCovers above, once a reason filter IS
// set a blank/unreadable reason does NOT fail open - it simply matches no substring.
const reasonCovers = (f, latestNdrReason) => {
  if (!f.reasonFilter.length) return true;
  const reason = String(latestNdrReason || '').toLowerCase();
  return f.reasonFilter.some((r) => reason.includes(r.toLowerCase()));
};

// payment_mode_covers(). Exact, case-insensitive - a fixed, controlled value set ('Prepaid'/
// 'COD'), unlike reasonCovers' free text above.
const paymentModeCovers = (f, paymentMode) => !f.paymentModeFilter
  || String(paymentMode || '').trim().toLowerCase() === f.paymentModeFilter.toLowerCase();

// brand_covers(). brandOf always returns exactly 'Hyphen' or 'mCaffeine', and the roster's own
// select only ever writes those two strings or '', so plain equality is enough.
const brandCovers = (f, brand) => !f.brandFilter || brand === f.brandFilter;

// All four hard filters at once: can this lead EVER reach this agent? Quota and queue position
// are deliberately NOT consulted - this answers "is this filter set satisfiable at all", which
// is a different question and the only one a 0 needs to answer.
//
// `lead` needs { attempts, latestNdrReason, paymentMode, brand } - `brand` already resolved via
// brandOf, since callers that read the sheet directly have the Order ID and callers working from
// mapped rows already carry brand.
function filtersCoverLead(f, lead) {
  return attemptCovers(f, attemptBucket(lead.attempts))
    && reasonCovers(f, lead.latestNdrReason)
    && paymentModeCovers(f, lead.paymentMode)
    && brandCovers(f, lead.brand);
}

// How many leads to hand one agent in one go: never past their quota, never past a hard
// per-request ceiling, never more than actually exist. Same shape as computeFillTarget in
// api/rto/next-lead.js and the same reason for each bound - see that file.
function computeFillTarget(quota, load, candidatesAvailable, maxPerRequest) {
  return Math.min(Math.max(0, quota - load), maxPerRequest, candidatesAvailable);
}

// The sweep's own eligibility rule, reduced to a pure function: BOTH a heartbeat-fresh global
// 'Online' in agent_presence AND 'Online' for this process in calling_agent_process. Mirrors
// fetch_online_ndr_agents() in assign_ndr_leads.py and isEligibleNow() in api/rto/next-lead.js.
//
// Fails CLOSED on anything missing or unparseable. An agent who has gone Busy/OnCall/Offline must
// not be topped up just because they happened to dispose something - the RTO side shipped without
// this check and kept assigning to an agent for 14+ minutes after she went OnCall.
function isEligibleNow(presence, perProcessStatus, nowMs) {
  if (!presence || presence.status !== 'Online') return false;
  const updatedAtMs = new Date(presence.updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) return false;
  if (nowMs - updatedAtMs >= STALE_MINUTES * 60 * 1000) return false;
  return perProcessStatus === 'Online';
}

module.exports = {
  DEFAULT_QUOTA,
  STALE_MINUTES,
  ATTEMPT_BUCKETS,
  attemptBucket,
  brandOf,
  parseLatestNdrDate,
  normalizeAgentFilters,
  attemptCovers,
  reasonCovers,
  paymentModeCovers,
  brandCovers,
  filtersCoverLead,
  computeFillTarget,
  isEligibleNow,
};
