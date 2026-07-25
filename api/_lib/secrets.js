// App-level secrets (Google OAuth, session signing, admin bootstrap) - fetched once per
// warm Lambda instance from Secrets Manager and injected into process.env, so every
// existing file that already reads process.env.GOOGLE_CLIENT_ID / SESSION_SECRET /
// ADMIN_EMAILS (session.js, auth/[action].js, db.js) keeps working completely
// unchanged. This still keeps the real values out of the Lambda's own stored
// configuration - process.env here is only populated in-memory, at runtime, by this
// code; it's not the same thing "aws lambda get-function-configuration" would show,
// which only reflects what was explicitly set via the Lambda API (just the DB/reports
// secret names, non-sensitive).
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({});
let loaded = false;

async function ensureAppSecretsLoaded() {
  if (loaded) return;
  const secretName = process.env.APP_SECRET_NAME || 'mcaff-cls/app';
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  Object.assign(process.env, JSON.parse(SecretString));
  loaded = true;
}

module.exports = { ensureAppSecretsLoaded };
