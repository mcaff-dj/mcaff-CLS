"""Google Sign-In for CRM-PEP - a plain Authorization Code flow via requests (no
google-auth-oauthlib dependency), same hand-rolled style as scripts/lib.py and the main
site's api/auth/callback.js. Independent from that Node app's Postgres-backed login:
a separate origin/port can't read its session cookie, so this app does its own OAuth
and keeps its own tiny user table (see db.py).
"""
import requests

import config

AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"


def build_auth_url(redirect_uri, state):
    client_id = config.get("GOOGLE_CLIENT_ID", required=True)
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    req = requests.PreparedRequest()
    req.prepare_url(AUTH_BASE, params)
    return req.url


def exchange_code(code, redirect_uri):
    client_id = config.get("GOOGLE_CLIENT_ID", required=True)
    client_secret = config.get("GOOGLE_CLIENT_SECRET", required=True)
    resp = requests.post(TOKEN_URL, data={
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }, timeout=30)
    resp.raise_for_status()
    return resp.json()


def verify_id_token(id_token):
    resp = requests.get(TOKENINFO_URL, params={"id_token": id_token}, timeout=30)
    resp.raise_for_status()
    info = resp.json()
    client_id = config.get("GOOGLE_CLIENT_ID", required=True)
    if info.get("aud") != client_id:
        raise ValueError("Token audience mismatch")
    if info.get("email_verified") not in ("true", True):
        raise ValueError("Google account email is not verified")
    return info
