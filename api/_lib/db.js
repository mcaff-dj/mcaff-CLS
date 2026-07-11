// Postgres access + schema bootstrap. Works with Vercel Postgres (Neon) out of the box
// via POSTGRES_URL; any standard Postgres connection string works too (e.g. Supabase),
// just set POSTGRES_URL to that connection string in the Vercel project's env vars.
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
  schemaReady = true;
}

const CARD_KEYS = ['mcaffeine', 'hyphen', 'productkyc'];
const CARD_LABELS = { mcaffeine: 'mCaffeine', hyphen: 'Hyphen', productkyc: 'Product Calling KYC' };

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

async function logAccess(userId, email, cardKey, ip) {
  await ensureSchema();
  await sql`INSERT INTO audit_log (user_id, email, card_key, ip) VALUES (${userId}, ${email}, ${cardKey}, ${ip})`;
}

module.exports = { sql, ensureSchema, CARD_KEYS, CARD_LABELS, getUserByEmail, getUserPermissions, bootstrapAdminIfNeeded, logAccess };
