# Customer Query Segment Reports

Static, self-contained HTML reports analysing customer-support tickets by query
class, delivery partner, product and batch — for the **mCaffeine** and **Hyphen**
brands.

## Contents

| File | Description |
|------|-------------|
| `index.html` | Landing page — shows only the reports the signed-in user has been granted |
| `login.html` | Google sign-in page |
| `admin.html` | Admin-only: invite users, grant/revoke per-report access, view audit log |
| `api/_reports/*.html` | The actual generated reports (mCaffeine, Hyphen, Product Calling KYC) — not publicly servable, only readable by `api/report/[card].js` after an auth + permission check |
| `vercel.json` | Vercel static-hosting config (clean URLs, function file bundling) |

Each report is a single self-contained HTML file (inline CSS/JS, no external
requests).

## Deploy on Vercel

This is a zero-build static site, so no framework or build step is needed.

**Option A — Vercel dashboard (recommended)**
1. Go to [vercel.com/new](https://vercel.com/new) and import the
   `mcaff-dj/mcaff-CLS` GitHub repo.
2. Framework Preset: **Other**. Build Command: *(leave empty)*.
   Output Directory: *(leave as root / empty)*.
3. Click **Deploy**. The landing page is served at `/`, and the reports at
   `/mcaffeine` and `/hyphen` (clean URLs).

**Option B — Vercel CLI**
```bash
npm i -g vercel
vercel        # preview deploy
vercel --prod # production deploy
```

## Access control

Reports require Google sign-in and per-user, per-report permission (granted by an
admin at `/admin.html`) — they are no longer public static files. Required environment
variables on the API Lambda:

| Variable | Purpose |
|----------|---------|
| `POSTGRES_URL` | Postgres connection string (Supabase or any standard Postgres provider) — RTO CRM agent presence/lead assignments; MySQL handles users, permissions, audit log |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Client ID credentials (Google Cloud Console → Credentials), redirect URI `https://<your-domain>/api/auth/callback` |
| `SESSION_SECRET` | Random string (e.g. `openssl rand -hex 32`) used to sign session cookies |
| `ADMIN_EMAILS` | Comma-separated emails auto-promoted to admin (with access to every report) on first login — bootstraps the first admin(s) since there's no self-serve signup |
| `RESEND_API_KEY` | [Resend](https://resend.com) API key — sends the "you've been invited / your access changed" email when an admin invites/updates a user at `/admin.html`. Optional: invites still work without it, just silently skip the email. |
| `FROM_EMAIL` | Optional sender address for invite emails (defaults to Resend's shared `onboarding@resend.dev` sandbox sender). Set this to an address on a domain you've verified in Resend for better deliverability. |
| `ESCALATION_SHEETS_CLIENT_EMAIL` / `ESCALATION_SHEETS_PRIVATE_KEY` | Optional override for the Escalation desk's Google Sheet (`api/_lib/escalationSheet.js`) — falls back to `GOOGLE_SHEETS_CLIENT_EMAIL`/`_PRIVATE_KEY` (same as NDR/RTO) when unset, verified to already have access on that spreadsheet too. Only set these if the escalation sheet ever needs a dedicated service account of its own. |

## Data & privacy

Reports contain **aggregated segment counts only** — no raw ticket rows,
order numbers, or customer PII. The Google service-account key and the raw
data dumps are excluded via `.gitignore` and are never committed.
