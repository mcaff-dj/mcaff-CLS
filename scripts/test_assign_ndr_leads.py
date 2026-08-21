"""Self-check for assign_ndr_leads.py's fetch_online_ndr_agents - both agent_presence and
calling_agent_process now live in MySQL PEP_CLS (see
migrate_calling_business_hours_and_agent_process_to_mysql.py), but still fail open
INDEPENDENTLY: missing MySQL creds yields no agents at all (the run has no idea who is
online), while a calling_agent_process-specific failure still returns the globally-present
agents with no per-process filters applied. No real database involved.

Run directly: python scripts/test_assign_ndr_leads.py
"""
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


def test_fetch_online_ndr_agents_reads_both_tables_from_mysql():
    calls = []
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }

    def _fake_query(sql, params=None, database=None):
        calls.append((sql, params, database))
        if "agent_presence" in sql:
            return [("A@x.com",)]
        # calling_agent_process: email, status, max_quota, attempt_count_filter,
        # ndr_reason_filter, ndr_payment_mode_filter, ndr_brand_filter
        return [("a@x.com", "Online", 5, "1,2", "damaged", "Prepaid", "Hyphen")]

    assign_ndr_leads.mysql_lib.query = _fake_query
    try:
        present, quotas, attempt_f, reason_f, mode_f, brand_f = \
            assign_ndr_leads.fetch_online_ndr_agents()
        assert present == ["a@x.com"], f"expected lowercased email, got {present!r}"
        assert quotas == {"a@x.com": 5}
        assert attempt_f == {"a@x.com": ["1", "2"]}
        assert reason_f == {"a@x.com": ["damaged"]}
        assert mode_f == {"a@x.com": "Prepaid"}
        assert brand_f == {"a@x.com": "Hyphen"}
        assert len(calls) == 2, f"expected exactly two MySQL queries, got {len(calls)}"
        assert "agent_presence" in calls[0][0], "the first query must read agent_presence"
        assert calls[0][1][0] == "Online", "status parameter must be 'Online'"
        assert "calling_agent_process" in calls[1][0], "the second query must read calling_agent_process"
        # The schema must be pinned explicitly, not inherited from MYSQL_DATABASE - see
        # PRESENCE_SCHEMA's comment in assign_ndr_leads.py. Inheriting it reads the wrong
        # schema and fails open to "nobody is online" with no visible error.
        assert calls[0][2] == "PEP_CLS", f"expected database='PEP_CLS', got {calls[0][2]!r}"
        assert calls[1][2] == "PEP_CLS", f"expected database='PEP_CLS', got {calls[1][2]!r}"
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


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
