"""Self-check for assign_ndr_leads.py's fetch_online_ndr_agents MySQL/Postgres split -
mirrors scripts/test_assign_leads_pg_conn.py's coverage of the same pattern in
assign_leads.py. No real database involved.

agent_presence lives in MySQL PEP_CLS (see docs/superpowers/plans/
2026-08-17-agent-presence-to-mysql.md); calling_agent_process stays on Postgres. The two
halves fail open independently, and these tests pin that: missing MySQL creds yields no
agents at all (the run has no idea who is online), while a missing POSTGRES_URL still
returns the globally-present agents with no per-process filters applied.

Run directly: python scripts/test_assign_ndr_leads.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assign_ndr_leads  # noqa: E402


def test_fetch_online_ndr_agents_fails_open_without_mysql_creds():
    # get_credential is patched rather than the MYSQL_* env vars being popped: popping them
    # does NOT neutralise the credential, because get_credential calls _load_env_local(),
    # which reads .env.local and re-populates any key missing from os.environ (see
    # scripts/mysql_lib.py). On a developer machine that has .env.local the popped vars come
    # straight back and this test opens a REAL prod connection, passing for the wrong reason -
    # it exercises the query-failure path instead of the no-credentials one, since both return
    # the same empty tuple. Patching the function is the only way to actually reach this branch.
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query

    def _must_not_run(sql, params=None, database=None):
        raise AssertionError("query() must not be called when credentials are unavailable")

    assign_ndr_leads.mysql_lib.get_credential = lambda: None
    assign_ndr_leads.mysql_lib.query = _must_not_run
    try:
        result = assign_ndr_leads.fetch_online_ndr_agents()
        assert result == ([], {}, {}, {}, {}, {}), \
            "missing MySQL creds must fail open, not raise"
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


def test_fetch_online_ndr_agents_reads_mysql_not_postgres():
    # POSTGRES_URL is popped too, not just left alone: with it set this would open a real
    # connection to calling_agent_process, making the test environment-dependent and slow.
    # Absent, the function returns global presence with empty filter dicts - which is exactly
    # the half being asserted here (that agent_presence came from mysql_lib, not psycopg).
    old_pg = os.environ.pop("POSTGRES_URL", None)
    calls = []
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }
    assign_ndr_leads.mysql_lib.query = lambda sql, params=None, database=None: (
        calls.append((sql, params, database)) or [("A@x.com",)]
    )
    try:
        present, quotas, attempt_f, reason_f, mode_f, brand_f = \
            assign_ndr_leads.fetch_online_ndr_agents()
        assert present == ["a@x.com"], f"expected lowercased email, got {present!r}"
        assert quotas == {} and attempt_f == {} and reason_f == {} and mode_f == {} \
            and brand_f == {}, "no POSTGRES_URL means no per-process filters"
        assert len(calls) == 1, f"expected exactly one MySQL query, got {len(calls)}"
        assert "agent_presence" in calls[0][0], "the MySQL query must read agent_presence"
        assert calls[0][1][0] == "Online", "status parameter must be 'Online'"
        # The schema must be pinned explicitly, not inherited from MYSQL_DATABASE - see
        # PRESENCE_SCHEMA's comment in assign_ndr_leads.py. Inheriting it reads the wrong
        # schema and fails open to "nobody is online" with no visible error.
        assert calls[0][2] == "PEP_CLS", f"expected database='PEP_CLS', got {calls[0][2]!r}"
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query
        if old_pg is not None:
            os.environ["POSTGRES_URL"] = old_pg


def test_fetch_online_ndr_agents_fails_open_when_mysql_query_raises():
    # A dropped connection / lock timeout on agent_presence must not abort the whole run -
    # same fail-open contract assign_leads.py's fetch_online_agents has for this exact query.
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }

    def _boom(sql, params=None, database=None):
        raise RuntimeError("connection reset")

    assign_ndr_leads.mysql_lib.query = _boom
    try:
        result = assign_ndr_leads.fetch_online_ndr_agents()
        assert result == ([], {}, {}, {}, {}, {}), \
            "an agent_presence query failure must fail open, not raise"
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
