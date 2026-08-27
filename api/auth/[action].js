// Consolidated auth routes (login/logout/callback/me/presence) into one dynamic-route
// file to stay under Vercel Hobby's 12-serverless-function cap. req.query.action tells
// us which logical route was hit; URLs are unchanged.
const { CARD_KEYS, CARD_LABELS, getUserByEmail, getUserPermissions, getUserTabPermissions, bootstrapAdminIfNeeded, logEvent, upsertAgentPresence, getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent, isCallingProcessAdmin } = require('../_lib/db');
const CALLING_PROCESSES = require('../_lib/callingProcesses.json');
const { getSession, setSessionCookie, clearSessionCookie } = require('../_lib/session');

const PRESENCE_STATUSES = new Set(['Online', 'Busy', 'OnCall', 'Offline']);
const GH_REPO = 'mcaff-dj/mcaff-CLS';
const RTO_ASSIGN_LAMBDA = 'mcaff-cls-assign-leads';
// Per-process assign target, for the /processPresence path below. rto moved to AWS Lambda
// on 2026-08-13, ndr followed the same day (see lambda/README.md) - both now go through
// triggerImmediateLambdaAssignment below instead of a GitHub Actions dispatch. Only a
// process still running its cron-driven assignment on GitHub Actions would need an entry
// in PROCESS_ASSIGN_WORKFLOW instead - currently none do. rto's own immediate trigger
// doesn't go through this map at all; it's called unconditionally from the global
// /presence path (see handlePresence) rather than per-process.
const PROCESS_ASSIGN_LAMBDA = { ndr: 'mcaff-cls-assign-ndr-leads' };
const PROCESS_ASSIGN_WORKFLOW = {};

const { triggerLambda: triggerImmediateLambdaAssignment } = require('../_lib/lambdaTrigger');

