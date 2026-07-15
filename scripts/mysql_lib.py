"""MySQL (mcaff_prod DWH) connection helper. Python counterpart of mysql-lib.ps1's
credential loading: env vars first, then .env.local fallback, NEVER a hardcoded fallback -
DB credentials must never live in a file that could be committed.

Required environment variables (or .env.local entries):
  MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE, MYSQL_PORT (optional, default 3306)

query() returns None (rather than raising) when credentials are unavailable, so callers -
currently only gen_geo_insights.py - can skip their feature gracefully instead of breaking
report generation. This matters because CI may not have the MYSQL_* secrets configured yet.
"""
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
_env_local_loaded = False


def _load_env_local():
    global _env_local_loaded
    if _env_local_loaded:
        return
    _env_local_loaded = True
    env_file = REPO_ROOT / ".env.local"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k not in os.environ:
            os.environ[k] = v.strip()


def get_credential():
    _load_env_local()
    required = ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"]
    if any(not os.environ.get(k) for k in required):
        return None
    return {
        "host": os.environ["MYSQL_HOST"],
        "user": os.environ["MYSQL_USER"],
        "password": os.environ["MYSQL_PASSWORD"],
        "database": os.environ["MYSQL_DATABASE"],
        "port": int(os.environ.get("MYSQL_PORT", "3306")),
    }


def query(sql, params=None):
    """Returns a list of row tuples, or None if MYSQL_* credentials aren't configured.
    Raises on an actual connection/query error - the caller decides whether to swallow it."""
    cred = get_credential()
    if cred is None:
        return None
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=cred["database"], port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(sql, params or ())
        return cur.fetchall()
    finally:
        conn.close()
