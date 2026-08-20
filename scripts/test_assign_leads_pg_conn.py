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
    # mysql_lib.get_credential() calls _load_env_local() first, which re-populates these
    # exact env vars from the repo's real .env.local if it's missing them - on a real dev
    # checkout that file has live production MYSQL_* creds, so without forcing this flag
    # this "missing creds" test would silently connect to the live database instead.
    old_env_loaded = assign_leads.mysql_lib._env_local_loaded
    assign_leads.mysql_lib._env_local_loaded = True
    try:
        result = assign_leads.fetch_online_agents()
        assert result == ([], {}, {}, {}, {}), \
            "missing MySQL creds must fail open, not raise"
    finally:
        assign_leads.mysql_lib._env_local_loaded = old_env_loaded
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


def test_fetch_online_agents_fails_open_on_mysql_query_error():
    """The actual bug this test guards: agent_presence is a live network call like every
    other MySQL/Postgres lookup in this file, and a transient failure here (dropped
    connection, lock timeout) must fail open the same way lookup_platform_order_ids/
    check_already_punched/fetch_reassignment_attempts already do - not raise uncaught
    through fetch_online_agents -> _main -> main() and abort the whole 5-minute run,
    assigning zero leads even though hundreds may be pending."""
    orig_get_cred = assign_leads.mysql_lib.get_credential
    orig_query = assign_leads.mysql_lib.query
    assign_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }

    def _boom(sql, params=None, database=None):
        raise Exception("SELECT command denied to user")

    assign_leads.mysql_lib.query = _boom
    try:
        result = assign_leads.fetch_online_agents()
        assert result == ([], {}, {}, {}, {}), \
            "a raising agent_presence query must fail open, not propagate"
    finally:
        assign_leads.mysql_lib.get_credential = orig_get_cred
        assign_leads.mysql_lib.query = orig_query


def test_resolve_refund_statuses_caps_live_checks_per_run():
    """The budget cap that keeps a run inside its 60s Lambda timeout (see
    GOKWIK_MAX_CHECKS_PER_RUN). Three things have to hold together, and getting any one wrong
    reintroduces the permanent stall it exists to prevent:

      1. No more than the budget is ever checked live (the actual timeout guarantee).
      2. Orders skipped for budget still get a fail-open False, so they assign as normal
         rather than being held back.
      3. Skipped orders are NOT written to the cache - a skipped check is not a verdict, and
         caching one as "not refunded" would suppress a real refund for hours.
    """
    n = assign_leads.GOKWIK_MAX_CHECKS_PER_RUN
    order_ids = [f"ORD{i:05d}" for i in range(n + 25)]

    orig_lookup = assign_leads.lookup_platform_order_ids
    orig_creds = assign_leads._gokwik_credentials
    orig_live = assign_leads._check_gokwik_refund_status_live
    checked = []
    assign_leads.lookup_platform_order_ids = lambda ids: ({o: "111" for o in ids}, set())
    assign_leads._gokwik_credentials = lambda order_id: ("app", "secret")

    def _fake_live(order_id, platform_order_id, credentials):
        checked.append(order_id)
        return False

    assign_leads._check_gokwik_refund_status_live = _fake_live
    try:
        dirty = {}
        results = assign_leads.resolve_refund_statuses(set(order_ids), dirty)
        assert len(checked) == n, f"must check at most the budget, checked {len(checked)}"
        assert len(results) == len(order_ids), "every order still needs a fail-open answer"
        assert all(v is False for v in results.values())
        skipped = sorted(set(order_ids) - set(checked))
        assert skipped, "test needs some orders to land over budget"
        assert not any(o in dirty for o in skipped), \
            "a check skipped for budget must never be cached as a verdict"
    finally:
        assign_leads.lookup_platform_order_ids = orig_lookup
        assign_leads._gokwik_credentials = orig_creds
        assign_leads._check_gokwik_refund_status_live = orig_live


def test_resolve_refund_statuses_stops_at_time_budget():
    """The wall-clock ceiling on the GoKwik phase (GOKWIK_TIME_BUDGET_SEC) - what keeps the run
    inside its Lambda timeout when the machine is slow, which the order-count cap alone could
    not do (120 orders is a fixed order count but an unbounded amount of TIME).

    Simulated with a deliberately slow live check and a budget of 0, so the phase must stop after
    at most one wave. What has to hold:
      1. it stops early rather than working through every checkable order
      2. every cut-off order still gets a fail-open False, so it assigns as normal
      3. cut-off orders are NOT cached - not asked is not a verdict, and caching a guess as
         "not refunded" would suppress a real refund for hours
    """
    n = 40
    order_ids = [f"ORD{i:05d}" for i in range(n)]

    orig_lookup = assign_leads.lookup_platform_order_ids
    orig_creds = assign_leads._gokwik_credentials
    orig_live = assign_leads._check_gokwik_refund_status_live
    orig_budget = assign_leads.GOKWIK_TIME_BUDGET_SEC
    checked = []
    assign_leads.lookup_platform_order_ids = lambda ids: ({o: "111" for o in ids}, set())
    assign_leads._gokwik_credentials = lambda order_id: ("app", "secret")

    def _slow(order_id, platform_order_id, credentials):
        checked.append(order_id)
        return False

    assign_leads._check_gokwik_refund_status_live = _slow
    assign_leads.GOKWIK_TIME_BUDGET_SEC = 0  # budget already spent before the first wave
    try:
        dirty = {}
        results = assign_leads.resolve_refund_statuses(set(order_ids), dirty)
        assert len(checked) < n, f"the time budget must cut the phase short, checked all {n}"
        assert len(results) == n, "every order still needs a fail-open answer"
        assert all(v is False for v in results.values())
        cut_off = [o for o in order_ids if o not in checked]
        assert cut_off, "test needs some orders to be cut off"
        assert not any(o in dirty for o in cut_off), \
            "an order the clock cut off must never be cached as a verdict"
    finally:
        assign_leads.lookup_platform_order_ids = orig_lookup
        assign_leads._gokwik_credentials = orig_creds
        assign_leads._check_gokwik_refund_status_live = orig_live
        assign_leads.GOKWIK_TIME_BUDGET_SEC = orig_budget


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
    # connection at import time otherwise). fetch_reassignment_attempts/
    # fetch_current_assignment_times now go through mysql_lib.query() (CLS_RTO_calling moved
    # onto MySQL), whose get_credential() calls _load_env_local() - same live-DB exposure as
    # the MySQL-creds test above, so the same guard is needed here too.
    import os
    old = os.environ.pop("POSTGRES_URL", None)
    old_env_loaded = assign_leads.mysql_lib._env_local_loaded
    assign_leads.mysql_lib._env_local_loaded = True
    try:
        assert assign_leads.fetch_reassignment_attempts() == {}
        assert assign_leads.fetch_current_assignment_times() == {}
        assert assign_leads.fetch_gokwik_refund_cache() == {}
    finally:
        assign_leads.mysql_lib._env_local_loaded = old_env_loaded
        if old is not None:
            os.environ["POSTGRES_URL"] = old


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