// Fires a still-on-GitHub-Actions process's own assign workflow on demand - same
// "don't make an agent wait for the next scheduled pass" reasoning as
// triggerImmediateLambdaAssignment above, just for whichever process's workflow hasn't
// moved to Lambda yet (currently none - see PROCESS_ASSIGN_WORKFLOW). Needs a GitHub PAT
// (Actions: write on this repo only) in GH_ACTIONS_TOKEN - best-effort: if it's not
// configured, or the dispatch call fails, this silently no-ops and the agent just gets
// picked up by the next scheduled run instead, so a missing/expired token never blocks
// the agent from working.
async function triggerImmediateAssignment(workflowFile) {
  const token = process.env.GH_ACTIONS_TOKEN;
  if (!token || !workflowFile) return;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (!resp.ok) {
      console.error('triggerImmediateAssignment failed:', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('triggerImmediateAssignment error:', e.message || e);
  }
}

// CloudFront deliberately does NOT forward the viewer's original Host header to the
// API Gateway origin (see the origin request policy - forwarding it made API Gateway
// reject every request, since it validates Host against its own execute-api domain).
// That means req.headers.host inside this Lambda is always the raw API Gateway
// domain, never the CloudFront domain the browser actually used - so building the
// OAuth redirect_uri from it would send Google a URL we never authorized. With no
// custom domain yet, PUBLIC_BASE_URL just pins the one real public address; falls
// back to the header-derived guess only if that env var isn't set.
function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

async function handleLogin(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('Server not configured: missing GOOGLE_CLIENT_ID.');
    return;
  }
  const redirectUri = `${publicBaseUrl(req)}/api/auth/callback`;
  const next = (req.query && req.query.next) || '/';
  const state = Buffer.from(JSON.stringify({ next })).toString('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}

async function handleLogout(req, res) {
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/' });
  res.end();
}

async function handleMe(req, res) {
  const session = await getSession(req);
  if (!session) {
    res.status(200).json({ authenticated: false });
    return;
  }
  res.status(200).json({
    authenticated: true,
    email: session.email,
    name: session.name,
    isAdmin: !!session.isAdmin,
    cards: (session.perms || []).map((k) => ({ key: k, label: CARD_LABELS[k] || k })),
    tabPerms: session.tabPerms || {},
  });
}

async function handleCallback(req, res) {
  try {
    const { code, state } = req.query || {};
    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(500).send('Server not configured: missing Google OAuth credentials.');
      return;
    }
    const redirectUri = `${publicBaseUrl(req)}/api/auth/callback`;

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      console.error('Google token exchange failed:', tokenResp.status, errBody);
      let detail = errBody;
      try {
        const parsed = JSON.parse(errBody);
        detail = parsed.error_description || parsed.error || errBody;
      } catch { /* not JSON, use raw body */ }
      res.status(502).send('Google token exchange failed: ' + detail);
      return;
    }
    const tokenData = await tokenResp.json();

    const infoResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
    if (!infoResp.ok) {
      res.status(502).send('Google token verification failed.');
      return;
    }
    const info = await infoResp.json();
    if (info.aud !== clientId) {
      res.status(401).send('Token audience mismatch.');
      return;
    }
    if (info.email_verified !== 'true' && info.email_verified !== true) {
      res.status(401).send('Google account email is not verified.');
      return;
    }

    const email = (info.email || '').toLowerCase();
    const name = info.name || email;

    let user = await getUserByEmail(email);
    if (!user) {
      user = await bootstrapAdminIfNeeded(email, name);
    }
    if (!user) {
      res.status(403).send('You do not have access to this site yet. Ask your admin to grant you access, then try signing in again.');
      return;
    }

    // Admins always get every card, regardless of what's in the permissions table - so a
    // newly-added card (e.g. today's mom/ndr/rto) is automatically visible to admins on
    // their next login, with no manual grant/backfill step needed. Same for tab
    // restrictions: admins never get one (empty object = every tab of every card).
    const permissions = user.is_admin ? CARD_KEYS : await getUserPermissions(user.id);
    const tabPerms = user.is_admin ? {} : await getUserTabPermissions(user.id);
    setSessionCookie(res, {
      uid: user.id,
      email: user.email,
      name: user.name,
      isAdmin: !!user.is_admin,
      perms: permissions,
      tabPerms,
    });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logEvent(user.id, user.email, null, 'login', null, ip).catch(() => {});

    let next = '/';
    try {
      if (state) next = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')).next || '/';
    } catch {
      /* ignore malformed state, fall back to / */
    }
    res.writeHead(302, { Location: next });
    res.end();
  } catch (e) {
    res.status(500).send('Login failed: ' + (e.message || String(e)));
  }
}

