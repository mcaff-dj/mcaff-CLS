// Consolidated admin routes (users/permissions/audit) into one dynamic-route file,
// same technique already used by api/auth/[action].js. req.query.action tells us
// which logical route was hit; URLs are unchanged:
//   GET    /api/admin/users       -> list all users + their permissions (admin only)
//   POST   /api/admin/users       -> create/invite a user: { email, name, permissions: ['mcaffeine',...], tabPermissions: {hyphen:['csat']} }
//                                  -> or bulk-invite: { users: [{email,name},...], permissions: [...], tabPermissions: {...} }
//   DELETE /api/admin/users       -> delete a user outright: { userId }
//   POST   /api/admin/permissions -> grant whole card         { userId, cardKey }
//   DELETE /api/admin/permissions -> revoke whole card        { userId, cardKey }
//   PUT    /api/admin/permissions -> set tab restriction      { userId, cardKey, tabKeys }
//   GET    /api/admin/audit       -> most recent 200 access events (admin only)
//   GET    /api/admin/business-hours  -> every calling process's week (saved, or defaults)
//   POST   /api/admin/business-hours  -> save one process's week: { processKey, week: {mon:{open,close},...} }
//   GET    /api/admin/default-quota?process=detractor -> { quota } - that process's admin-set
//                                        default (null = never set, caller's own hardcoded
//                                        fallback applies - for detractor, that's
//                                        DETRACTOR_FALLBACK_QUOTA in api/_lib/db.js, moved there
//                                        from api/detractor/next-lead.js (now deleted - see the
//                                        2026-09-05 auto-assignment design spec)).
//   POST   /api/admin/default-quota   -> save it: { processKey, quota } - quota null/'' clears it.
//   GET    /api/admin/lead-order?process=detractor -> { order } - that process's admin-set
//                                        pull order: 'oldest' (default when null), 'newest'.
//   POST   /api/admin/lead-order      -> save it: { processKey, order } - order null/'' clears it.
//   GET    /api/admin/calling-agents?process=rto -> that process's roster + per-process status/quota
//   POST   /api/admin/calling-agents  -> { processKey, email, status?, maxQuota?, prepaidPct?,
//                                          priorityRtoReasons?, reassignPaymentMode?,
//                                          attemptCountFilter?, ndrReasonFilter?,
//                                          ndrPaymentModeFilter?, ndrBrandFilter? }
//   DELETE /api/admin/calling-agents  -> revoke ONE process's access for one agent, leaving
//                                        every other process/card they hold untouched:
//                                        { processKey, email }
//   GET    /api/admin/dispositions?process=ndr -> that process's own disposition tree (see
//                                        calling_process_dispositions - RTO's list stays
//                                        hardcoded in RtoCrmClient.js and never reads this).
//                                        Arbitrary nesting: each option carries its own
//                                        `children` array, at any depth.
//   POST   /api/admin/dispositions    -> add: { processKey, label, description?, parentId? }
//                                        parentId omitted/null = top-level option; a parent's
//                                        id = add as its child, at any depth.
//   PUT    /api/admin/dispositions    -> edit: { processKey, id, label?, description?,
//                                        childrenInputType? } - 'single'|'multi'|'text',
//                                        governs how id's OWN children render to an agent
//                                        or reorder ONE scope: { processKey, orderedIds: [...],
//                                        parentId? } - parentId omitted/null reorders the
//                                        top-level list, set reorders that parent's children.
//   DELETE /api/admin/dispositions    -> { processKey, id } (cascades to children if id is a
//                                        parent with any)
//   GET    /api/admin/calling-teams?process=<key> -> that process's teams (active only unless
//                                        ?includeInactive=1, which only a full admin may set).
//                                        Readable by a process admin so a team lead's own page
//                                        can show its team name.
//   POST   /api/admin/calling-teams   -> create: { processKey, name, sheetId, sheetTab }
//                                        FULL ADMIN ONLY (see handleCallingTeams for why).
//   PUT    /api/admin/calling-teams   -> update: { id, name?, sheetId?, sheetTab?, active? }
//                                        FULL ADMIN ONLY (see handleCallingTeams for why).
//   GET    /api/admin/delivery-partner-access -> { users: [{id,email,name,deliveryPartners,
//                                        queryCategories,role,tabAccess,tableAccess}], partners:
//                                        [...], queryCategories: [...] } - Delivery-Escalation's
//                                        own per-user Delivery Partner / Query Category
//                                        allowlists, page-tab (Overview/Fresh/Forced RTO/
//                                        Resolved/New Order Placed) allowlist, and Overview
//                                        sub-table allowlist, on top of the deliveryescalation
//                                        tab grant itself, not instead of it. role is a label only.
//   PUT    /api/admin/delivery-partner-access -> { userId, partners?, queryCategories?,
//                                        tabAccess?, tableAccess?, role? } - applies whichever
//                                        field is present; partners/queryCategories/tabAccess/
//                                        tableAccess: [] removes
//                                        that restriction.
const { sql, ensureSchema, CARD_KEYS, CARD_LABELS, setTabPermissions, deleteUser,
  getUserByEmail, getUserTabPermissions,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours,
  getCallingDefaultQuota, setCallingDefaultQuota, getCallingLeadOrder, setCallingLeadOrder, logEvent,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
  isCallingProcessAdmin, getAdministeredProcesses, resolveCallerTeam,
  listCallingTeams, createCallingTeam, updateCallingTeam,
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions,
  getAllDeliveryPartnerAccess, setDeliveryPartnerAccess, getDeliveryEscalationPartnerOptions,
  getAllDeliveryEscalationQueryCategoryAccess, setDeliveryEscalationQueryCategoryAccess,
  getDeliveryEscalationQueryCategoryOptions,
  getAllDeliveryEscalationUserRoles, setDeliveryEscalationUserRole } = require('../_lib/db');
const { teamScopeFor, coerceTeamId } = require('../_lib/callingTeams');
const { dispositionTeamFor } = require('../_lib/dispositionTrees');
const CALLING_PROCESSES = require('../_lib/callingProcesses.json');
const { CARD_TABS } = require('../_lib/tabs');
const { getSession } = require('../_lib/session');
const { sendMail, siteBaseUrl } = require('../_lib/mail');

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

