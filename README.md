# Customer Query Segment Reports

Static, self-contained HTML reports analysing customer-support tickets by query
class, delivery partner, product and batch — for the **mCaffeine** and **Hyphen**
brands.

## Contents

| File | Description |
|------|-------------|
| `index.html` | Landing page linking to both reports |
| `mcaffeine.html` | mCaffeine customer-query segment report |
| `hyphen.html` | Hyphen customer-query segment report |
| `vercel.json` | Vercel static-hosting config (clean URLs) |

Each report is a single self-contained HTML file (inline CSS/JS, no external
requests) — it can also be opened directly in a browser.

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

## Data & privacy

Reports contain **aggregated segment counts only** — no raw ticket rows,
order numbers, or customer PII. The Google service-account key and the raw
data dumps are excluded via `.gitignore` and are never committed.