// RTO CRM agent presence (replaces the removed Supabase agent_status writes). Keyed
// by the caller's own session email/name by default - a non-admin can only ever
// report their own status, never spoof anyone else's. An admin caller may pass
// body.email to set a DIFFERENT agent's status instead (the roster table's per-row
// Status dropdown works for every row, not just the admin's own) - only honored when
// session.isAdmin is true, so a regular agent still can't touch anyone else's row.
//
// body.pendingBox (optional, a plain count the client already computes for its own
// UI - see rto-crm.html's `pend`) triggers an immediate off-cycle assignment run when
// the agent is going Online with an empty queue, instead of waiting up to 5 minutes
// for the next scheduled pass. Trusting the client's self-reported count here is low-
// risk: the worst a wrong/spoofed value can do is fire an extra (harmless, idempotent)
// assignment pass - assign_leads.py itself remains the sole authority on who actually
// gets which lead.
async function handlePresence(req, res) {
  const session = await getSession(req);
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  // GET: the roster table's live Status column reads straight from Postgres here,
  // instead of trusting each browser's own localStorage mock state - admin-only, since a
  // full roster of everyone's presence is the only thing a non-admin has no business
  // reading (see the Team Roster panel in rto-crm.html).
  if (req.method === 'GET') {
    // Optional 'YYYY-MM-DD' bounds - same convention as every other date-ranged endpoint in
    // this file (see dateBounds in db.js). Lets loggedInMinutes/breakMinutes follow the
    // Overview tab's own date-scope filter (Today/Yesterday/7 Days/Custom/All Time) instead of
    // always meaning "today" - omit either/both for an open-ended range. Both figures are
    // averaged per active day once the range spans more than one calendar day (see
    // getAgentPresenceLogSummary's own comment) - loggedInMinutes is minutes-since-IST-midnight
    // (a time-of-day, not a specific instant), not an ISO timestamp, precisely because an
    // average across several different calendar days can't be expressed as one.
    const dateFrom = (req.query && req.query.dateFrom) || undefined;
    const dateTo = (req.query && req.query.dateTo) || undefined;
    const processKey = (req.query && req.query.process) || '';
    if (!session.isAdmin) {
      // A process admin (isProcessAdmin - not company-wide) is NOT self-only past this point
      // either: they run this one process without being a full admin, same reasoning as the
      // Admin Panel/Next to Assign/business-hours exemptions elsewhere in this app (see
      // RtoCrmClient.js's own Invariants notes on this bug class - this was the same bare
      // `!session.isAdmin` omission, just server-side instead of a client-side tab gate). Scoped
      // to getCallingProcessAgents(processKey) - THIS process's roster - rather than everyone
      // company-wide, consistent with how /api/admin/business-hours and /calling-agents already
      // scope a process admin to only what they administer, not the full company's presence.
      if (processKey && await isCallingProcessAdmin(session.email, processKey)) {
        const [roster, allAgents, presenceSummary] = await Promise.all([
          getCallingProcessAgents(processKey), getAllAgentPresence(), getAgentPresenceLogSummary(dateFrom, dateTo),
        ]);
        const agents = {};
        for (const member of roster) {
          const email = member.email.toLowerCase();
          const summary = presenceSummary[email];
          agents[email] = {
            status: allAgents[email]?.status,
            updatedAt: allAgents[email]?.updatedAt,
            loggedInMinutes: summary?.loggedInMinutes ?? null,
            breakMinutes: summary?.breakMinutes || 0,
            busyMinutes: summary?.busyMinutes || 0,
          };
        }
        res.status(200).json({ agents });
        return;
      }
      // Not admin-only past this point: a signed-in agent may still read their OWN
      // loggedInMinutes/breakMinutes - the Overview tab's per-agent summary table (see
      // RtoCrmClient.js) needs these for every visible row, including a plain Agent's own
      // (their view is already scoped to just themselves there). Everyone else's presence
      // stays out of reach; only the caller's own email is ever looked up or returned.
      const email = session.email.toLowerCase();
      const summary = (await getAgentPresenceLogSummary(dateFrom, dateTo))[email] || {};
      res.status(200).json({
        agents: {
          [email]: {
            loggedInMinutes: summary.loggedInMinutes ?? null,
            breakMinutes: summary.breakMinutes || 0,
            busyMinutes: summary.busyMinutes || 0,
          },
        },
      });
      return;
    }
    const [agents, presenceSummary] = await Promise.all([getAllAgentPresence(), getAgentPresenceLogSummary(dateFrom, dateTo)]);
    for (const email of Object.keys(agents)) {
      const summary = presenceSummary[email];
      agents[email].loggedInMinutes = summary?.loggedInMinutes ?? null;
      agents[email].breakMinutes = summary?.breakMinutes || 0;
      agents[email].busyMinutes = summary?.busyMinutes || 0;
    }
    res.status(200).json({ agents });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  if (!PRESENCE_STATUSES.has(body.status)) {
    res.status(400).json({ error: 'status must be one of Online, Busy, OnCall, Offline' });
    return;
  }
  let targetEmail = session.email;
  let targetName = session.name || session.email;
  if (session.isAdmin && body.email) {
    targetEmail = String(body.email).toLowerCase();
    targetName = body.name || targetEmail;
  }
  await upsertAgentPresence(targetEmail, targetName, body.status);
  if (body.status === 'Online' && body.pendingBox === 0) {
    triggerImmediateLambdaAssignment(RTO_ASSIGN_LAMBDA).catch(() => {});
  }
  res.status(200).json({ ok: true });
}

// Exposes assign_leads.py's assigned_at stamps (see the CLS_RTO_calling table comment
// in api/_lib/db.js). Authenticated, not admin-only.
async function handleRecentAssignments(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  const hoursRaw = req.query && req.query.hours;
  const hours = Math.min(Math.max(parseInt(hoursRaw, 10) || 48, 1), 24 * 30);
  const assignments = await getRecentLeadAssignments(hours);
  res.status(200).json({ assignments });
}

// Every lead's real {assignedAt, disposedAt}, unbounded (see getAllLeadDates/getAllNdrLeadDates
// in db.js) - lets an Overview tab's Agent Performance Summary table date-filter each column by
// the real date its own event happened (assigned_at for the Assigned columns, disposed_at for
// the Disposed/Connected/Converted ones) instead of the lead's own Calling Date/Order Date.
// `process=ndr` switches to NDR's own table (keyed by awb, not order ID) - default (no query
// param) stays RTO's, so RtoCrmClient.js's existing call is unaffected.
//
// Gated below behind the 'calling' card + process tab, same as every other calling route
// (api/ndr/sheet.js, api/rto/sheet.js). This handler used to check only "is signed in" - that
// handed the WHOLE desk's live lead volume and pacing (every AWB/order's assign+dispose
// timestamps, unbounded) to any signed-in user of the entire site, not just calling agents.
async function handleLeadDates(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  const processKey = (req.query && req.query.process) === 'ndr' ? 'ndr' : 'rto';

  // ============================================================================================
  // PERMISSION GATE - do not remove. A later task (per-team lead scoping) extends this handler
  // by narrowing WHICH leads come back for a given team; that scoping must be layered on top of
  // this block, never in place of it. Removing this re-opens the whole-desk enumeration bug
  // this task exists to close (any signed-in user, any card, could read every lead's timing).
  //
  // Mirrors api/ndr/sheet.js's checkAccess (lines 30-35), an already-proven-in-production gate,
  // exactly - same two checks, same order, same absence semantics:
  //   - card check: no 'calling' entry in session.perms -> 403, regardless of tabs.
  //   - tab check: session.tabPerms.calling is the set of tabs report_tab_permissions actually
  //     restricts this user to. Per that table's own convention, NO ROWS for (user, 'calling')
  //     means UNRESTRICTED access to every tab of that card, not "no access" - so the check only
  //     fires when `tabs` is a non-empty array AND it excludes this processKey. Flipping that
  //     (e.g. treating a missing/empty tabs list as deny-all) would lock out every admin and
  //     every agent who was never explicitly narrowed to one process.
  if (!(session.perms || []).includes('calling')) {
    res.status(403).json({ error: 'You do not have access to Calling.' });
    return;
  }
  const tabs = session.tabPerms && session.tabPerms.calling;
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(processKey)) {
    res.status(403).json({ error: 'You do not have access to that process.' });
    return;
  }
  // ============================================================================================

  const leadDates = processKey === 'ndr' ? await getAllNdrLeadDates() : await getAllLeadDates();
  res.status(200).json({ leadDates });
}

