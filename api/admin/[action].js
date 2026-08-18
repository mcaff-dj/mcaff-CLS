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
const { sql, ensureSchema, CARD_KEYS, CARD_LABELS, setTabPermissions, deleteUser,
  getUserByEmail, getUserTabPermissions,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours, logEvent,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
  isCallingProcessAdmin, getAdministeredProcesses,
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions } = require('../_lib/db');
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
  if (req.method === 'POST') {
    const body = parseBody(req);
    const known = CALLING_PROCESSES.processes.map((p) => p.key);
    if (!body.processKey || !known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, body.processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
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

// GET  ?process=<key> -> everyone invited to that process, with their PER-PROCESS status and
//                        quota (see getCallingProcessAgents). Membership comes from the
//                        invitation rows, so this is also the answer to "who works this
//                        process".
// POST                -> { processKey, email, status?, maxQuota? } for one agent. Fields are
//                        independent: omitting maxQuota leaves an admin-set quota alone.
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
        },
        session.email,
      );
      await logEvent(session.uid, session.email, 'calling', 'process-agent',
        `${body.processKey}: ${body.email} status=${body.status ?? '-'} quota=${body.maxQuota ?? '-'}`, ip);
      res.status(200).json({ statuses: CALLING_STATUSES, agents });
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
    // surviving what looks like a full revoke.
    try {
      await setCallingProcessAgent(body.processKey, email, { status: 'Offline', isProcessAdmin: false }, session.email);
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
  if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, processKey))) {
    res.status(403).json({ error: 'You do not administer that process' });
    return;
  }
  res.status(200).json({ statuses: CALLING_STATUSES, agents: await getCallingProcessAgents(processKey) });
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
    try {
      const dispositions = await addProcessDisposition(body.processKey, body.label, body.description, session.email, body.parentId);
      await logEvent(session.uid, session.email, 'calling', 'disposition-add',
        `${body.processKey}: added "${body.label}"${body.parentId ? ` (child of #${body.parentId})` : ''}`, ip);
      res.status(200).json({ dispositions });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not add disposition' });
    }
    return;
  }

  if (req.method === 'PUT') {
    const body = parseBody(req);
    if (!known.includes(body.processKey)) {
      res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
      return;
    }
    if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, body.processKey))) {
      res.status(403).json({ error: 'You do not administer that process' });
      return;
    }
    try {
      const dispositions = Array.isArray(body.orderedIds)
        ? await reorderProcessDispositions(body.processKey, body.parentId, body.orderedIds)
        : await updateProcessDisposition(body.processKey, body.id, { label: body.label, description: body.description, childrenInputType: body.childrenInputType });
      await logEvent(session.uid, session.email, 'calling', 'disposition-edit',
        Array.isArray(body.orderedIds) ? `${body.processKey}: reordered` : `${body.processKey}: edited #${body.id}`, ip);
      res.status(200).json({ dispositions });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not update disposition' });
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
    const dispositions = await deleteProcessDisposition(body.processKey, body.id);
    await logEvent(session.uid, session.email, 'calling', 'disposition-delete', `${body.processKey}: deleted #${body.id}`, ip);
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
  res.status(200).json({ dispositions: await getProcessDispositions(processKey) });
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  if (!session) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const action = req.query && req.query.action;

  // A process admin runs one calling process, so they may reach these two routes and nothing
  // else here - users/permissions/audit stay company-wide-admin only, because those can
  // re-grant anyone's access. Each handler then checks they administer the SPECIFIC process
  // being read or written; passing this gate alone authorises nothing.
  const PROCESS_ADMIN_ACTIONS = ['business-hours', 'calling-agents', 'dispositions'];
  if (!session.isAdmin && !PROCESS_ADMIN_ACTIONS.includes(action)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  await ensureSchema();
  if (action === 'users') return handleUsers(req, res, session);
  if (action === 'permissions') return handlePermissions(req, res);
  if (action === 'audit') return handleAudit(req, res);
  if (action === 'business-hours') return handleBusinessHours(req, res, session);
  if (action === 'calling-agents') return handleCallingAgents(req, res, session);
  if (action === 'dispositions') return handleDispositions(req, res, session);

  res.status(404).json({ error: 'Unknown admin route' });
};
