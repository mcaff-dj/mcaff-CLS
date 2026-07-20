"""CRM-PEP: RTO calling tool. Admins assign RTO leads from the "RTO Calling" Google Sheet
to agents; agents call from their own phone and log the outcome, which writes straight
back to the sheet. No Shiprocket, no separate lead database - the sheet is the only
source of truth for leads (see rto_sheet.py).

Run: python app.py   (dev server on http://127.0.0.1:5000)
See README.md for one-time setup (Google OAuth client, service account, env vars).
"""
import secrets
from datetime import datetime
from functools import wraps

from flask import Flask, flash, redirect, render_template, request, session, url_for

import config
import db
import google_auth
import rto_sheet

app = Flask(__name__)
app.secret_key = config.get("FLASK_SECRET_KEY", required=True)

db.init_db()

COMPANY_DOMAIN = config.get("COMPANY_DOMAIN", "mcaffeine.com")
ADMIN_EMAILS = {e.strip().lower() for e in (config.get("ADMIN_EMAILS", "") or "").split(",") if e.strip()}


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user") or not session["user"].get("is_admin"):
            flash("Admin access required.", "error")
            return redirect(url_for("queue"))
        return view(*args, **kwargs)
    return wrapped


def _redirect_uri():
    return url_for("auth_callback", _external=True)


@app.route("/login")
def login():
    if session.get("user"):
        return redirect(url_for("queue"))
    return render_template("login.html", company_domain=COMPANY_DOMAIN)


@app.route("/auth/google")
def auth_google():
    state = secrets.token_urlsafe(16)
    session["oauth_state"] = state
    session["oauth_next"] = request.args.get("next") or url_for("queue")
    return redirect(google_auth.build_auth_url(_redirect_uri(), state))


@app.route("/auth/callback")
def auth_callback():
    if request.args.get("state") != session.pop("oauth_state", None):
        flash("Login failed (state mismatch) - try again.", "error")
        return redirect(url_for("login"))
    code = request.args.get("code")
    if not code:
        flash("Login was cancelled or failed.", "error")
        return redirect(url_for("login"))
    try:
        tokens = google_auth.exchange_code(code, _redirect_uri())
        info = google_auth.verify_id_token(tokens["id_token"])
    except Exception as e:
        flash(f"Login failed: {e}", "error")
        return redirect(url_for("login"))

    email = (info.get("email") or "").lower()
    hd = info.get("hd", "")
    if hd != COMPANY_DOMAIN and not email.endswith("@" + COMPANY_DOMAIN):
        flash(f"Only @{COMPANY_DOMAIN} accounts can access this tool.", "error")
        return redirect(url_for("login"))

    user = db.upsert_user(email, info.get("name") or email, ADMIN_EMAILS)
    session["user"] = {"email": user["email"], "name": user["name"], "is_admin": bool(user["is_admin"])}
    next_url = session.pop("oauth_next", None) or url_for("queue")
    return redirect(next_url)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def queue():
    mode = request.args.get("mode", "pending")
    mine = session["user"]["email"].lower()
    rows = [r for r in rto_sheet.fetch_all_rows() if r["agent_name"].lower() == mine]
    rows = [r for r in rows if (bool(r["calling_date"]) == (mode == "disposed"))]
    return render_template("queue.html", rows=rows, mode=mode)


@app.route("/lead/<int:row_number>")
@login_required
def lead_detail(row_number):
    order_id = request.args.get("order_id", "")
    awb_code = request.args.get("awb_code", "")
    record = next((r for r in rto_sheet.fetch_all_rows() if r["row_number"] == row_number), None)
    if not record or record["order_id"] != order_id or record["awb_code"] != awb_code:
        flash("Lead not found (or the sheet changed) - refresh your list and try again.", "error")
        return redirect(url_for("queue"))
    if not session["user"]["is_admin"] and record["agent_name"].lower() != session["user"]["email"].lower():
        flash("This lead is not assigned to you.", "error")
        return redirect(url_for("queue"))
    return render_template(
        "lead_detail.html", r=record,
        connected_options=rto_sheet.CONNECTED_OPTIONS, status_options=rto_sheet.STATUS_OPTIONS,
    )