// Records the disposal side of a lead's lifecycle in MySQL (assigned_at is
// assign_leads.py's side of the same row - see the CLS_RTO_calling comment in
// api/_lib/db.js), called from rto-crm.html's submitDisp() alongside its existing
// direct-to-Sheet write. Any signed-in agent may call this for their own disposition -
// not admin-only, since every agent disposes their own leads routinely.
async function handleRecordDisposition(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const orderId = (body.orderId || '').toString().trim();
  if (!orderId) {
    res.status(400).json({ error: 'orderId is required' });
    return;
  }
  try {
    const awbCode = (body.awbCode || '').toString().trim() || null;
    await recordLeadDisposition(orderId, session.email, awbCode, {
      disposition: body.disposition,
      agentRemarks: body.agentRemarks,
      connected: body.connected,
      attempt: body.attempt,
      refundAmount: typeof body.refundAmount === 'number' ? body.refundAmount : null,
      newOrderId: (body.newOrderId || '').toString().trim() || null,
      rtoReason: (body.rtoReason || '').toString().trim() || null,
      paymentMode: (body.paymentMode || '').toString().trim() || null,
    });
  } catch (e) {
    // A failed disposition write here has no other trace anywhere - the Sheet write
    // already succeeded independently, and the client's postJsonWithRetry only sees a
    // non-2xx status, not why. Log the real cause so it's actually findable via
    // CloudWatch instead of silently vanishing.
    console.error('recordDisposition failed for order', orderId, e);
    res.status(500).json({ error: 'Failed to record disposition' });
    return;
  }
  res.status(200).json({ ok: true });
}

