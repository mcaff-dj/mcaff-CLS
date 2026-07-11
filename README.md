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
   `Vikash-P/mcaff-CLS` GitHub repo.
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
admin at `/admin.html`) — they are no longer public static files. Required Vercel
project environment variables:

| Variable | Purpose |
|----------|---------|
| `POSTGRES_URL` | Postgres connection string (Vercel Postgres/Neon or any standard Postgres provider) — stores users, permissions, audit log |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Client ID credentials (Google Cloud Console → Credentials), redirect URI `https://<your-domain>/api/auth/callback` |
| `SESSION_SECRET` | Random string (e.g. `openssl rand -hex 32`) used to sign session cookies |
| `ADMIN_EMAILS` | Comma-separated emails auto-promoted to admin (with access to every report) on first login — bootstraps the first admin(s) since there's no self-serve signup |

## Data & privacy

Reports contain **aggregated segment counts only** — no raw ticket rows,
order numbers, or customer PII. The Google service-account key and the raw
data dumps are excluded via `.gitignore` and are never committed.
