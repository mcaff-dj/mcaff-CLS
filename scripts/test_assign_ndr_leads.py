"""Self-check for assign_ndr_leads.py's fetch_online_ndr_agents - both agent_presence and
calling_agent_process now live in MySQL PEP_CLS (see
migrate_calling_business_hours_and_agent_process_to_mysql.py), but still fail open
INDEPENDENTLY: missing MySQL creds yields no agents at all (the run has no idea who is
online), while a calling_agent_process-specific failure still returns the globally-present
agents with no per-process filters applied.

Also covers record_new_assignments: the schema it connects to, batch dedup, per-row recovery
from a live_awb_number collision, and reporting (rather than swallowing) a hard write failure.

No real database involved.

Run directly: python scripts/test_assign_ndr_leads.py
"""
import sys
from pathlib import Path

import pymysql as real_pymysql

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


class _FakeCursor:
    """Records every statement. Raises IntegrityError on the live-AWB key for any AWB listed in
    collide, and a plain RuntimeError for any AWB in explode."""

    def __init__(self, collide=(), explode=()):
        self.statements = []  # (sql, params)
        self.collide = set(collide)
        self.explode = set(explode)

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        if "INSERT" in sql and params[0] in self.explode:
            raise RuntimeError("some other failure")
        if "INSERT" in sql and params[0] in self.collide:
            raise real_pymysql.err.IntegrityError(
                1062, "Duplicate entry 'X' for key 'ndr_lead_assignments_live_awb_key'")

    def executemany(self, sql, seq):
        self.statements.append((sql, list(seq)))


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class _FakePymysql:
    """Stands in for the module, keeping the REAL exception classes so the production code's
    `except pymysql.err.IntegrityError` clause still matches what _FakeCursor raises."""

    err = None  # set below to real_pymysql.err

    def __init__(self, cursor, connect_error=None):
        self._cursor = cursor
        self._connect_error = connect_error
        self.connect_kwargs = None
        self.conn = None

    def connect(self, **kwargs):
        self.connect_kwargs = kwargs
        if self._connect_error is not None:
            raise self._connect_error
        self.conn = _FakeConn(self._cursor)
        return self.conn


def _run_record(new_assignments, collide=(), explode=(), connect_error=None):
    cursor = _FakeCursor(collide=collide, explode=explode)
    fake = _FakePymysql(cursor, connect_error=connect_error)
    fake.err = real_pymysql.err
    orig_pymysql = assign_ndr_leads.pymysql
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    assign_ndr_leads.pymysql = fake
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "mcaff_prod", "port": 3306,
    }
    try:
        ok = assign_ndr_leads.record_new_assignments(new_assignments)
    finally:
        assign_ndr_leads.pymysql = orig_pymysql
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
    return ok, cursor, fake


def test_record_new_assignments_pins_pep_cls_not_mysql_database():
    # get_credential above deliberately returns database='mcaff_prod' (what .env.local sets):
    # inheriting it writes to a schema where this table does not exist.
    ok, _cursor, fake = _run_record([("AWB1", "a@x.com")])
    assert ok is True
    assert fake.connect_kwargs["database"] == "PEP_CLS", \
        f"connect must pin PEP_CLS, got {fake.connect_kwargs['database']!r}"


def test_record_new_assignments_dedupes_repeated_awb_in_one_batch():
    # The NDR sheet carries the same AWB on more than one row (358 such AWBs on 2026-08-25).
    # Two inserts of one AWB in a single batch collide on live_awb_number and, before this,
    # rolled back the whole batch.
    ok, cursor, _fake = _run_record(
        [("AWB1", "a@x.com"), ("AWB2", "b@x.com"), ("AWB1", "c@x.com")])
    assert ok is True
    inserts = [p for sql, p in cursor.statements if "INSERT" in sql]
    assert len(inserts) == 2, f"expected 2 deduped inserts, got {len(inserts)}"
    awb1 = [p for p in inserts if p[0] == "AWB1"]
    assert len(awb1) == 1 and awb1[0][1] == "c@x.com", "last agent must win for a repeated AWB"


def test_record_new_assignments_absorbs_live_key_collision_per_row():
    # One un-retired live row must not discard the rest of the batch - this is the shape that
    # left ndr_lead_assignments recording nothing from 2026-08-21.
    ok, cursor, _fake = _run_record(
        [("AWB1", "a@x.com"), ("AWB2", "b@x.com")], collide=("AWB1",))
    assert ok is True
    updates = [p for sql, p in cursor.statements
               if sql.startswith("UPDATE") and isinstance(p, tuple)]
    assert any(p[2] == "AWB1" for p in updates), "collided AWB must fall back to an UPDATE"
    inserts = [p for sql, p in cursor.statements if "INSERT" in sql]
    assert any(p[0] == "AWB2" for p in inserts), "the other lead must still be inserted"


def test_record_new_assignments_reports_failure_without_raising():
    # A non-collision error still aborts the batch, but must be REPORTED (False), not
    # swallowed - main() turns that into a failed run so it can't go unnoticed for days.
    ok, _cursor, fake = _run_record(
        [("AWB1", "a@x.com")], explode=("AWB1",))
    assert ok is False, "a hard write failure must report False"
    assert fake.conn.rolled_back is True and fake.conn.closed is True


def test_record_new_assignments_survives_connect_failure():
    # The connect used to sit outside the try: a failure there propagated out and killed main()
    # right after the sheet write, losing the summary of what had just been assigned.
    ok, _cursor, _fake = _run_record(
        [("AWB1", "a@x.com")], connect_error=RuntimeError("no route to host"))
    assert ok is False, "a connect failure must report False, not raise"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