// An agent's OWN availability for ONE calling process. The processes are independent, so
// "Online" is not a single global fact about a person - they can be taking RTO calls and not
// NDR ones. The global /presence route above still records "at their desk" (heartbeat);
// this records "available for this process", and scripts/assign_leads.py requires BOTH.
//
// Self-only by construction: the email comes from the caller's session, never the body, so an
// agent cannot set anyone else's availability. Admins change other people's rows through
// /api/admin/calling-agents instead, which is gated on isAdmin.
async function handleProcessPresence(req, res) {
  const session = await getSession(req);
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  const known = CALLING_PROCESSES.processes.map((p) => p.key);

  if (req.method === 'GET') {
    const processKey = (req.query && req.query.process) || '';
    if (!known.includes(processKey)) {
      res.status(400).json({ error: `process must be one of: ${known.join(', ')}` });
      return;
    }
    // Only ever the caller's own row - an agent has no business reading the roster.
    const mine = (await getCallingProcessAgents(processKey))
      .find((a) => a.email.toLowerCase() === session.email.toLowerCase());
    res.status(200).json({
      statuses: CALLING_STATUSES,
      status: (mine && mine.status) || 'Offline',
      maxQuota: (mine && mine.maxQuota) ?? null,
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  if (!known.includes(body.processKey)) {
    res.status(400).json({ error: `processKey must be one of: ${known.join(', ')}` });
    return;
  }
  try {
    // maxQuota is deliberately NOT accepted here - capacity is an admin decision, so an agent
    // can change their availability without being able to raise their own lead cap.
    await setCallingProcessAgent(body.processKey, session.email, { status: body.status }, session.email);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not update availability' });
    return;
  }
  if (body.status === 'Online' && PROCESS_ASSIGN_LAMBDA[body.processKey]) {
    triggerImmediateLambdaAssignment(PROCESS_ASSIGN_LAMBDA[body.processKey]).catch(() => {});
  } else if (body.status === 'Online' && PROCESS_ASSIGN_WORKFLOW[body.processKey]) {
    triggerImmediateAssignment(PROCESS_ASSIGN_WORKFLOW[body.processKey]).catch(() => {});
  }
  res.status(200).json({ ok: true, processKey: body.processKey, status: body.status });
}

const HANDLERS = { login: handleLogin, logout: handleLogout, me: handleMe, callback: handleCallback, presence: handlePresence, recentAssignments: handleRecentAssignments, leadDates: handleLeadDates, recordDisposition: handleRecordDisposition, processPresence: handleProcessPresence };

module.exports = async (req, res) => {
  const action = req.query && req.query.action;
  const handler = HANDLERS[action];
  if (!handler) {
    res.status(404).send('Not found.');
    return;
  }
  try {
    await handler(req, res);
  } catch (e) {
    // Without this, an unhandled DB error crashes the function with a generic platform
    // error and no application-level log line - the exact failure mode that let
    // disposed-lead writes vanish silently. Every handler above that does its own DB
    // work still gets a real error logged here as a backstop.
    console.error(`Unhandled error in auth/${action}:`, e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
};
