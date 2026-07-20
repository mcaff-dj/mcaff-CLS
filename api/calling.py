"""RTO-Calling: Flask app served by Vercel's Python runtime (see vercel.json's rewrites
for /calling and /calling/:path* -> this file). No login of its own - reuses the main
site's session cookie (see _calling_lib.verify_session). Leads live only in the "RTO
Calling" Google Sheet's Data tab; nothing is persisted anywhere else. Assignment is
auto/pull-based: when an agent's pending queue is empty, calling the queue page claims
the next batch of unassigned leads for them (see _calling_lib.claim_next_batch) - no
admin step, no separate database for round-robin state.
"""
from datetime import datetime

from flask import Flask, redirect, request

import _calling_lib as lib

app = Flask(__name__)

BASE_STYLE = """
<style>
  :root{ --border:#d8dde3; --muted:#6b7280; --accent:#2563eb; --bg-card:#fff; --page:#f4f5f7; --text:#1a1d21; }
  @media (prefers-color-scheme: dark){
    :root{ --border:#33383f; --muted:#9099a3; --bg-card:#1a1d21; --page:#0d0e10; --text:#eef0f2; }
  }
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--page);color:var(--text);}
  .container{max-width:1000px;margin:0 auto;padding:20px;}
  h1{font-size:20px;margin:0 0 4px;} h2{font-size:15px;margin:0 0 12px;}
  .muted{color:var(--muted);font-size:13px;}
  .flash{padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;}
  .flash-error{background:#fee2e2;color:#991b1b;} .flash-success{background:#dcfce7;color:#166534;}
  table{width:100%;border-collapse:collapse;background:var(--bg-card);border-radius:8px;overflow:hidden;font-size:13px;}
  th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;}
  tr.lead-row:hover{background:rgba(37,99,235,.08);cursor:pointer;}
  .card{background:var(--bg-card);padding:16px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-bottom:16px;}
  label{display:block;font-size:11.5px;color:var(--muted);margin-bottom:4px;margin-top:10px;}
  input,select,textarea{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit;background:var(--page);color:var(--text);}
  button{background:var(--accent);color:#fff;border:none;padding:9px 16px;border-radius:6px;font-size:13px;cursor:pointer;margin-top:14px;}
  a.back{color:var(--accent);text-decoration:none;font-size:13px;}
  .tabs{display:flex;gap:8px;margin-bottom:14px;}
  .tabs a{padding:6px 12px;border-radius:999px;border:1px solid var(--border);text-decoration:none;color:var(--muted);font-size:12.5px;}
  .tabs a.active{background:var(--accent);color:#fff;border-color:transparent;}
  dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;font-size:13px;}
  dt{color:var(--muted);}
</style>
"""


def page(title, body, flash_msg=None, flash_kind="error"):
    flash_html = f'<div class="flash flash-{flash_kind}">{flash_msg}</div>' if flash_msg else ""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>{BASE_STYLE}</head>