@app.route("/lead/<int:row_number>/dispose", methods=["POST"])
@login_required
def dispose_lead(row_number):
    order_id = request.form.get("order_id", "")
    awb_code = request.form.get("awb_code", "")
    connected = request.form.get("connected", "")
    if not connected:
        flash("Connected outcome is required.", "error")
        return redirect(url_for("lead_detail", row_number=row_number, order_id=order_id, awb_code=awb_code))

    if not session["user"]["is_admin"]:
        record = next((r for r in rto_sheet.fetch_all_rows(force_refresh=True) if r["row_number"] == row_number), None)
        if not record or record["agent_name"].lower() != session["user"]["email"].lower():
            flash("This lead is not assigned to you.", "error")
            return redirect(url_for("queue"))

    now = datetime.now()
    calling_date = f"{now.day} {now.strftime('%b')}"  # matches the sheet's existing "1 Jun" style
    fields = {
        "agent_name": session["user"]["email"],
        "connected": connected,
        "status": request.form.get("status", ""),
        "rto_reason_agent": request.form.get("rto_reason_agent", ""),
        "new_product_needed": request.form.get("new_product_needed", ""),
        "new_order_id": request.form.get("new_order_id", ""),
        "change_in_address": request.form.get("change_in_address", ""),
        "new_address": request.form.get("new_address", ""),
        "calling_date": calling_date,
        "remark": request.form.get("remark", ""),
    }
    try:
        rto_sheet.dispose({"row_number": row_number, "order_id": order_id, "awb_code": awb_code}, fields)
        flash("Outcome saved.", "success")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(url_for("queue"))


@app.route("/assign")
@admin_required
def assign_view():
    rows = rto_sheet.fetch_all_rows()
    f = {
        "city": request.args.get("city", "").strip(),
        "assigned": request.args.get("assigned", ""),
        "agent": request.args.get("agent", "").strip(),
        "disposed": request.args.get("disposed", ""),
        "q": request.args.get("q", "").strip(),
    }
    if f["city"]:
        needle = f["city"].lower()
        rows = [r for r in rows if needle in r["city"].lower()]
    if f["assigned"] == "unassigned":
        rows = [r for r in rows if not r["agent_name"]]
    elif f["assigned"] == "agent" and f["agent"]:
        rows = [r for r in rows if r["agent_name"].lower() == f["agent"].lower()]
    if f["disposed"] == "0":
        rows = [r for r in rows if not r["calling_date"]]
    elif f["disposed"] == "1":
        rows = [r for r in rows if r["calling_date"]]
    if f["q"]:
        needle = f["q"].lower()
        rows = [r for r in rows if needle in r["order_id"].lower() or needle in r["awb_code"].lower() or needle in r["cust_mobile"].lower()]

    total = len(rows)
    rows = rows[:200]
    agents = db.list_agents()
    return render_template("assign.html", rows=rows, total=total, shown=len(rows), agents=agents, f=f)


@app.route("/assign", methods=["POST"])
@admin_required
def do_assign():
    agent = request.form.get("agent", "").strip().lower()
    leads = request.form.getlist("lead")  # each "row_number|order_id|awb_code"
    if not agent:
        flash("Choose an agent to assign to.", "error")
        return redirect(url_for("assign_view"))
    items = []
    for lead in leads:
        parts = lead.split("|", 2)
        if len(parts) == 3 and parts[0].isdigit():
            items.append({"row_number": int(parts[0]), "order_id": parts[1], "awb_code": parts[2]})
    if not items:
        flash("No leads selected.", "error")
        return redirect(url_for("assign_view"))

    assigned_count, mismatched = rto_sheet.assign(items, agent)
    msg = f"Assigned {assigned_count} lead(s) to {agent}."
    if mismatched:
        msg += f" {len(mismatched)} lead(s) changed in the sheet and were skipped - refresh and retry those."
    flash(msg, "success" if assigned_count else "error")
    return redirect(url_for("assign_view"))


if __name__ == "__main__":
    app.run(port=int(config.get("PORT", "5000")), debug=True)