async function upsertAndInvite(email, name, perms, tabPerms, req, awaitMail = true) {
  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  const isNewUser = existing.rows.length === 0;

  await sql`
    INSERT INTO users (email, name) VALUES (${email}, ${name})
    ON DUPLICATE KEY UPDATE name = COALESCE(NULLIF(VALUES(name), ''), name)
  `;
  const { rows } = await sql`SELECT id, email, name, is_admin FROM users WHERE email = ${email}`;
  const user = rows[0];
  for (const key of perms) {
    await sql`INSERT IGNORE INTO permissions (user_id, card_key) VALUES (${user.id}, ${key})`;
  }
  for (const [cardKey, tabKeys] of Object.entries(tabPerms || {})) {
    if (!perms.includes(cardKey)) continue;
    const validKeys = new Set((CARD_TABS[cardKey] || []).map((t) => t.key));
    await setTabPermissions(user.id, cardKey, (Array.isArray(tabKeys) ? tabKeys : []).filter((k) => validKeys.has(k)));
  }

  const { rows: permRows } = await sql`SELECT card_key FROM permissions WHERE user_id = ${user.id}`;
  const cardLabels = permRows.map((r) => CARD_LABELS[r.card_key] || r.card_key);

  // Best-effort notification. For a single invite this is still awaited before responding
  // so a slow send never risks the function tearing down mid-send. For bulk invite the
  // caller passes awaitMail=false: Resend is a synchronous third-party network call, and
  // awaiting it once per row inside a loop of possibly hundreds of invites put every one
  // of those round trips in the serial critical path for no reason - the DB writes above
  // are what the response actually depends on. Firing it here without awaiting lets it
  // resolve in the background while the loop moves on to the next row; either way, a mail
  // failure is still only logged, never allowed to fail the invite itself.
  const mailPromise = (async () => {
    try {
      const base = siteBaseUrl(req);
      const listHtml = cardLabels.length ? `<ul>${cardLabels.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p>(no reports yet)</p>';
      await sendMail({
        to: email,
        subject: isNewUser ? "You've been invited to Customer Query Segment Reports" : 'Your report access was updated',
        html: `
          <p>Hi ${name || email},</p>
          <p>${isNewUser ? "You've been given access to the Customer Query Segment Reports site." : 'Your access was just updated.'} You can currently view:</p>
          ${listHtml}
          <p><a href="${base}/">Sign in with Google</a> using this email address (${email}) to view them.</p>
        `,
      });
    } catch (e) {
      console.error('Invite email failed:', e.message || e);
    }
  })();
  if (awaitMail) await mailPromise;

  return user;
}

async function handleUsers(req, res, session) {
  if (req.method === 'GET') {
    const { rows: users } = await sql`SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC`;
    const { rows: perms } = await sql`SELECT user_id, card_key FROM permissions`;
    const { rows: tabPerms } = await sql`SELECT user_id, card_key, tab_key FROM report_tab_permissions`;
    const byUser = {};
    perms.forEach((p) => {
      (byUser[p.user_id] = byUser[p.user_id] || []).push(p.card_key);
    });
    const tabsByUser = {};
    tabPerms.forEach((p) => {
      const u = (tabsByUser[p.user_id] = tabsByUser[p.user_id] || {});
      (u[p.card_key] = u[p.card_key] || []).push(p.tab_key);
    });
    const result = users.map((u) => ({ ...u, permissions: byUser[u.id] || [], tabPermissions: tabsByUser[u.id] || {} }));
    res.status(200).json({ users: result, cardKeys: CARD_KEYS, cardTabs: CARD_TABS });
    return;
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const perms = Array.isArray(body.permissions) ? body.permissions.filter((k) => CARD_KEYS.includes(k)) : [];
    const tabPerms = (body.tabPermissions && typeof body.tabPermissions === 'object') ? body.tabPermissions : {};

    if (Array.isArray(body.users)) {
      // Bulk mode: shared `perms`/`tabPerms` applied to every entry, invited one at
      // a time (sequential, not parallel - keeps DB/Resend load predictable for a
      // human-triggered admin action and keeps per-row error isolation simple).
      const seen = new Set();
      const entries = body.users
        .map((u) => ({ email: ((u && u.email) || '').trim().toLowerCase(), name: ((u && u.name) || '').trim() }))
        .filter((e) => {
          if (!e.email || seen.has(e.email)) return false;
          seen.add(e.email);
          return true;
        });
      if (!entries.length) {
        res.status(400).json({ error: 'No valid emails supplied' });
        return;
      }
      const results = [];
      for (const entry of entries) {
        try {
          const user = await upsertAndInvite(entry.email, entry.name, perms, tabPerms, req, false);
          results.push({ email: entry.email, ok: true, user });
        } catch (e) {
          console.error('Bulk invite failed for', entry.email, e.message || e);
          results.push({ email: entry.email, ok: false, error: e.message || 'Failed' });
        }
      }
      res.status(200).json({ results });
      return;
    }

    const email = (body.email || '').trim().toLowerCase();
    const name = (body.name || '').trim();
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const user = await upsertAndInvite(email, name, perms, tabPerms, req);
    res.status(200).json({ user });
    return;
  }

  if (req.method === 'DELETE') {
    const body = parseBody(req);
    const userId = parseInt(body.userId, 10);
    if (!userId) {
      res.status(400).json({ error: 'Invalid userId' });
      return;
    }
    if (userId === session.uid) {
      res.status(400).json({ error: "You can't delete your own account." });
      return;
    }
    const deleted = await deleteUser(userId);
    if (!deleted) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(200).json({ ok: true, email: deleted.email });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

async function handlePermissions(req, res) {
  const body = parseBody(req);
  const userId = parseInt(body.userId, 10);
  const cardKey = body.cardKey;
  if (!userId || !CARD_KEYS.includes(cardKey)) {
    res.status(400).json({ error: 'Invalid userId or cardKey' });
    return;
  }

  if (req.method === 'POST') {
    await sql`INSERT IGNORE INTO permissions (user_id, card_key) VALUES (${userId}, ${cardKey})`;
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method === 'DELETE') {
    await sql`DELETE FROM permissions WHERE user_id = ${userId} AND card_key = ${cardKey}`;
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method === 'PUT') {
    const validKeys = new Set((CARD_TABS[cardKey] || []).map((t) => t.key));
    const tabKeys = Array.isArray(body.tabKeys) ? body.tabKeys.filter((k) => validKeys.has(k)) : [];
    // Naming specific tabs implies access to the card that contains them. Without this, ticking
    // (say) Calling -> Delivery-Escalation wrote report_tab_permissions rows while `permissions`
    // stayed empty, and every gate in the app checks the card FIRST - so the user was told
    // "You do not have access" despite the checkbox being ticked in the admin UI. An empty
    // tabKeys means "lift the tab restriction", not "grant the card", so it must not insert:
    // that would silently hand the whole card to someone who holds none of it.
    if (tabKeys.length) {
      await sql`INSERT IGNORE INTO permissions (user_id, card_key) VALUES (${userId}, ${cardKey})`;
    }
    await setTabPermissions(userId, cardKey, tabKeys);
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: 'Method not allowed' });
}

async function handleAudit(req, res) {
  const { rows } = await sql`SELECT email, card_key, action, detail, accessed_at, ip FROM audit_log ORDER BY accessed_at DESC LIMIT 200`;
  res.status(200).json({ entries: rows.map((r) => ({ ...r, cardLabel: r.card_key ? (CARD_LABELS[r.card_key] || r.card_key) : '' })) });
}

// GET  -> every process, each with its effective week (saved hours, or the defaults from
//         callingProcesses.json where nothing has been saved yet) plus `isDefault` so the UI
//         can show whether an admin has actually set them.
// POST -> { processKey, week: { mon: {open,close}, ... } }. A day with both times blank is
//         stored as closed; days omitted from `week` are left untouched.
// Admin-only by virtue of the gate in this file's own handler below.
async function handleBusinessHours(req, res, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  // Calling hours are per-PROCESS and shared by every team on that process - so on a process that
  // actually HAS two teams (today, only 'ndr' once both leads exist), letting either team's
  // process admin write here would let them change when the OTHER team's leads are handed out.
  // That is what the full-admin-only gate below exists to prevent.
  //
  // FINAL-7/F7: the gate used to be unconditional - `!session.isAdmin` alone - which locked RTO
  // and Escalation process admins out of their OWN calling hours too, desks that have no teams
  // and no stake in this feature at all. Narrowed to fire only when THIS process actually has 2+
  // active teams (resolveCallerTeam's activeTeamCount), so a process admin on a teamless desk
  // keeps exactly the write access they had before this feature shipped, and the lock only
  // engages for the process it exists to protect, on the same flip as the rest of the isolation
  // feature (a second ACTIVE calling_teams row). Reads stay open to a process admin either way
  // (their page needs to show the window).
  const body = parseBody(req);
  if (req.method !== 'GET') {
    const isProcessAdmin = session.isAdmin || (body.processKey && await isCallingProcessAdmin(session.email, body.processKey));
    if (!isProcessAdmin) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    if (!session.isAdmin) {
      const { activeTeamCount } = await resolveCallerTeam(session.email, body.processKey);
      if (activeTeamCount >= 2) {
        res.status(403).json({ error: 'Only a full admin can change calling hours' });
        return;
      }
    }
  }
  if (req.method === 'POST') {
    const known = CALLING_PROCESSES.processes.map((p) => p.key);
    if (!body.processKey || !known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    try {
      await setCallingBusinessHours(body.processKey, body.week || {}, session.email);
    } catch (e) {
      // Validation errors from setCallingBusinessHours are the admin's own input being wrong
      // (bad time, close before open, one time without the other) - worth showing verbatim
      // rather than as a generic 500.
      res.status(400).json({ error: e.message || 'Could not save business hours' });
      return;
    }
    await logEvent(session.uid, session.email, 'calling', 'business-hours', `Updated ${body.processKey} hours`, ip);
  }

  const saved = await getCallingBusinessHours();
  const allowed = session.isAdmin ? null : await getAdministeredProcesses(session.email);
  const processes = CALLING_PROCESSES.processes.map((p) => {
    const savedWeek = saved[p.key];
    const defaults = p.businessHours || {};
    const defaultDays = (defaults.days || []).map((d) => d.toLowerCase());
    const week = {};
    for (const day of BUSINESS_HOUR_DAYS) {
      if (savedWeek && savedWeek[day]) {
        week[day] = savedWeek[day];
      } else if (defaultDays.includes(day)) {
        week[day] = { open: defaults.start || '', close: defaults.end || '' };
      } else {
        week[day] = { open: '', close: '' };   // not a working day in the defaults
      }
    }
    return {
      key: p.key,
      label: p.label,
      icon: p.icon,
      implemented: !!p.implemented,
      timezone: defaults.timezone || 'IST',
      isDefault: !savedWeek,
      week,
    };
  });
  // A process admin only gets the processes they actually administer, so the editor can't
  // show them hours they have no business changing (the POST above would refuse anyway).
  const visible = session.isAdmin
    ? processes
    : processes.filter((p) => (allowed || []).includes(p.key));
  res.status(200).json({ days: BUSINESS_HOUR_DAYS, processes: visible });
}

// One process's admin-set default quota - unlike business hours there's nothing per-process to
// default TO (no calling_process_dispositions-style seed), so unset is just `quota: null` and
// the caller applies its own hardcoded fallback.
async function handleDefaultQuota(req, res, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const known = CALLING_PROCESSES.processes.map((p) => p.key);
  const body = parseBody(req);

  if (req.method === 'GET') {
    const processKey = (req.query && req.query.process) || '';
    if (!known.includes(processKey)) {
      res.status(400).json({ error: `process must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    const quota = await getCallingDefaultQuota(processKey);
    res.status(200).json({ quota });
    return;
  }

  if (req.method === 'POST') {
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, body.processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    try {
      const quota = await setCallingDefaultQuota(body.processKey, body.quota, session.email);
      await logEvent(session.uid, session.email, 'calling', 'default-quota', `${body.processKey}: default quota -> ${quota == null ? '(cleared)' : quota}`, ip);
      res.status(200).json({ quota });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not save default quota' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

// One process's admin-set lead pull order - 'oldest' (default), 'newest', or null/unset.
async function handleLeadOrder(req, res, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const known = CALLING_PROCESSES.processes.map((p) => p.key);
  const body = parseBody(req);

  if (req.method === 'GET') {
    const processKey = (req.query && req.query.process) || '';
    if (!known.includes(processKey)) {
      res.status(400).json({ error: `process must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    const order = await getCallingLeadOrder(processKey);
    res.status(200).json({ order });
    return;
  }

  if (req.method === 'POST') {
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, body.processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    try {
      const order = await setCallingLeadOrder(body.processKey, body.order, session.email);
      await logEvent(session.uid, session.email, 'calling', 'lead-order', `${body.processKey}: lead order -> ${order == null ? '(default: oldest)' : order}`, ip);
      res.status(200).json({ order });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not save lead order' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

// The caller's own team scope, resolved server-side from THEIR OWN calling_agent_process row -
// never from the request. This matters beyond NDR: /rto-crm?process=ndr and the escalation
// dashboards reach this same handleCallingAgents via GET with no NDR team context in the request
// at all, so the only trustworthy source of "which team is this caller on" is a DB lookup keyed
// by their own session email. A full admin may pass an explicit teamId to view or act on one
// team; teamScopeFor silently ignores that field for everyone else (see its own contract comment
// in callingTeams.js). For rto/escalation/deliveryescalation - processes with no teams at all -
// resolveCallerTeam returns activeTeamCount: 0, so teamScopeFor always yields undefined
// (unfiltered) regardless of who's asking. Team isolation only ever engages for a process that
// actually has 2+ active teams.
//
// explicitTeamId arrives as a query-string or JSON-body value, i.e. a STRING (or undefined/null/
// '' - an <select>'s natural encoding of its "All teams" option). teamScopeFor's contract is
// number | null | undefined and it does NOT coerce - passing a raw string through would make its
// downstream `row.teamId === teamId` strict-equality check never match a numeric column, silently
// returning an empty roster instead of the admin's chosen team.
//
// coerceTeamId, not a bare `explicitTeamId == null ? null : parseInt(explicitTeamId, 10)`: that
// guard only checks the OUTER value for null/undefined, so parseInt('', 10) = NaN still gets
// through as a "real" team id. NaN is `!= null`, so teamScopeFor's admin branch returns it
// straight to filterRosterByTeam, whose strict `r.teamId === NaN` can never match (NaN !== NaN in
// JS) - a full admin picking "All teams" would silently see an EMPTY roster instead of everyone.
// coerceTeamId folds both the null-check and the NaN-check into one place (see its own comment in
// callingTeams.js) so no call site has to remember both.
async function scopeFor(session, processKey, explicitTeamId) {
  const { callerTeamId, activeTeamCount } = await resolveCallerTeam(session.email, processKey);
  return {
    teamId: teamScopeFor({
      callerTeamId,
      activeTeamCount,
      explicitTeamId: coerceTeamId(explicitTeamId),
      isAdmin: session.isAdmin,
    }),
    callerTeamId,
    activeTeamCount,
  };
}

// GET  ?process=<key> -> everyone invited to that process, with their PER-PROCESS status and
//                        quota (see getCallingProcessAgents). Membership comes from the
//                        invitation rows, so this is also the answer to "who works this
//                        process". Team-scoped: a process admin sees only their own team's
//                        roster (see scopeFor above); a full admin sees everyone, or one team
//                        via ?teamId=.
// POST                -> { processKey, email, status?, maxQuota? } for one agent. Fields are
//                        independent: omitting maxQuota leaves an admin-set quota alone. A
//                        process admin may only touch an agent already on their own team's
//                        scoped roster, and only a full admin may move anyone between teams.
async function handleCallingAgents(req, res, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const known = CALLING_PROCESSES.processes.map((p) => p.key);

  if (req.method === 'POST') {
    const body = parseBody(req);
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, body.processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    // Only a company-wide admin may make someone a process admin. Without this a process
    // admin could promote themselves elsewhere or mint peers, which is privilege escalation -
    // the whole point of this role is that it stays confined to one process.
    if (body.isProcessAdmin !== undefined && !session.isAdmin) {
      res.status(403).json({ error: 'Only a full admin can grant or revoke process-admin rights' });
      return;
    }
    // Only a full admin may move an agent between teams. The same escalation shape as
    // isProcessAdmin above: a process admin who could set team_id could pull the OTHER team's
    // agents onto their own roster (drive-by reassignment), or push their own agents off their
    // team to hide them from metrics/rosters - either way, a scoping bypass dressed up as a
    // normal edit. Checked before the membership lookup below so a rejected request never
    // reaches the DB write.
    if (body.teamId !== undefined && !session.isAdmin) {
      res.status(403).json({ error: 'Only a full admin can change an agent\'s team' });
      return;
    }
    const { teamId } = await scopeFor(session, body.processKey, body.teamId);
    // A process admin may only touch an agent that is actually on THEIR OWN scoped roster -
    // checked by looking the target up within that roster, never by trusting body.email's
    // membership implicitly. Without this, TL-A could POST an arbitrary status/quota/filter
    // change for any email on TL-B's team; the isCallingProcessAdmin gate above is process-wide
    // and both NDR leads hold it, so it does nothing to keep the two teams apart on its own.
    // Skipped for a full admin, who is allowed to touch anyone (and whose teamId scope above is
    // already `undefined` unless they explicitly chose one).
    if (!session.isAdmin) {
      const scoped = await getCallingProcessAgents(body.processKey, teamId);
      const target = (body.email || '').trim().toLowerCase();
      if (!scoped.some((a) => a.email.toLowerCase() === target)) {
        res.status(403).json({ error: 'That agent is not on your team' });
        return;
      }
    }
    try {
      const agents = await setCallingProcessAgent(
        body.processKey, body.email,
        {
          status: body.status, maxQuota: body.maxQuota, isProcessAdmin: body.isProcessAdmin,
          prepaidPct: body.prepaidPct, priorityRtoReasons: body.priorityRtoReasons,
          reassignPaymentMode: body.reassignPaymentMode,
          attemptCountFilter: body.attemptCountFilter,
          ndrReasonFilter: body.ndrReasonFilter,
          ndrPaymentModeFilter: body.ndrPaymentModeFilter,
          ndrBrandFilter: body.ndrBrandFilter,
          detractorBrandFilter: body.detractorBrandFilter,
          teamId: body.teamId,
        },
        session.email,
      );
      await logEvent(session.uid, session.email, 'calling', 'process-agent',
        `${body.processKey}: ${body.email} status=${body.status ?? '-'} quota=${body.maxQuota ?? '-'}`, ip);
      // setCallingProcessAgent itself returns the FULL, unfiltered roster (it has no idea who's
      // asking) - forwarding that verbatim would mean a write that changed one agent answers
      // with every agent on the process, including the other team's. Re-scope the response the
      // same way the GET branch scopes its own read, using the SAME teamId this request was
      // already authorized against above.
      res.status(200).json({ statuses: CALLING_STATUSES, agents: await getCallingProcessAgents(body.processKey, teamId) });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not update agent' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const body = parseBody(req);
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, body.processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    const email = (body.email || '').trim().toLowerCase();
    // Same cross-team membership guard as the POST branch above, and more important here: a
    // revoke is the single most destructive thing this endpoint can do to another team's agent
    // (it removes their access to the whole process, not just one field). A non-admin process
    // admin may only revoke someone already on their own scoped roster.
    if (!session.isAdmin) {
      const { teamId } = await scopeFor(session, body.processKey, undefined);
      const scoped = await getCallingProcessAgents(body.processKey, teamId);
      if (!scoped.some((a) => a.email.toLowerCase() === email)) {
        res.status(403).json({ error: 'That agent is not on your team' });
        return;
      }
    }
    const user = email && await getUserByEmail(email);
    if (!user) {
      res.status(404).json({ error: `No user found for ${body.email || '(blank email)'}` });
      return;
    }
    // The "no tab rows = every process" convention (see api/_lib/tabs.js) cuts both ways: to
    // take away ONE process while leaving the rest untouched, an unrestricted user has to be
    // converted to an EXPLICIT list of every other calling tab - there is no way to express
    // "everything except X" other than spelling out "everything except X". A user who already
    // has an explicit list just loses this one entry from it.
    const currentTabs = (await getUserTabPermissions(user.id)).calling;
    const allCallingTabs = (CARD_TABS.calling || []).map((t) => t.key);
    const newTabs = (currentTabs && currentTabs.length)
      ? currentTabs.filter((k) => k !== body.processKey)
      : allCallingTabs.filter((k) => k !== body.processKey);
    if (newTabs.length === 0) {
      // setTabPermissions([]) DELETEs every tab row for this card, which - per the same
      // "no rows = every tab" convention this whole computation relies on - would turn a
      // revoke into an accidental grant of full access. If nothing is left after removing
      // this process, the correct outcome is no calling access at all, so the card permission
      // itself is revoked instead of leaving a zero-row "unrestricted" state behind.
      await sql`DELETE FROM permissions WHERE user_id = ${user.id} AND card_key = 'calling'`;
    } else {
      await setTabPermissions(user.id, 'calling', newTabs);
    }
    // Clears any per-process state alongside the access, not just is_process_admin: a stale
    // Online/quota row surviving a revoke is harmless on its own (membership no longer comes
    // from this table), but a stale is_process_admin=true would silently hand back
    // process-admin rights the moment anyone re-invites this person - a real privilege
    // surviving what looks like a full revoke. team_id gets the same treatment for the same
    // reason: teamId: null is the three-state contract's explicit UNASSIGN (undefined would
    // leave it untouched - see setCallingProcessAgent's own note). Without it a revoked agent
    // keeps their team_id and silently rejoins that team's roster and metrics the moment
    // anyone re-invites them, even though the access grant itself was fully revoked.
    try {
      await setCallingProcessAgent(body.processKey, email, { status: 'Offline', isProcessAdmin: false, teamId: null }, session.email);
    } catch (e) { /* best-effort - the access revocation above is what actually matters */ }
    await logEvent(session.uid, session.email, 'calling', 'process-revoke', `${body.processKey}: revoked for ${email}`, ip);
    res.status(200).json({ ok: true });
    return;
  }

  const processKey = (req.query && req.query.process) || '';
  if (!known.includes(processKey)) {
    res.status(400).json({ error: `process must be one of: ${known.join(', ')}` });
    return;
  }
  // Captured once and reused for the isProcessAdmin field below rather than called twice - same
  // email/processKey, same answer, and it's a real DB round trip (see isCallingProcessAdmin).
  const isProcessAdmin = session.isAdmin || await isCallingProcessAdmin(session.email, processKey);
  if (!isProcessAdmin) {
    res.status(403).json({ error: 'You do not administer that process' });
    return;
  }
  const { teamId, callerTeamId } = await scopeFor(session, processKey, req.query && req.query.teamId);
  const allTeams = await listCallingTeams(processKey);
  res.status(200).json({
    statuses: CALLING_STATUSES,
    agents: await getCallingProcessAgents(processKey, teamId),
    // Returned as their own fields rather than left for the client to infer. The frontend
    // currently learns isProcessAdmin by finding itself inside the roster array - which breaks
    // the moment the roster is team-filtered and the caller is unassigned (activeTeamCount >= 2,
    // callerTeamId null): teamScopeFor fails that caller closed, the roster comes back empty,
    // and a real process admin/TL would silently lose their whole Admin Panel with no error.
    // Sending isProcessAdmin/teamId/teams explicitly is what lets the client stop inferring.
    // Both fields are additive - an older client that doesn't read them behaves exactly as before.
    teamId: callerTeamId,
    isProcessAdmin,
    // FINAL-5/F5: listCallingTeams' rows carry sheetId/sheetTab - fine for a full admin (who
    // already administers sheet_id via handleCallingTeams below) but not for a process admin, who
    // reaches this branch too and whose only documented need is "show a TL its own team name" (see
    // teamId above). Strip to the display-only shape for anyone who isn't a full admin, so a
    // process admin's own network tab can't be used to read the OTHER team's live spreadsheet id.
    teams: session.isAdmin ? allTeams : allTeams.map((t) => ({ id: t.id, name: t.name, active: t.active })),
  });
}

// GET    ?process=<key> -> that process's own disposition list (empty until an admin adds
//                          some - there is no seeded default, since only RTO has a built-in
//                          list and this table intentionally never backs RTO).
// POST                  -> add one: { processKey, label, description? }
// PUT                   -> either edit one ({ processKey, id, label?, description? }) or
//                          reorder the whole list ({ processKey, orderedIds: [...] }) -
//                          orderedIds takes precedence if both id and orderedIds are sent.
// DELETE                -> { processKey, id }
// Same process-admin gate as business-hours/calling-agents above: whoever runs a process may
// shape its own disposition list without being a company-wide admin.
async function handleDispositions(req, res, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const known = CALLING_PROCESSES.processes.map((p) => p.key);
  const body = parseBody(req);

  // Which tree this request touches. A client-supplied teamId is honoured ONLY for a full admin
  // (same trust model as api/ndr/sheet.js): a Team Lead's team is DERIVED from their own
  // calling_agent_process row, so naming the other team's id in the body changes nothing.
  const dispProcessKey = req.method === 'GET' ? ((req.query && req.query.process) || '') : body.processKey;
  const { callerTeamId, activeTeamCount } = dispProcessKey
    ? await resolveCallerTeam(session.email, dispProcessKey)
    : { callerTeamId: null, activeTeamCount: 0 };
  const dispTeamId = dispositionTeamFor({
    callerTeamId,
    activeTeamCount,
    explicitTeamId: coerceTeamId(req.method === 'GET' ? (req.query && req.query.teamId) : body.teamId),
    isAdmin: !!session.isAdmin,
  });

  // No per-role resolution needed (unlike teamId, which is DERIVED for a non-admin so a Team
  // Lead can't target another team) - lead_type isn't a permission boundary, just which of two
  // admin-configurable trees this request means. 'product' or nothing (-> shared/Delivery tree).
  const rawLeadType = req.method === 'GET' ? (req.query && req.query.leadType) : body.leadType;
  const dispLeadType = rawLeadType === 'product' ? 'product' : null;

  if (req.method !== 'GET') {
    const isProcessAdmin = session.isAdmin || (body.processKey && await isCallingProcessAdmin(session.email, body.processKey));
    if (!isProcessAdmin) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    // The old rule here was full-admin-only whenever a process had 2+ active teams, because the
    // tree was shared and one lead's rename could break the other team's agents mid-call. Trees
    // are per-team now, so a lead editing their OWN tree is safe - but a process admin with no
    // team of their own on a split desk has no tree that is theirs, and must not fall through to
    // editing the shared one that both teams still fall back to.
    if (!session.isAdmin && activeTeamCount >= 2 && dispTeamId == null) {
      res.status(403).json({ error: 'You are not assigned to a team, so there is no disposition list of yours to edit.' });
      return;
    }
  }

  if (req.method === 'POST') {
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    try {
      const dispositions = await addProcessDisposition(body.processKey, body.label, body.description, session.email, body.parentId, dispTeamId, dispLeadType);
      const treeLabel = dispTeamId == null ? 'shared' : `team #${dispTeamId}`;
      await logEvent(session.uid, session.email, 'calling', 'disposition-add',
        `${body.processKey} (${treeLabel}): added "${body.label}"${body.parentId ? ` (child of #${body.parentId})` : ''}`, ip);
      res.status(200).json({ dispositions });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not add disposition' });
    }
    return;
  }

  if (req.method === 'PUT') {
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    try {
      const dispositions = Array.isArray(body.orderedIds)
        ? await reorderProcessDispositions(body.processKey, body.parentId, body.orderedIds, dispTeamId, dispLeadType)
        : await updateProcessDisposition(body.processKey, body.id, { label: body.label, description: body.description, childrenInputType: body.childrenInputType }, dispTeamId, dispLeadType);
      const treeLabel = dispTeamId == null ? 'shared' : `team #${dispTeamId}`;
      await logEvent(session.uid, session.email, 'calling', 'disposition-edit',
        Array.isArray(body.orderedIds) ? `${body.processKey} (${treeLabel}): reordered` : `${body.processKey} (${treeLabel}): edited #${body.id}`, ip);
      res.status(200).json({ dispositions });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not update disposition' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    const dispositions = await deleteProcessDisposition(body.processKey, body.id, dispTeamId, dispLeadType);
    const treeLabel = dispTeamId == null ? 'shared' : `team #${dispTeamId}`;
    await logEvent(session.uid, session.email, 'calling', 'disposition-delete', `${body.processKey} (${treeLabel}): deleted #${body.id}`, ip);
    res.status(200).json({ dispositions });
    return;
  }

  const processKey = (req.query && req.query.process) || '';
  if (!known.includes(processKey)) {
    res.status(400).json({ error: `process must be one of: ${known.join(', ')}` });
    return;
  }
  // Reading the list only needs the same 'calling' card + per-process tab access every other
  // process-scoped read already checks (see api/ndr/sheet.js's checkAccess) - NOT admin/
  // process-admin, which stayed the bar for POST/PUT/DELETE above (editing the list) since
  // those actually change it. This table was built purely for the Admin-side editor, where
  // "can read" and "can edit" were the same person, so nobody had reason to tell them apart
  // until NDR's own Call modal became the first PLAIN AGENT that needs to read this list to
  // pick a disposition - the old isCallingProcessAdmin-only gate 403'd every agent silently
  // (an empty picker, no visible error) since loadDispositions swallows the failure into
  // dispositionsError, which nothing outside the Admin tab's own card ever renders.
  const tabs = session.tabPerms && session.tabPerms.calling;
  const hasProcessAccess = (session.perms || []).includes('calling') &&
    (!Array.isArray(tabs) || !tabs.length || tabs.includes(processKey));
  if (!hasProcessAccess) {
    res.status(403).json({ error: 'You do not have access to that process.' });
    return;
  }
  res.status(200).json({ dispositions: await getProcessDispositions(processKey, dispTeamId, dispLeadType) });
}

// GET    ?process=<key>       -> that process's teams (active only unless ?includeInactive=1)
// Delivery-Escalation's own per-user Delivery Partner allowlist (delivery_escalation_partner_
// access) - an ADDITIONAL restriction on top of the deliveryescalation tab grant itself, not a
// replacement for it (see that table's own comment in bootstrapSchema). Readable/writable by a
// full admin OR a 'deliveryescalation' process admin (isCallingProcessAdmin) - no team concept
// here (this process has none, see DeliveryEscalationClient.js's own header comment), so unlike
// handleCallingTeams there's no "which team's data" question to gate on.
//
// GET -> { users: [{id, email, name, deliveryPartners: [...], queryCategories: [...], role,
//         tabAccess: [...], tableAccess: [...]}], partners: [...every distinct delivery_partner
//         value in Delivery_escalation], queryCategories: [...every distinct query_category
//         value in Delivery_escalation] } - users is pre-filtered to whoever would actually see
//         the deliveryescalation tab (full admin, or holds the 'calling' card with no tab
//         restriction, or with deliveryescalation explicitly in their tab list) - configuring
//         this for someone who can't open the tab at all wouldn't do anything. role defaults to
//         'Agent' for a user with no row in delivery_escalation_user_role yet (see
//         getAllDeliveryEscalationUserRoles).
// PUT { userId, partners?: [...], queryCategories?: [...], tabAccess?: [...],
//         tableAccess?: [...], role?: 'Agent'|'Partner'|'Team Leader' } -> applies whichever
//         field is present in the body; partners/queryCategories/tabAccess/tableAccess each
//         replace that field entirely ([] removes the restriction, back to every value/tab/
//         table). role is purely a label (see DELIVERY_ESCALATION_ROLES below) - it gates
//         nothing on its own.
//
// tabAccess restricts which of THIS PAGE'S OWN tabs (Overview/Fresh/Forced RTO/Resolved/New
// Order Placed - the `tab` state in DeliveryEscalationClient.js) an agent may open - reuses
// report_tab_permissions (getUserTabPermissions/setTabPermissions), same table the
// deliveryescalation tab grant itself lives in, just under its OWN card_key
// (DE_TAB_CARD_KEY) so it can never collide with that or any other card's tab_key namespace.
// Same "no rows = unrestricted" convention as every other allowlist here - see
// api/delivery-escalation/record.js's own allowedTabs check for where the ticket-list reads
// (view=fresh/resolved/forced_rto/new_order_placed, and op=export) enforce this; op=stats/
// daywise/geoCategory/awbHistory describe the whole desk regardless of which tab is open, so
// they're deliberately NOT gated by it.
const DELIVERY_ESCALATION_ROLES = ['Agent', 'Partner', 'Team Leader'];
const DE_TAB_CARD_KEY = 'deliveryescalation-tabs';
const DE_TAB_KEYS = ['overview', 'fresh', 'forced_rto', 'resolved', 'new_order_placed'];

// tableAccess: same idea one level DEEPER - which of the Overview tab's OWN sections (summary
// tiles, each TAT breakdown table, Query Category by Location, the repeat-offenders strip) an
// agent may see, on top of having Overview itself in tabAccess above. Its own card_key (never
// DE_TAB_CARD_KEY) so a 'daywise' table_key here can't collide with that card's 'overview'
// tab_key. UI-only, same as Overview itself already is in tabAccess (see that constant's own
// comment) - every section reads from op=stats/daywise/geoCategory, none of which is scoped to
// one section, so there is nothing narrower to enforce server-side.
const DE_OVERVIEW_TABLE_CARD_KEY = 'deliveryescalation-overview-tables';
const DE_OVERVIEW_TABLE_KEYS = [
  'summary', 'daywise', 'partnerwise', 'query_class', 'contact_bucket', 'geo_category', 'repeat_offenders',
];

async function handleDeliveryPartnerAccess(req, res, session) {
  const isProcessAdmin = session.isAdmin || await isCallingProcessAdmin(session.email, 'deliveryescalation');
  if (!isProcessAdmin) {
    res.status(403).json({ error: 'You do not administer Delivery-Escalation' });
    return;
  }

  if (req.method === 'GET') {
    const { rows: users } = await sql`SELECT id, email, name, is_admin FROM users ORDER BY email`;
    const { rows: perms } = await sql`SELECT user_id FROM permissions WHERE card_key = 'calling'`;
    const { rows: tabPerms } = await sql`SELECT user_id, tab_key FROM report_tab_permissions WHERE card_key = 'calling'`;
    const callingUserIds = new Set(perms.map((p) => p.user_id));
    const restrictedTabsByUser = {};
    tabPerms.forEach((t) => { (restrictedTabsByUser[t.user_id] = restrictedTabsByUser[t.user_id] || []).push(t.tab_key); });
    const eligible = users.filter((u) => {
      if (u.is_admin) return true; // full admin: every card/tab, regardless of `permissions` rows
      if (!callingUserIds.has(u.id)) return false; // no Calling card at all
      const tabs = restrictedTabsByUser[u.id];
      return !tabs || tabs.length === 0 || tabs.includes('deliveryescalation');
    });
    const [byUser, partners, categoriesByUser, queryCategories, rolesByUser, tabPermRows, tableAccessRows] = await Promise.all([
      getAllDeliveryPartnerAccess(),
      getDeliveryEscalationPartnerOptions(),
      getAllDeliveryEscalationQueryCategoryAccess(),
      getDeliveryEscalationQueryCategoryOptions(),
      getAllDeliveryEscalationUserRoles(),
      sql`SELECT user_id, tab_key FROM report_tab_permissions WHERE card_key = ${DE_TAB_CARD_KEY}`,
      sql`SELECT user_id, tab_key FROM report_tab_permissions WHERE card_key = ${DE_OVERVIEW_TABLE_CARD_KEY}`,
    ]);
    const tabAccessByUser = {};
    tabPermRows.rows.forEach((t) => { (tabAccessByUser[t.user_id] = tabAccessByUser[t.user_id] || []).push(t.tab_key); });
    const tableAccessByUser = {};
    tableAccessRows.rows.forEach((t) => { (tableAccessByUser[t.user_id] = tableAccessByUser[t.user_id] || []).push(t.tab_key); });
    const result = eligible.map((u) => ({
      id: u.id, email: u.email, name: u.name,
      deliveryPartners: byUser[u.id] || [],
      queryCategories: categoriesByUser[u.id] || [],
      role: rolesByUser[u.id] || 'Agent',
      tabAccess: tabAccessByUser[u.id] || [],
      tableAccess: tableAccessByUser[u.id] || [],
    }));
    res.status(200).json({ users: result, partners, queryCategories });
    return;
  }

  if (req.method === 'PUT') {
    const body = parseBody(req);
    if (!body.userId) { res.status(400).json({ error: 'userId is required' }); return; }
    if (Array.isArray(body.partners)) {
      const partners = body.partners.filter((p) => typeof p === 'string' && p);
      await setDeliveryPartnerAccess(body.userId, partners);
    }
    if (Array.isArray(body.queryCategories)) {
      const queryCategories = body.queryCategories.filter((c) => typeof c === 'string' && c);
      await setDeliveryEscalationQueryCategoryAccess(body.userId, queryCategories);
    }
    if (Array.isArray(body.tabAccess)) {
      const tabAccess = body.tabAccess.filter((t) => DE_TAB_KEYS.includes(t));
      await setTabPermissions(body.userId, DE_TAB_CARD_KEY, tabAccess);
    }
    if (Array.isArray(body.tableAccess)) {
      const tableAccess = body.tableAccess.filter((t) => DE_OVERVIEW_TABLE_KEYS.includes(t));
      await setTabPermissions(body.userId, DE_OVERVIEW_TABLE_CARD_KEY, tableAccess);
    }
    if (body.role !== undefined) {
      if (!DELIVERY_ESCALATION_ROLES.includes(body.role)) {
        res.status(400).json({ error: `role must be one of: ${DELIVERY_ESCALATION_ROLES.join(', ')}` });
        return;
      }
      await setDeliveryEscalationUserRole(body.userId, body.role);
    }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

// POST   { processKey, name, sheetId, sheetTab }        -> create   (FULL ADMIN ONLY)
// PUT    { id, name?, sheetId?, sheetTab?, active? }    -> update   (FULL ADMIN ONLY)
//
// Why writes are full-admin only, and never isCallingProcessAdmin: both NDR team leads hold
// process-admin on the 'ndr' process, so that check alone doesn't tell the two of them apart.
// sheet_id decides which spreadsheet the Editor-scoped Google service-account credential reads
// and writes - a process admin who could set it could redirect that credential at any sheet it
// can reach, or repoint the OTHER team's sheet at their own. Reads stay open to a process admin
// (checked with the same isCallingProcessAdmin gate every other process-scoped read in this file
// uses) so a team lead's own admin page can show its team's name - hence the full-admin gate
// below sits AFTER the GET branch returns, not before it.
async function handleCallingTeams(req, res, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const known = CALLING_PROCESSES.processes.map((p) => p.key);

  if (req.method === 'GET') {
    const processKey = (req.query && req.query.process) || '';
    if (!known.includes(processKey)) {
      res.status(400).json({ error: `process must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    // includeInactive exposes retired teams (e.g. a decommissioned sheet kept for history) -
    // only a full admin gets that view; a process admin only ever needs the live roster.
    const includeInactive = session.isAdmin && !!(req.query && req.query.includeInactive);
    const teams = await listCallingTeams(processKey, { includeInactive });
    // FINAL-5/F5: same strip as handleCallingAgents above - a process admin reaching this GET
    // branch (see the isCallingProcessAdmin check just above) gets display-only team shapes, not
    // sheetId/sheetTab. Only the POST/PUT branches below, which are full-admin-only, ever hand
    // sheet_id back to the caller who's allowed to know it.
    res.status(200).json({
      teams: session.isAdmin ? teams : teams.map((t) => ({ id: t.id, name: t.name, active: t.active })),
    });
    return;
  }

  // Everything past this point mutates a team, which decides where an Editor-scoped credential
  // points - full-admin only, per the note above the function. isCallingProcessAdmin must NOT
  // appear anywhere below this line.
  if (!session.isAdmin) {
    res.status(403).json({ error: 'Only a full admin can create or change a team' });
    return;
  }

  const body = parseBody(req);

  if (req.method === 'POST') {
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    try {
      // sheetTab is passed through untouched, never trimmed: the live NDR tab is literally
      // named 'Latest NDR ' with a significant trailing space, and createCallingTeam's own
      // validation (assertTeamFields) relies on getting that value verbatim.
      const team = await createCallingTeam(
        body.processKey,
        { name: body.name, sheetId: body.sheetId, sheetTab: body.sheetTab },
        session.email,
      );
      await logEvent(session.uid, session.email, 'calling', 'team-create',
        `${body.processKey}: ${team.name} -> ${team.sheetId}`, ip);
      res.status(200).json({ team });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not create team' });
    }
    return;
  }

  if (req.method === 'PUT') {
    try {
      const team = await updateCallingTeam(
        body.id,
        { name: body.name, sheetId: body.sheetId, sheetTab: body.sheetTab, active: body.active },
        session.email,
      );
      await logEvent(session.uid, session.email, 'calling', 'team-update',
        `${team.processKey}: ${team.name} active=${team.active} -> ${team.sheetId}`, ip);
      res.status(200).json({ team });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not update team' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  if (!session) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const action = req.query && req.query.action;

  // A process admin runs one calling process, so they may reach these routes and nothing
  // else here - users/permissions/audit stay company-wide-admin only, because those can
  // re-grant anyone's access. Each handler then checks they administer the SPECIFIC process
  // being read or written; passing this gate alone authorises nothing. 'calling-teams' is
  // listed here only for its GET branch (a team lead reading its own team name) - the handler
  // itself still turns every POST/PUT away from anyone but a full admin.
  const PROCESS_ADMIN_ACTIONS = ['business-hours', 'default-quota', 'lead-order', 'calling-agents', 'dispositions', 'calling-teams', 'delivery-partner-access'];
  if (!session.isAdmin && !PROCESS_ADMIN_ACTIONS.includes(action)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  await ensureSchema();
  if (action === 'users') return handleUsers(req, res, session);
  if (action === 'permissions') return handlePermissions(req, res);
  if (action === 'audit') return handleAudit(req, res);
  if (action === 'business-hours') return handleBusinessHours(req, res, session);
  if (action === 'default-quota') return handleDefaultQuota(req, res, session);
  if (action === 'lead-order') return handleLeadOrder(req, res, session);
  if (action === 'calling-agents') return handleCallingAgents(req, res, session);
  if (action === 'dispositions') return handleDispositions(req, res, session);
  if (action === 'calling-teams') return handleCallingTeams(req, res, session);
  if (action === 'delivery-partner-access') return handleDeliveryPartnerAccess(req, res, session);

  res.status(404).json({ error: 'Unknown admin route' });
};
