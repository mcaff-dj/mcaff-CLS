# CRM-PEP

Internal CRM for the team to call up Shiprocket **NDR** (failed delivery attempts) and
**RTO** (return-to-origin) leads and log call outcomes. Pure Python backend (Flask) +
Supabase (Postgres + Auth) for storage, no JavaScript build step.

## How it works

1. `sync_leads.py` calls the Shiprocket API, pulls NDR shipments and RTO-status orders,
   and upserts them into a `leads` table in Supabase (dedup key: `source` + `awb`).
2. `app.py` is a small Flask app the team logs into (Supabase Auth) to see the lead list,
   filter/search, assign leads to teammates, and log calls (outcome + notes) against a lead.
3. Calling itself is manual: the app shows the customer's phone number, your team dials
   from their own phone, then records the outcome in the CRM.

## One-time setup

### 1. Supabase project
1. Create a project at [supabase.com](https://supabase.com) (or reuse an existing org project).
2. Open **SQL Editor** and run [`schema.sql`](schema.sql) once - creates `leads`, `call_logs`, and RLS policies.
3. Under **Authentication > Users**, add one user per team member (email + password) -
   these are the CRM logins. No public sign-up is exposed.
4. Under **Project Settings > API**, copy the Project URL and the **service_role** key
   (not the anon key - the Flask backend needs it to read/write leads and list users).

### 2. Shiprocket API user
1. In the Shiprocket dashboard: **Settings > API > Create API User** (a dedicated API
   login, not your regular Shiprocket login - keeps this integration's access auditable
   and revocable on its own).
2. Note the email/password you set for that API user.

### 3. Local config
```
cd CRM-PEP
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env.local
```
Edit `.env.local` with your Supabase URL/service key, Shiprocket API user credentials,
and a random `FLASK_SECRET_KEY`. `.env.local` is already covered by the repo's `.gitignore`
(`.env.*`) - it will never be committed.

### 4. First sync (verify field mapping)
Shiprocket's public docs don't publish a full response schema for the NDR/orders
endpoints, so `shiprocket_client.py` tries several likely field names per value and
keeps the **entire raw record** in `raw_data` regardless. Before relying on the UI, run:
```
python sync_leads.py --dry-run
```
This prints one sample NDR record and one sample RTO-filtered order record without
writing anything. Compare the printed JSON against what's shown in the app (customer
name/phone/address columns) - if a column comes back empty but the raw JSON clearly has
the value under a different key, add that key to the relevant `_pick(...)` call in
`shiprocket_client.py`.

Once it looks right:
```
python sync_leads.py
```

### 5. Run the app
```
python app.py
```
Visit http://127.0.0.1:5000 and log in with one of the Supabase Auth users you created.

## Keeping leads fresh

`sync_leads.py` is a plain script - schedule it (Windows Task Scheduler, or a cron job
wherever this ends up hosted) to run every 30-60 minutes, or click **Sync now** on the
dashboard to run it on demand. `--lookback-days N` controls how far back the RTO order
scan looks (default 30).

## Lead & call statuses

- **Lead status**: new -> attempted -> callback_scheduled / resolved_reattempt /
  resolved_cancelled / unreachable -> closed.
- **Call outcome**: connected (reattempt confirmed / customer refused / wrong address),
  no answer, switched off, invalid number, already resolved, other.

Both are plain Python dicts in `app.py` (`LEAD_STATUS_LABELS`, `CALL_OUTCOME_LABELS`) -
edit those plus the corresponding `check (...)` constraint in `schema.sql` to add options.

## Notes / things to revisit

- **RTO detection** is a case-insensitive `"rto" in status` match on the orders list,
  since Shiprocket doesn't document a dedicated RTO endpoint or a confirmed filter
  param value for it. If that ever over/under-matches, tighten it in
  `ShiprocketClient.get_rto_leads`.
- **Deployment**: this currently only runs locally (`python app.py`). If the team needs
  it reachable outside your machine, it'll need hosting (e.g. a small VM, Render, or
  similar) - ask before setting that up since it's a new piece of shared infrastructure.
