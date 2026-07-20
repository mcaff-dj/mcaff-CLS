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
  schemaReady = true;
}

const CARD_KEYS = ['mcaffeine', 'hyphen', 'productkyc', 'mom'];
const CARD_LABELS = {
  mcaffeine: 'mCaffeine', hyphen: 'Hyphen', productkyc: 'Product Calling KYC',
  mom: 'MOM',
};

async function getUserByEmail(email) {
  await ensureSchema();
  const { rows } = await sql`SELECT id, email, name, is_admin FROM users WHERE email = ${email}`;
  return rows[0] || null;
}

async function getUserPermissions(userId) {
  await ensureSchema();
  const { rows } = await sql`SELECT card_key FROM permissions WHERE user_id = ${userId}`;
  return rows.map((r) => r.card_key);
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

module.exports = { sql, ensureSchema, CARD_KEYS, CARD_LABELS, getUserByEmail, getUserPermissions, bootstrapAdminIfNeeded, logAccess, logEvent };
