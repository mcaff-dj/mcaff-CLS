"""Self-check for assign_ndr_leads.py's fetch_online_ndr_agents MySQL/Postgres split -
mirrors scripts/test_assign_leads_pg_conn.py's coverage of the same pattern in
assign_leads.py. No real database involved.

Run directly: python scripts/test_assign_ndr_leads.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assign_ndr_leads  # noqa: E402


def test_fetch_online_ndr_agents_fails_open_without_mysql_creds():
    import os
    old = {k: os.environ.pop(k, None) for k in
           ("MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE")}
    try:
        result = assign_ndr_leads.fetch_online_ndr_agents()
        assert result == ([], {}, {}, {}, {}, {}), \
            "missing MySQL creds must fail open, not raise"
    finally:
        for k, v in old.items():
            if v is not None:
                os.environ[k] = v


def test_fetch_online_ndr_agents_reads_mysql_not_postgres():
    calls = []
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }
    assign_ndr_leads.mysql_lib.query = lambda sql, params=None, database=None: (
        calls.append((sql, params)) or [("a@x.com",)]
    )
    try:
        present, quotas, attempt_f, reason_f, mode_f, brand_f = assign_ndr_leads.fetch_online_ndr_agents()
        assert present == ["a@x.com"]
        assert quotas == {} and attempt_f == {} and reason_f == {} and mode_f == {} and brand_f == {}
        assert len(calls) == 1
        assert "agent_presence" in calls[0][0]
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
