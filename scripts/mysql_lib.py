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


_conn = None
_current_db = None


def _get_connection(cred):
    """One TLS connection reused for the lifetime of this process, not reopened per call.
    Profiling generate_report.py found each query() call was paying a fresh connect+TLS
    handshake to the RDS instance on its own - ~10-15s from this codebase's usual network
    path - which went unnoticed while kyc_source's one settled-rows call was the only caller,
    but became the dominant cost once nps_source (2 more calls) and gen_geo_insights (its own
    calls) started stacking up in the same run. ping(reconnect=True) transparently reconnects
    if the server ever drops an idle connection between calls - callers still see any actual
    query error raised, same contract as before."""
    global _conn, _current_db
    if _conn is None:
        import pymysql
        _conn = pymysql.connect(
            host=cred["host"], user=cred["user"], password=cred["password"],
            database=cred["database"], port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
            # autocommit=True: this connection is reused for the process's lifetime (a warm
            # Lambda container can span many invocations). Without it, pymysql leaves autocommit
            # off, so query()'s SELECT-only callers (which never commit) sit inside one
            # never-closed REPEATABLE READ transaction and keep seeing the snapshot from
            # whenever that transaction first opened - any row committed by another connection
            # afterward (e.g. agent_presence heartbeats) stays invisible until this connection
            # happens to recycle. Caught via assign_ndr_leads.py reporting an online, heartbeat-
            # fresh agent as stale on every invocation while an ad-hoc connection saw her fine.
            autocommit=True,
            # connect_timeout alone only bounds the TCP/TLS handshake - once connected, a
            # blocked query waits forever. A refresh run hung for 1h28m inside
            # gen_geo_insights' order-count query before being cancelled by hand; the whole
            # job otherwise finishes in 3-6 min. These bound the wait for a server reply so
            # such a query raises instead of stalling the run.
            #
            # 180s, not something tighter: the slowest LEGITIMATE query here is kyc_source's
            # settled-rows scan, measured at 80.3s for CLS_KYC_mCaff on a cold buffer pool
            # (20.9s typical), and gen_geo_insights' per-month order counts run 20-35s. A
            # 60s ceiling would kill both. This is a hang backstop, not a latency budget.
            read_timeout=180, write_timeout=180,
        )
        _current_db = cred["database"]
    else:
        _conn.ping(reconnect=True)
    return _conn


def query(sql, params=None, database=None):
    """Returns a list of row tuples, or None if MYSQL_* credentials aren't configured.
    Raises on an actual connection/query error - the caller decides whether to swallow it.
    database overrides cred["database"] - some tables (e.g. the CSAT/ticket tables) live
    in a different schema (mcaff_dwh) on the same server than MYSQL_DATABASE points at. Callers
    passing different `database` values share the one connection above - select_db() just
    switches schema on it, no new connection.
    _current_db (not conn.db) tracks the active schema - pymysql's select_db() sends
    COM_INIT_DB but never updates conn.db, which stays frozen at the connect-time value
    forever. Comparing against conn.db meant a later query() targeting the connect-time
    database name looked like a no-op switch and silently ran against whatever schema the
    previous call had left the connection on."""
    global _current_db
    cred = get_credential()
    if cred is None:
        return None
    conn = _get_connection(cred)
    target_db = database or cred["database"]
    if _current_db != target_db:
        conn.select_db(target_db)
        _current_db = target_db
    cur = conn.cursor()
    cur.execute(sql, params or ())
    return cur.fetchall()


def execute(sql, params=None, database=None):
    """INSERT/UPDATE/DDL counterpart to query() - same shared connection and None-if-no-creds
    contract, but commits (query() never does, since every existing caller only SELECTs)."""
    global _current_db
    cred = get_credential()
    if cred is None:
        return None
    conn = _get_connection(cred)
    target_db = database or cred["database"]
    if _current_db != target_db:
        conn.select_db(target_db)
        _current_db = target_db
    cur = conn.cursor()
    cur.execute(sql, params or ())
    conn.commit()
    return cur.rowcount


def executemany(sql, seq_of_params, database=None):
    """Bulk counterpart to execute() - pymysql special-cases a plain 'INSERT ... VALUES (...)'
    statement (ON DUPLICATE KEY UPDATE clause included) into one multi-row INSERT instead of
    one round-trip per row, which is what makes a many-thousand-row backfill practical."""
    global _current_db
    cred = get_credential()
    if cred is None:
        return None
    conn = _get_connection(cred)
    target_db = database or cred["database"]
    if _current_db != target_db:
        conn.select_db(target_db)
        _current_db = target_db
    cur = conn.cursor()
    cur.executemany(sql, seq_of_params)
    conn.commit()
    return cur.rowcount
