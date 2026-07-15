"""CRM-PEP: internal CRM for calling Shiprocket NDR/RTO leads.

Run: python app.py   (dev server on http://127.0.0.1:5000)
See README.md for Supabase/Shiprocket setup.
"""
from functools import wraps

from flask import Flask, render_template, request, redirect, url_for, session, flash

import config
import db
import sync_leads

app = Flask(__name__)
app.secret_key = config.get("FLASK_SECRET_KEY", required=True)

LEAD_STATUS_LABELS = {
    "new": "New",
    "attempted": "Attempted",
    "callback_scheduled": "Callback scheduled",
    "resolved_reattempt": "Resolved - reattempt",
    "resolved_cancelled": "Resolved - cancelled",
    "unreachable": "Unreachable",
    "closed": "Closed",
}

CALL_OUTCOME_LABELS = {
    "connected_reattempt_confirmed": "Connected - reattempt confirmed",
    "connected_customer_refused": "Connected - customer refused",
    "connected_wrong_address": "Connected - wrong address",
    "no_answer": "No answer",
    "switched_off": "Switched off / not reachable",
    "invalid_number": "Invalid number",
    "already_resolved": "Already resolved/delivered",
    "other": "Other",
}

app.jinja_env.globals.update(
    LEAD_STATUS_LABELS=LEAD_STATUS_LABELS,
    CALL_OUTCOME_LABELS=CALL_OUTCOME_LABELS,
)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        try:
            result = db.sign_in(email, password)
            user = result.user
        except Exception:
            flash("Invalid email or password.", "error")
            return render_template("login.html")
        session["user"] = {"id": user.id, "email": user.email}
        return redirect(request.args.get("next") or url_for("dashboard"))
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def dashboard():
    source = request.args.get("source") or None
    lead_status = request.args.get("lead_status") or None
    assigned_filter = request.args.get("assigned") or "all"
    search = request.args.get("search") or None

    assigned_to = None
    if assigned_filter == "me":
        assigned_to = session["user"]["id"]
    elif assigned_filter not in ("all", "me"):
        assigned_to = assigned_filter

    leads = db.list_leads(source=source, lead_status=lead_status, assigned_to=assigned_to, search=search)
    team = db.list_team_members()
    team_by_id = {m["id"]: m["email"] for m in team}

    return render_template(
        "dashboard.html",
        leads=leads,
        team=team,
        team_by_id=team_by_id,
        filters={"source": source or "", "lead_status": lead_status or "", "assigned": assigned_filter, "search": search or ""},
    )


@app.route("/leads/<lead_id>")
@login_required
def lead_detail(lead_id):
    lead = db.get_lead(lead_id)
    if not lead:
        flash("Lead not found.", "error")
        return redirect(url_for("dashboard"))
    calls = db.list_call_logs(lead_id)
    team = db.list_team_members()
    team_by_id = {m["id"]: m["email"] for m in team}
    return render_template("lead_detail.html", lead=lead, calls=calls, team=team, team_by_id=team_by_id)


@app.route("/leads/<lead_id>/call", methods=["POST"])
@login_required
def log_call(lead_id):
    outcome = request.form.get("call_outcome")
    notes = request.form.get("notes", "").strip()
    new_status = request.form.get("lead_status")

    if outcome not in CALL_OUTCOME_LABELS:
        flash("Please choose a valid call outcome.", "error")
        return redirect(url_for("lead_detail", lead_id=lead_id))

    db.add_call_log(lead_id, session["user"]["id"], outcome, notes)
    if new_status in LEAD_STATUS_LABELS:
        db.update_lead(lead_id, {"lead_status": new_status})
    flash("Call logged.", "success")
    return redirect(url_for("lead_detail", lead_id=lead_id))


@app.route("/leads/<lead_id>/assign", methods=["POST"])
@login_required
def assign_lead(lead_id):
    assignee = request.form.get("assigned_to") or None
    db.update_lead(lead_id, {"assigned_to": assignee})
    flash("Assignment updated.", "success")
    return redirect(url_for("lead_detail", lead_id=lead_id))


@app.route("/sync", methods=["POST"])
@login_required
def trigger_sync():
    try:
        sync_leads.run()
        flash("Sync complete.", "success")
    except Exception as exc:  # noqa: BLE001 - surfaced to the user, not a crash
        flash(f"Sync failed: {exc}", "error")
    return redirect(url_for("dashboard"))


if __name__ == "__main__":
    app.run(debug=True)
