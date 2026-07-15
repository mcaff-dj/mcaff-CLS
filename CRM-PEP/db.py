"""Supabase data access layer. Uses the service-role key (backend-only, never sent to the
browser) so Flask's own @login_required is what gates access - see schema.sql for the
RLS baseline that would apply to any other (non-service-role) client.
"""
from supabase import create_client

import config

LEAD_STATUSES = [
    "new", "attempted", "callback_scheduled",
    "resolved_reattempt", "resolved_cancelled", "unreachable", "closed",
]

CALL_OUTCOMES = [
    "connected_reattempt_confirmed",
    "connected_customer_refused",
    "connected_wrong_address",
    "no_answer",
    "switched_off",
    "invalid_number",
    "already_resolved",
    "other",
]

_client = None


def get_client():
    global _client
    if _client is None:
        url = config.get("SUPABASE_URL", required=True)
        key = config.get("SUPABASE_SERVICE_KEY", required=True)
        _client = create_client(url, key)
    return _client


# -- auth ------------------------------------------------------------------
def sign_in(email, password):
    """Returns the Supabase auth session dict on success, raises on failure."""
    result = get_client().auth.sign_in_with_password({"email": email, "password": password})
    return result


def list_team_members():
    """Admin-listing of Supabase Auth users, for the assignment dropdown."""
    resp = get_client().auth.admin.list_users()
    users = resp if isinstance(resp, list) else getattr(resp, "users", [])
    return sorted(
        [{"id": u.id, "email": u.email} for u in users if u.email],
        key=lambda u: u["email"],
    )


# -- leads -------------------------------------------------------------------
def upsert_leads(leads):
    """leads: list of dicts matching the `leads` table columns. Upserts on (source, awb)."""
    if not leads:
        return
    get_client().table("leads").upsert(leads, on_conflict="source,awb").execute()


def list_leads(source=None, lead_status=None, assigned_to=None, search=None, limit=200):
    query = get_client().table("leads").select("*")
    if source:
        query = query.eq("source", source)
    if lead_status:
        query = query.eq("lead_status", lead_status)
    if assigned_to:
        query = query.eq("assigned_to", assigned_to)
    if search:
        like = f"%{search}%"
        query = query.or_(f"awb.ilike.{like},channel_order_id.ilike.{like},customer_phone.ilike.{like}")
    resp = query.order("created_at", desc=True).limit(limit).execute()
    return resp.data


def get_lead(lead_id):
    resp = get_client().table("leads").select("*").eq("id", lead_id).single().execute()
    return resp.data


def update_lead(lead_id, fields):
    get_client().table("leads").update(fields).eq("id", lead_id).execute()


# -- call logs -----------------------------------------------------------
def add_call_log(lead_id, called_by, call_outcome, notes):
    get_client().table("call_logs").insert({
        "lead_id": lead_id,
        "called_by": called_by,
        "call_outcome": call_outcome,
        "notes": notes,
    }).execute()


def list_call_logs(lead_id):
    resp = (
        get_client().table("call_logs")
        .select("*")
        .eq("lead_id", lead_id)
        .order("called_at", desc=True)
        .execute()
    )
    return resp.data
