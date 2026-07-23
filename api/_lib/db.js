// Postgres access + schema bootstrap. @vercel/postgres's `sql` specifically reads
// process.env.POSTGRES_URL - but Vercel storage integrations name their connection
// string var all sorts of things (sometimes with a custom prefix, e.g. this project's
// Neon integration uses "auth_POSTGRES_URL" etc.), so search broadly for it rather
// than requiring an exact name.
if (!process.env.POSTGRES_URL) {
  const candidateNames = Object.keys(process.env).filter((k) =>
    /(^|_)(POSTGRES_URL|DATABASE_URL)$/.test(k) && !/_UNPOOLING|NON_POOLING|UNPOOLED|NO_SSL|PRISMA/.test(k)
  );
  // Prefer an exact/prefixed POSTGRES_URL or DATABASE_URL match; fall back to
  // anything else that looks like a connection string var if none found.
  const preferred = candidateNames.find((k) => k.endsWith('POSTGRES_URL')) || candidateNames.find((k) => k.endsWith('DATABASE_URL'));
  if (preferred) {
    process.env.POSTGRES_URL = process.env[preferred];
  }
}
const { sql } = require('@vercel/postgres');

let schemaReady = false;

// Idempotent - safe to call on every cold start. Only runs the DDL once per warm instance.
async function ensureSchema() {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_key TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, card_key)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      card_key TEXT NOT NULL,
      accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ip TEXT
    )
  `;
  // card_key was NOT NULL - login events aren't tied to a report, so it needs to allow
  // NULL. action/detail distinguish what actually happened (view / login / csv_export /
  // raw_download) since previously every row was implicitly a "view". Both ALTERs are
  // idempotent - safe to run on every cold start alongside the CREATE TABLE above.
  await sql`ALTER TABLE audit_log ALTER COLUMN card_key DROP NOT NULL`;
  await sql`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'view'`;
  await sql`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detail TEXT`;
  // Sub-permission within an already-granted card (e.g. "just the CSAT tab under
  // Hyphen"), UI-level only - see api/_lib/tabs.js. No rows for a (user, card) pair
  // means "no restriction, full access to every tab", so existing grants are
  // unaffected by this table's existence.
  await sql`
    CREATE TABLE IF NOT EXISTS report_tab_permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_key TEXT NOT NULL,
      tab_key TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, card_key, tab_key)
    )
  `;
  // The npsdeepdive card was renamed to deepdive (gained a CSAT/Agent tab split) -
  // carry forward any rows granted under the old key so no one silently loses
  // access. Safe to run on every cold start: a no-op once the old key is gone.
  await sql`UPDATE permissions SET card_key = 'deepdive' WHERE card_key = 'npsdeepdive'`;
  await sql`UPDATE report_tab_permissions SET card_key = 'deepdive' WHERE card_key = 'npsdeepdive'`;
  await sql`UPDATE audit_log SET card_key = 'deepdive' WHERE card_key = 'npsdeepdive'`;
  // RTO CRM agent online/offline state (replaces the removed Supabase agent_status
  // table) - one row per agent, upserted on every explicit status change and
  // periodic heartbeat. scripts/assign_leads.py reads this directly (via its own
  // Postgres connection) to decide who's eligible for new leads.
  await sql`
    CREATE TABLE IF NOT EXISTS agent_presence (
      email TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Records when scripts/assign_leads.py actually assigned each lead (by the sheet's
  // own Order ID). rto-crm.html's "Reset Stale Pending Leads" only had the lead's own
  // Calling Date to judge staleness by, which unassigned leads the moment they were
  // handed out - the backlog assign_leads.py distributes is old by definition, so
  // every fresh assignment looked exactly as "stale" as a genuinely-ignored one. This
  // table lets the reset button tell the two apart. Written by assign_leads.py
  // directly (its own psycopg connection), read by rto-crm.html via a new
  // /api/auth/[action].js?action=recentAssignments endpoint.
  await sql`
    CREATE TABLE IF NOT EXISTS lead_assignments (
      order_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  schemaReady = true;
}

const CARD_KEYS = ['mcaffeine', 'hyphen', 'productkyc', 'mom', 'calling', 'onboarding', 'deepdive'];
const CARD_LABELS = {
  mcaffeine: 'mCaffeine', hyphen: 'Hyphen', productkyc: 'Product Calling KYC',
  mom: 'MOM', calling: 'Calling Team', onboarding: 'Onboarding Test', deepdive: 'Deep Dive',
};

async function getUserByEmail(email) {
  await ensureSchema();
  const { rows } = await sql`SELECT id, email, name, is_admin FROM users WHERE email = ${email}`;
  return rows[0] || null;
}

// Deletes the user row outright (not just their permissions) - permissions and
// report_tab_permissions cascade-delete via their FK; audit_log rows are kept
// (user_id set to NULL via ON DELETE SET NULL) so past access history survives.
async function deleteUser(userId) {
  await ensureSchema();
  const { rows } = await sql`DELETE FROM users WHERE id = ${userId} RETURNING email`;
  return rows[0] || null;
}

async function getUserPermissions(userId) {
  await ensureSchema();
  const { rows } = await sql`SELECT card_key FROM permissions WHERE user_id = ${userId}`;
  return rows.map((r) => r.card_key);
}

// Returns { cardKey: [tabKey, ...] } - only for card keys that have an actual
// restriction; a card with no entry here means "no restriction, every tab".
async function getUserTabPermissions(userId) {
  await ensureSchema();
  const { rows } = await sql`SELECT card_key, tab_key FROM report_tab_permissions WHERE user_id = ${userId}`;
  const out = {};
  for (const r of rows) {
    (out[r.card_key] = out[r.card_key] || []).push(r.tab_key);
  }
  return out;
}

// Replaces the full set of allowed tabs for (userId, cardKey) with exactly
// tabKeys - an empty array removes the restriction entirely (full access).
async function setTabPermissions(userId, cardKey, tabKeys) {
  await ensureSchema();
  await sql`DELETE FROM report_tab_permissions WHERE user_id = ${userId} AND card_key = ${cardKey}`;
  for (const tabKey of tabKeys) {
    await sql`INSERT INTO report_tab_permissions (user_id, card_key, tab_key) VALUES (${userId}, ${cardKey}, ${tabKey}) ON CONFLICT DO NOTHING`;
  }
}

// Auto-provisions the very first admin(s) from ADMIN_EMAILS on their first successful
// Google login, since there's no self-serve signup - someone has to be admin #1.
async function bootstrapAdminIfNeeded(email, name) {
  await ensureSchema();
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!adminEmails.includes(email.toLowerCase())) return null;

  const existing = await getUserByEmail(email);
  if (existing) {
    if (!existing.is_admin) {
      await sql`UPDATE users SET is_admin = TRUE WHERE id = ${existing.id}`;
    }
    for (const key of CARD_KEYS) {
      await sql`INSERT INTO permissions (user_id, card_key) VALUES (${existing.id}, ${key}) ON CONFLICT DO NOTHING`;
    }
    return { ...existing, is_admin: true };
  }
  const { rows } = await sql`INSERT INTO users (email, name, is_admin) VALUES (${email}, ${name}, TRUE) RETURNING id, email, name, is_admin`;
  const user = rows[0];
  for (const key of CARD_KEYS) {
    await sql`INSERT INTO permissions (user_id, card_key) VALUES (${user.id}, ${key}) ON CONFLICT DO NOTHING`;
  }
  return user;
}

// action: 'view' | 'login' | 'csv_export' | 'raw_download'. detail is free text (e.g. the
// tab/table that was exported) - null where there's nothing more specific to record.
async function logEvent(userId, email, cardKey, action, detail, ip) {
  await ensureSchema();
  await sql`INSERT INTO audit_log (user_id, email, card_key, action, detail, ip) VALUES (${userId}, ${email}, ${cardKey}, ${action}, ${detail}, ${ip})`;
}

async function logAccess(userId, email, cardKey, ip) {
  return logEvent(userId, email, cardKey, 'view', null, ip);
}

// status: 'Online' | 'Busy' | 'Offline'. email/name always come from the caller's own
// session, never from client-supplied data, so an agent can only ever set their own
// presence - not spoof anyone else's (the gap that made the old Supabase anon-key
// design insecure).
async function upsertAgentPresence(email, name, status) {
  await ensureSchema();
  await sql`
    INSERT INTO agent_presence (email, name, status, updated_at)
    VALUES (${email}, ${name}, ${status}, now())
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
  `;
}

// Returns every agent's last-reported status, keyed by lowercase email - lets the
// roster table (rto-crm.html) show each agent's real Postgres-backed presence
// instead of the mock/local status it falls back to before anyone's ever reported in.
async function getAllAgentPresence() {
  await ensureSchema();
  const { rows } = await sql`SELECT email, name, status, updated_at FROM agent_presence`;
  const out = {};
  for (const r of rows) out[r.email.toLowerCase()] = { status: r.status, updatedAt: r.updated_at };
  return out;
}

// Returns { orderId: assignedAtIso } for assignments newer than sinceHours - the
// reset button only needs "was this assigned recently", so callers keep the payload
// small by asking for a window just past their own grace period, not the whole table.
async function getRecentLeadAssignments(sinceHours) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT order_id, assigned_at FROM lead_assignments
    WHERE assigned_at >= now() - make_interval(hours => ${sinceHours})
  `;
  const out = {};
  for (const r of rows) out[r.order_id] = r.assigned_at;
  return out;
}

module.exports = {
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getRecentLeadAssignments,
};
