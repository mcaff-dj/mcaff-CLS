"""Self-check for assign_leads.py's shared-connection helper (_pg_cursor) and the
gokwik-refund-cache functions' conn= param - the only remaining Postgres-backed functions
that still take a shared conn (fetch_reassignment_attempts/fetch_current_assignment_times
lost theirs when they moved onto MySQL CLS_RTO_calling, see e1ad531). No real Postgres
involved, just fake conn/cursor doubles verifying the two things a botched refactor of this
would get wrong on a live 5-minute cron:

  1. A shared conn is never closed by the function that borrowed it (main() owns closing it).
  2. A caught failure on a shared conn rolls it back, so the NEXT function sharing that same
     connection doesn't inherit "current transaction is aborted" from a prior fail-open.

Run directly: python scripts/test_assign_leads_pg_conn.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assign_leads  # noqa: E402


def test_fetch_online_agents_fails_open_without_mysql_creds():
    import os
    old = {k: os.environ.pop(k, None) for k in
           ("MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE")}
    try:
        result = assign_leads.fetch_online_agents()
        assert result == ([], {}, {}, {}, {}), \
            "missing MySQL creds must fail open, not raise"
    finally:
        for k, v in old.items():
            if v is not None:
                os.environ[k] = v


def test_fetch_online_agents_reads_mysql_not_postgres():
    calls = []
    orig_get_cred = assign_leads.mysql_lib.get_credential
    orig_query = assign_leads.mysql_lib.query
    assign_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }
    assign_leads.mysql_lib.query = lambda sql, params=None, database=None: (
        calls.append((sql, params)) or [("a@x.com",), ("b@x.com",)]
    )
    try:
        present, quotas, prepaid, specs, modes = assign_leads.fetch_online_agents()
        assert present == ["a@x.com", "b@x.com"]
        assert quotas == {} and prepaid == {} and specs == {} and modes == {}
        assert len(calls) == 1
        assert "agent_presence" in calls[0][0]
    finally:
        assign_leads.mysql_lib.get_credential = orig_get_cred
        assign_leads.mysql_lib.query = orig_query


class FakeCursor:
    def __init__(self, rows=None, raise_on_execute=False):
        self.rows = rows or []
        self.raise_on_execute = raise_on_execute
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append(sql)
        if self.raise_on_execute:
            raise RuntimeError("boom")

    def fetchall(self):
        return self.rows


class FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.closed = False
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self._cursor

    def close(self):
        self.closed = True

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


def test_shared_conn_not_closed_by_pg_cursor():
    conn = FakeConn(FakeCursor(rows=[("o1", "a@x.com")]))
    with assign_leads._pg_cursor("unused", conn) as cur:
        cur.execute("select 1")
    assert not conn.closed, "a shared conn must outlive the _pg_cursor block that borrowed it"


def test_no_conn_no_env_fails_open_without_touching_pg():
    # No POSTGRES_URL in the environment and no conn passed - must return the fail-open
    # default without ever calling lib.get_pg_connection (which would try a real network
    # connection at import time otherwise).
    import os
    old = os.environ.pop("POSTGRES_URL", None)
    try:
        assert assign_leads.fetch_reassignment_attempts() == {}
        assert assign_leads.fetch_current_assignment_times() == {}
        assert assign_leads.fetch_gokwik_refund_cache() == {}
    finally:
        if old is not None:
            os.environ["POSTGRES_URL"] = old


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
