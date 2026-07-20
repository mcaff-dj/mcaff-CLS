# CRM-PEP - RTO Calling Tool

Internal tool for the team to call up RTO (return-to-origin) leads from the **"RTO
Calling"** Google Sheet and log outcomes. Pure Python (Flask), no JavaScript build step,
no separate lead database - the sheet stays the only source of truth; this app reads and
writes it live.

## How it works

1. Admins open **Assign Leads**, filter the sheet's `Data` tab (by city, unassigned-only,
   search), select rows, and assign them to an agent - this writes that agent's email into
   the sheet's `Agent Name` column.
2. Agents open **My Leads** to see the leads assigned to them that haven't been called yet.
3. Calling itself is manual: the agent sees the customer's phone number, dials from their
   own phone, then logs the outcome (Connected / Attempt status / RTO reason / etc.) on
   the lead's page - this writes straight back to the same sheet row.

Because neither the sheet's `Key` column (it's a loyalty tier, not a unique ID) nor Order
ID/AWB Code alone are reliably unique, writes are addressed by the sheet row number
captured at read time, double-checked against a fresh read of that row's Order ID + AWB
Code immediately before writing (see `rto_sheet.py`'s `verify_rows()`) - if the sheet
changed underneath (someone sorted it, edited it directly, etc.) the write is refused
instead of risking the wrong row.

## One-time setup

### 1. Google OAuth client
This app needs its own login separate from the main mcaff-CLS site (different
origin/port, so it can't read that site's session cookie). In
[Google Cloud Console](https://console.cloud.google.com/) → APIs & Services →
Credentials, either reuse mcaff-CLS's existing OAuth client (add the redirect URI below
to it) or create a new one, then add as an **Authorized redirect URI**:
```
http://127.0.0.1:5000/auth/callback
```
(add the production URL too, once this is hosted somewhere).

### 2. Service-account sheet access
The Google service account already used for reports (see `scripts/lib.py`) needs
**Editor** access on the RTO Calling sheet (not just Viewer) - the reports only ever read;
this app writes assignments and dispositions back. Share the sheet with the service
account's email (`client_email` in its key JSON) as an Editor.

### 3. Local config
```
cd CRM-PEP
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env.local
```
Fill in `.env.local` - see the comments in `.env.example` for each variable
(`FLASK_SECRET_KEY`, `GOOGLE_CLIENT_ID`/`SECRET`, `ADMIN_EMAILS`, `RTO_SHEET_ID`, and the
service-account credential, which defaults to whatever `scripts/lib.py` already uses if
left blank here).

### 4. Run it
```
python app.py
```
Visit http://127.0.0.1:5000 and sign in with a `@mcaffeine.com` Google account. Anyone on
the domain can sign in and use **My Leads**; only emails listed in `ADMIN_EMAILS` see
**Assign Leads**.

## Notes / things to revisit

- **Access model**: any `@mcaffeine.com` Google account can log in (gated on the
  `hd`/domain claim, not a per-user invite list). `ADMIN_EMAILS` is the only thing gating
  the Assign view. Tighten this later with a proper allowlist if that's ever a problem.
- **Deployment**: this currently only runs locally (`python app.py`). The main site's
  `index.html` (Calling Vertical → RTO) is wired to load it at whatever `CALLING_APP_URL`/
  RTO URL is configured there - update that once this is hosted somewhere reachable by
  the whole team, and ask before standing up new hosting since that's shared
  infrastructure.
- **`crm_pep.db`** (SQLite, created automatically on first run) holds only this app's own
  user list (email, name, is_admin) - never lead data.
