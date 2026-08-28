// Pure rules for per-team disposition trees - no DB, no network, so the decision of WHOSE tree a
// caller edits is unit-testable in a repo whose tests cannot open a connection (same reasoning as
// callingTeams.js, and the same reason both routes and db.js defer here instead of each
// reimplementing the check).
//
// See docs/superpowers/specs/2026-08-28-per-team-dispositions-design.md.

// Returns the team_id whose tree applies, or null for the SHARED tree (team_id IS NULL). null is
// never "denied" here - a caller with no team reads the shared list rather than an empty picker
// they cannot dispose from. Write-side refusals are the route's job, not this function's.
//
// activeTeamCount < 2 short-circuits FIRST, unconditionally: a process with no split has only a
// shared tree, so honouring an explicit teamId there would scope reads to a tree that does not
// exist and hand back an empty list. Same ordering rule (and the same bug avoided) as
// teamScopeFor in callingTeams.js.
function dispositionTeamFor({ callerTeamId = null, activeTeamCount = 0, explicitTeamId = null, isAdmin = false } = {}) {
  if (activeTeamCount < 2) return null;
  if (isAdmin) return explicitTeamId != null ? explicitTeamId : null;
  return callerTeamId == null ? null : callerTeamId;
}

// Flat rows -> an insert plan for copying a whole tree under a new owner, ordered so every parent
// is inserted before its children. Real ids are deliberately replaced by tempKeys: inserting a
// copy with the ORIGINAL parent_id would hang the new rows off the source tree, which is the one
// way this clone can silently corrupt the tree it copied from.
//
// Breadth-first from the roots, not a sort of the input: sort_order is scoped per parent, so the
// SELECT that produced these rows guarantees no ordering between levels (a child can arrive
// before its parent - see getProcessDispositions' own two-pass note). A row whose parent is not
// in the input is dropped rather than promoted to a root, since a stray root reads as a brand-new
// top-level outcome to everything that keys off top-level labels.
function planTreeClone(rows) {
  const byParent = new Map(); // parentId (or null) -> child rows, in sort order
  (rows || []).forEach((r) => {
    const key = r.parentId == null ? null : r.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  });
  byParent.forEach((list) => list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id));

  const plan = [];
  const tempKeyById = new Map();
  const queue = [...(byParent.get(null) || [])];
  while (queue.length) {
    const row = queue.shift();
    const tempKey = plan.length;
    tempKeyById.set(row.id, tempKey);
    plan.push({
      tempKey,
      parentTempKey: row.parentId == null ? null : tempKeyById.get(row.parentId),
      label: row.label,
      description: row.description == null ? null : row.description,
      sortOrder: row.sortOrder || 0,
      childrenInputType: row.childrenInputType || 'single',
    });
    queue.push(...(byParent.get(row.id) || []));
  }
  return plan;
}

module.exports = { dispositionTeamFor, planTreeClone };