<body><div class="container">{flash_html}{body}</div></body></html>"""


def denied_page(message):
    return page("Access denied", f"<div class='card'><p>{message}</p></div>"), 403


def esc(s):
    return (str(s or "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def current_session():
    return lib.verify_session(request.cookies.get(lib.COOKIE_NAME))


@app.route("/calling")
def queue():
    session = current_session()
    if not session:
        return redirect("/login.html?next=" + request.path)
    if not lib.has_calling_access(session):
        return denied_page("You don't have access to RTO-Calling. Ask an admin to grant the Calling Team card.")

    mode = request.args.get("mode", "pending")
    email = session["email"].lower()
    rows = [r for r in lib.fetch_all_rows() if r["agent_name"].lower() == email]
    pending = [r for r in rows if not r["calling_date"]]
    disposed = [r for r in rows if r["calling_date"]]

    claimed_note = ""
    if mode != "disposed" and not pending:
        claimed = lib.claim_next_batch(session["email"])
        if claimed:
            rows = [r for r in lib.fetch_all_rows(force_refresh=True) if r["agent_name"].lower() == email]
            pending = [r for r in rows if not r["calling_date"]]
            claimed_note = f"<p class='muted'>Assigned {claimed} new lead(s) to you.</p>"
        else:
            claimed_note = "<p class='muted'>No unassigned leads left in the sheet right now.</p>"

    shown = disposed if mode == "disposed" else pending

    tabs = (
        '<div class="tabs">'
        f'<a href="/calling?mode=pending" class="{"active" if mode != "disposed" else ""}">Pending</a>'
        f'<a href="/calling?mode=disposed" class="{"active" if mode == "disposed" else ""}">Already disposed by me</a>'
        '</div>'
    )

    if shown:
        rows_html = "".join(
            f'<tr class="lead-row" onclick="window.location=\'/calling/lead/{r["row_number"]}'
            f'?order_id={esc(r["order_id"])}&awb_code={esc(r["awb_code"])}\'">'
            f'<td>{esc(r["order_id"])}</td><td>{esc(r["cust_name"])}</td><td>{esc(r["cust_mobile"])}</td>'
            f'<td>{esc(r["city"])}</td><td>{esc(r["rto_reason_original"])}</td><td>{esc(r["courier"])}</td>'
            f'<td>{esc(r["calling_date"])}</td></tr>'
            for r in shown
        )
        table = (
            '<table><thead><tr><th>Order ID</th><th>Customer</th><th>Mobile</th><th>City</th>'
            '<th>RTO Reason</th><th>Courier</th><th>Calling Date</th></tr></thead>'
            f'<tbody>{rows_html}</tbody></table>'
        )
    else:
        table = "<p class='muted'>Nothing here right now.</p>"

    body = (
        f"<h1>RTO-Calling</h1><p class='muted'>{esc(session.get('name') or session['email'])}</p>"
        f"{claimed_note}{tabs}<p class='muted'>{len(shown)} lead(s)</p>{table}"
    )
    return page("My Leads - RTO-Calling", body)


@app.route("/calling/lead/<int:row_number>")
def lead_detail(row_number):
    session = current_session()
    if not session:
        return redirect("/login.html?next=" + request.path)
    if not lib.has_calling_access(session):
        return denied_page("You don't have access to RTO-Calling.")

    order_id = request.args.get("order_id", "")
    awb_code = request.args.get("awb_code", "")
    record = next((r for r in lib.fetch_all_rows() if r["row_number"] == row_number), None)
    if not record or record["order_id"] != order_id or record["awb_code"] != awb_code:
        return page("Not found", "<p>Lead not found (or the sheet changed) - "
                                  "<a class='back' href='/calling'>go back</a> and try again.</p>")
    if record["agent_name"].lower() != session["email"].lower():
        return denied_page("This lead is not assigned to you.")

    disposed_note = (
        f"<div class='flash flash-error'>Already disposed on {esc(record['calling_date'])}. "
        "Submitting again will overwrite the previous outcome.</div>" if record["calling_date"] else ""
    )

    def opts(options, current):
        return '<option value="">Select...</option>' + "".join(
            f'<option value="{esc(o)}" {"selected" if o == current else ""}>{esc(o)}</option>' for o in options
        )

    def yes_no(name, current):
        return (
            f'<select name="{name}"><option value="">Select...</option>'
            f'<option value="Yes" {"selected" if current == "Yes" else ""}>Yes</option>'
            f'<option value="No" {"selected" if current == "No" else ""}>No</option></select>'
        )

    body = f"""
    <a class="back" href="/calling">&larr; Back to My Leads</a>
    <h1>Order {esc(record['order_id'])}</h1>
    <div class="card">
      <h2>Details</h2>
      <dl>
        <dt>Customer</dt><dd>{esc(record['cust_name'])}</dd>
        <dt>Mobile</dt><dd>{esc(record['cust_mobile'])}</dd>
        <dt>Email</dt><dd>{esc(record['cust_email'])}</dd>
        <dt>Address</dt><dd>{esc(record['address'])}, {esc(record['city'])}, {esc(record['state'])} {esc(record['pincode'])}</dd>
        <dt>Payment</dt><dd>{esc(record['payment_method'])} &middot; {esc(record['order_total'])}</dd>
        <dt>AWB</dt><dd>{esc(record['awb_code'])}</dd>
        <dt>Courier</dt><dd>{esc(record['courier'])}</dd>
        <dt>Facility</dt><dd>{esc(record['facility'])}</dd>
        <dt>RTO Reason (courier)</dt><dd>{esc(record['rto_reason_original'])}</dd>
        <dt>RTO Initiated</dt><dd>{esc(record['rto_initiated_date'])}</dd>
        <dt>Latest NDR</dt><dd>{esc(record['latest_ndr_date'])}</dd>
      </dl>
    </div>
    <div class="card">
      <h2>Log call outcome</h2>
      {disposed_note}
      <form method="post" action="/calling/lead/{row_number}/dispose">
        <input type="hidden" name="order_id" value="{esc(order_id)}">
        <input type="hidden" name="awb_code" value="{esc(awb_code)}">
        <label>Connected</label>
        <select name="connected" required>{opts(lib.CONNECTED_OPTIONS, record['connected'])}</select>
        <label>Attempt / Status</label>
        <select name="status">{opts(lib.STATUS_OPTIONS, record['status'])}</select>
        <label>RTO Reason (confirmed)</label>
        <input type="text" name="rto_reason_agent" value="{esc(record['rto_reason_agent'])}">
        <label>New product needed</label>
        {yes_no('new_product_needed', record['new_product_needed'])}
        <label>New Order ID</label>
        <input type="text" name="new_order_id" value="{esc(record['new_order_id'])}">
        <label>Change in address</label>
        {yes_no('change_in_address', record['change_in_address'])}
        <label>New address (if changed) / refund note</label>
        <textarea name="new_address" rows="3">{esc(record['new_address'])}</textarea>
        <label>Remark</label>
        <textarea name="remark" rows="3">{esc(record['remark'])}</textarea>
        <button type="submit">Save outcome</button>
      </form>
    </div>
    """
    return page(f"Order {record['order_id']} - RTO-Calling", body)


@app.route("/calling/lead/<int:row_number>/dispose", methods=["POST"])
def dispose_lead(row_number):
    session = current_session()
    if not session:
        return redirect("/login.html?next=/calling")
    if not lib.has_calling_access(session):
        return denied_page("You don't have access to RTO-Calling.")

    order_id = request.form.get("order_id", "")
    awb_code = request.form.get("awb_code", "")
    connected = request.form.get("connected", "")
    if not connected:
        return page("RTO-Calling", "<p>Connected outcome is required. "
                                    f"<a class='back' href='/calling/lead/{row_number}?order_id={esc(order_id)}&awb_code={esc(awb_code)}'>Go back</a></p>")

    record = next((r for r in lib.fetch_all_rows(force_refresh=True) if r["row_number"] == row_number), None)
    if not record or record["agent_name"].lower() != session["email"].lower():
        return denied_page("This lead is not assigned to you.")

    now = datetime.now()
    calling_date = f"{now.day} {now.strftime('%b')}"  # matches the sheet's existing "1 Jun" style
    fields = {
        "agent_name": session["email"],
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
        lib.dispose({"row_number": row_number, "order_id": order_id, "awb_code": awb_code}, fields)
    except ValueError as e:
        return page("RTO-Calling", f"<div class='flash flash-error'>{esc(str(e))}</div>"
                                    "<a class='back' href='/calling'>Back to My Leads</a>")
    return redirect("/calling")
