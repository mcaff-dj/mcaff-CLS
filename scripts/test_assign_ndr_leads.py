"""Self-check for assign_ndr_leads.py's fetch_online_ndr_agents - both agent_presence and
calling_agent_process now live in MySQL PEP_CLS (see
migrate_calling_business_hours_and_agent_process_to_mysql.py). Every failure path now fails
CLOSED to an empty result: missing MySQL creds, agent_presence itself failing, and (as of the
per-team isolation feature - see docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-
design.md) a calling_agent_process failure or an empty result too. The old "fall back to
globally-present agents with no per-process filters" behaviour for the latter two is GONE -
see the two tests below whose names still describe the old branch, kept as regression guards
that the new behaviour is empty, not global.

Also covers: record_new_assignments (the schema it connects to, batch dedup, per-row recovery
from a live_awb_number collision, and reporting rather than swallowing a hard write failure),
fetch_active_ndr_teams (the None-vs-[] distinction main() depends on to never guess), and the
team_id column now returned by fetch_online_ndr_agents.

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
        assert result == ([], {}, {}, {}, {}, {}, {}), \
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
            return [("A@x.com",), ("B@x.com",)]
        # calling_agent_process: email, status, max_quota, attempt_count_filter,
        # ndr_reason_filter, ndr_payment_mode_filter, ndr_brand_filter, team_id - b@x.com is
        # online and on the roster but has never been assigned a team (team_id NULL/None),
        # which main() must treat as "eligible when isolation is off, excluded once it's on".
        return [
            ("a@x.com", "Online", 5, "1,2", "damaged", "Prepaid", "Hyphen", 7),
            ("b@x.com", "Online", None, "", "", "", "", None),
        ]

    assign_ndr_leads.mysql_lib.query = _fake_query
    try:
        present, quotas, attempt_f, reason_f, mode_f, brand_f, team_ids = \
            assign_ndr_leads.fetch_online_ndr_agents()
        assert present == ["a@x.com", "b@x.com"], f"expected lowercased emails, got {present!r}"
        assert quotas == {"a@x.com": 5}
        assert attempt_f == {"a@x.com": ["1", "2"]}
        assert reason_f == {"a@x.com": ["damaged"]}
        assert mode_f == {"a@x.com": "Prepaid"}
        assert brand_f == {"a@x.com": "Hyphen"}
        assert team_ids == {"a@x.com": 7, "b@x.com": None}, \
            f"expected team_id per agent (None for unassigned), got {team_ids!r}"
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
    # ("fails open" here means the RUN doesn't crash - the returned agent list is still empty,
    # i.e. this query's own failure mode was already the safe one before per-team isolation and
    # needed no change; contrast the two tests below, whose names describe a genuinely different,
    # unsafe old behaviour that this feature removed.)
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
        assert result == ([], {}, {}, {}, {}, {}, {}), \
            "an agent_presence query failure must fail open (empty), not raise"
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


def test_fetch_online_ndr_agents_fails_closed_when_calling_agent_process_raises():
    # Before per-team isolation, a calling_agent_process failure fell back to EVERY globally-
    # online agent, ignoring this process's quotas/filters entirely - and, once a team's roster
    # comes only from this same table, would have erased every team boundary too. Must now
    # return empty, exactly like every other failure path, never the present-from-agent_presence
    # set on its own.
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }

    def _fake_query(sql, params=None, database=None):
        if "agent_presence" in sql:
            return [("a@x.com",), ("b@x.com",)]  # plenty of people globally online
        raise RuntimeError("calling_agent_process unavailable")

    assign_ndr_leads.mysql_lib.query = _fake_query
    try:
        result = assign_ndr_leads.fetch_online_ndr_agents()
        assert result == ([], {}, {}, {}, {}, {}, {}), \
            "a calling_agent_process failure must fail CLOSED (empty), not fall back to " \
            "globally-present agents"
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


def test_fetch_online_ndr_agents_fails_closed_when_no_rows_for_process():
    # Zero calling_agent_process rows for 'ndr' is the NORMAL state for a freshly created team
    # with nobody assigned to it yet, or for the legacy desk before anyone has ever toggled
    # Online for NDR specifically - either way it must mean "nothing eligible", never "fall back
    # to every globally-online agent regardless of process".
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }

    def _fake_query(sql, params=None, database=None):
        if "agent_presence" in sql:
            return [("a@x.com",)]
        return []  # calling_agent_process: no rows for this process at all

    assign_ndr_leads.mysql_lib.query = _fake_query
    try:
        result = assign_ndr_leads.fetch_online_ndr_agents()
        assert result == ([], {}, {}, {}, {}, {}, {}), \
            "zero calling_agent_process rows must fail CLOSED (empty), not fall back to " \
            "globally-present agents"
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
    # awb is always the last param (it's the WHERE clause value) regardless of how many lead-
    # attribute columns sit in the SET clause ahead of it.
    assert any(p[-1] == "AWB1" for p in updates), "collided AWB must fall back to an UPDATE"
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


def _patch_mysql_creds():
    orig = assign_ndr_leads.mysql_lib.get_credential
    assign_ndr_leads.mysql_lib.get_credential = lambda: {
        "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
    }
    return orig


def test_fetch_active_ndr_teams_none_vs_empty_list():
    # None ("couldn't ask") and [] ("asked, zero active teams") must stay distinguishable -
    # main() treats them completely differently (raise-and-stop vs. legacy single-pool run).
    orig_get_cred = assign_ndr_leads.mysql_lib.get_credential
    orig_query = assign_ndr_leads.mysql_lib.query
    try:
        assign_ndr_leads.mysql_lib.get_credential = lambda: None
        assert assign_ndr_leads.fetch_active_ndr_teams() is None, \
            "missing MySQL creds must return None, not []"

        _patch_mysql_creds()

        def _boom(sql, params=None, database=None):
            raise RuntimeError("connection reset")
        assign_ndr_leads.mysql_lib.query = _boom
        assert assign_ndr_leads.fetch_active_ndr_teams() is None, \
            "a calling_teams query failure must return None, not []"

        assign_ndr_leads.mysql_lib.query = lambda sql, params=None, database=None: []
        assert assign_ndr_leads.fetch_active_ndr_teams() == [], \
            "zero active teams is a real, successful answer - must be [], not None"

        assign_ndr_leads.mysql_lib.query = lambda sql, params=None, database=None: [
            (1, "Team A", "SHEET_A", "Tab "), (2, "Team B", "SHEET_B", "Tab "),
        ]
        teams = assign_ndr_leads.fetch_active_ndr_teams()
        assert teams == [
            {"id": 1, "name": "Team A", "sheet_id": "SHEET_A", "sheet_tab": "Tab "},
            {"id": 2, "name": "Team B", "sheet_id": "SHEET_B", "sheet_tab": "Tab "},
        ], f"unexpected shape: {teams!r}"
    finally:
        assign_ndr_leads.mysql_lib.get_credential = orig_get_cred
        assign_ndr_leads.mysql_lib.query = orig_query


def _sheet_row(awb, agent=""):
    """One NDR sheet row wide enough to reach COL_CONNECTED (index 19), AWB in COL_AWB (4),
    Agent Name in COL_AGENT (18) - everything else blank, matching an unassigned lead."""
    row = [""] * 20
    row[assign_ndr_leads.COL_AWB] = awb
    row[assign_ndr_leads.COL_AGENT] = agent
    return row


def test_main_isolates_two_teams_no_cross_assignment():
    # THE isolation test: two active teams, one online agent each, one unassigned lead each,
    # on two DIFFERENT sheet ids. Team A's lead must be written to SHEET_A and mirrored under
    # a@x.com; Team B's to SHEET_B under b@x.com - never swapped, never both.
    orig_fetch_teams = assign_ndr_leads.fetch_active_ndr_teams
    orig_fetch_agents = assign_ndr_leads.fetch_online_ndr_agents
    orig_get_values = assign_ndr_leads.lib.get_sheet_values
    orig_set_values = assign_ndr_leads.lib.set_sheet_values_batch
    orig_record = assign_ndr_leads.record_new_assignments

    sheets = {
        "SHEET_A": [_sheet_row("AWB-A")],
        "SHEET_B": [_sheet_row("AWB-B")],
    }
    writes = []  # (spreadsheet_id, updates)
    mirrored_batches = []  # [(awb, email), ...] per call

    assign_ndr_leads.fetch_active_ndr_teams = lambda: [
        {"id": 1, "name": "Team A", "sheet_id": "SHEET_A", "sheet_tab": "Tab"},
        {"id": 2, "name": "Team B", "sheet_id": "SHEET_B", "sheet_tab": "Tab"},
    ]
    assign_ndr_leads.fetch_online_ndr_agents = lambda: (
        ["a@x.com", "b@x.com"],  # online_agents
        {}, {}, {}, {}, {},      # quotas, attempt_f, reason_f, mode_f, brand_f - unrestricted
        {"a@x.com": 1, "b@x.com": 2},  # team_ids
    )
    assign_ndr_leads.lib.get_sheet_values = lambda spreadsheet_id, range_, **kw: sheets[spreadsheet_id]

    def _fake_set_values(spreadsheet_id, updates):
        writes.append((spreadsheet_id, updates))

    def _fake_record(new_assignments):
        mirrored_batches.append(list(new_assignments))
        return True

    assign_ndr_leads.lib.set_sheet_values_batch = _fake_set_values
    assign_ndr_leads.record_new_assignments = _fake_record
    try:
        assign_ndr_leads.main()
    finally:
        assign_ndr_leads.fetch_active_ndr_teams = orig_fetch_teams
        assign_ndr_leads.fetch_online_ndr_agents = orig_fetch_agents
        assign_ndr_leads.lib.get_sheet_values = orig_get_values
        assign_ndr_leads.lib.set_sheet_values_batch = orig_set_values
        assign_ndr_leads.record_new_assignments = orig_record

    assert len(writes) == 2, f"expected one sheet write per team, got {len(writes)}"
    by_sheet = {sid: updates for sid, updates in writes}
    assert by_sheet["SHEET_A"][0]["values"] == [["a@x.com"]], \
        f"Team A's lead must go to a@x.com on SHEET_A, got {by_sheet['SHEET_A']!r}"
    assert by_sheet["SHEET_B"][0]["values"] == [["b@x.com"]], \
        f"Team B's lead must go to b@x.com on SHEET_B, got {by_sheet['SHEET_B']!r}"

    # Each mirrored item is (awb, email, courier, reason, payment_mode, brand) now - compare only
    # the (awb, email) prefix, which is all this test cares about.
    all_mirrored = [pair[:2] for batch in mirrored_batches for pair in batch]
    assert ("AWB-A", "a@x.com") in all_mirrored and ("AWB-B", "b@x.com") in all_mirrored
    assert ("AWB-A", "b@x.com") not in all_mirrored, "team A's AWB must never mirror to team B's agent"
    assert ("AWB-B", "a@x.com") not in all_mirrored, "team B's AWB must never mirror to team A's agent"


def test_main_excludes_unassigned_agent_once_isolation_is_on():
    # An agent online but with NO team_id must get nothing from EITHER team once 2+ teams
    # exist - not "whichever team happens to run first". Team A has no eligible agent at all;
    # its lead must be left unassigned, and the unassigned agent's email must never appear in
    # any write.
    orig_fetch_teams = assign_ndr_leads.fetch_active_ndr_teams
    orig_fetch_agents = assign_ndr_leads.fetch_online_ndr_agents
    orig_get_values = assign_ndr_leads.lib.get_sheet_values
    orig_set_values = assign_ndr_leads.lib.set_sheet_values_batch
    orig_record = assign_ndr_leads.record_new_assignments

    sheets = {"SHEET_A": [_sheet_row("AWB-A")], "SHEET_B": [_sheet_row("AWB-B")]}
    writes = []

    assign_ndr_leads.fetch_active_ndr_teams = lambda: [
        {"id": 1, "name": "Team A", "sheet_id": "SHEET_A", "sheet_tab": "Tab"},
        {"id": 2, "name": "Team B", "sheet_id": "SHEET_B", "sheet_tab": "Tab"},
    ]
    # unassigned@x.com is online but team_id is None - must be excluded from both teams now
    # that isolation is on, not treated as eligible for the first team encountered.
    assign_ndr_leads.fetch_online_ndr_agents = lambda: (
        ["unassigned@x.com", "b@x.com"], {}, {}, {}, {}, {},
        {"unassigned@x.com": None, "b@x.com": 2},
    )
    assign_ndr_leads.lib.get_sheet_values = lambda spreadsheet_id, range_, **kw: sheets[spreadsheet_id]
    assign_ndr_leads.lib.set_sheet_values_batch = lambda spreadsheet_id, updates: writes.append((spreadsheet_id, updates))
    assign_ndr_leads.record_new_assignments = lambda new_assignments: True
    try:
        assign_ndr_leads.main()
    finally:
        assign_ndr_leads.fetch_active_ndr_teams = orig_fetch_teams
        assign_ndr_leads.fetch_online_ndr_agents = orig_fetch_agents
        assign_ndr_leads.lib.get_sheet_values = orig_get_values
        assign_ndr_leads.lib.set_sheet_values_batch = orig_set_values
        assign_ndr_leads.record_new_assignments = orig_record

    assert len(writes) == 1, f"only Team B should have written anything, got {writes!r}"
    assert writes[0][0] == "SHEET_A" or writes[0][0] == "SHEET_B"
    sheet_id, updates = writes[0]
    assert sheet_id == "SHEET_B", "the unassigned agent must never receive Team A's lead either"
    assert updates[0]["values"] == [["b@x.com"]]


def test_main_isolation_off_below_two_active_teams():
    # 0 or 1 active team must behave like the pre-feature single pool: every online agent is
    # eligible for the one run regardless of team_id, and with exactly one team its sheet comes
    # from calling_teams (not the hardcoded constant) while still pooling everyone. Getting this
    # backwards - isolating even below 2 teams - would silently break the desk before anyone
    # ever created a second team.
    orig_fetch_teams = assign_ndr_leads.fetch_active_ndr_teams
    orig_fetch_agents = assign_ndr_leads.fetch_online_ndr_agents
    orig_get_values = assign_ndr_leads.lib.get_sheet_values
    orig_set_values = assign_ndr_leads.lib.set_sheet_values_batch
    orig_record = assign_ndr_leads.record_new_assignments

    # Two leads, two online agents with DIFFERENT (conflicting-looking) team_id values - if
    # isolation were mistakenly on, one of these would be left unassigned. It must not be.
    sheets = {"SHEET_ONE": [_sheet_row("AWB-1"), _sheet_row("AWB-2")]}
    writes = []

    assign_ndr_leads.fetch_active_ndr_teams = lambda: [
        {"id": 9, "name": "Only Team", "sheet_id": "SHEET_ONE", "sheet_tab": "Tab"},
    ]
    assign_ndr_leads.fetch_online_ndr_agents = lambda: (
        ["a@x.com", "b@x.com"], {}, {}, {}, {}, {},
        {"a@x.com": 9, "b@x.com": None},  # b is unassigned - must still be eligible below 2 teams
    )
    assign_ndr_leads.lib.get_sheet_values = lambda spreadsheet_id, range_, **kw: sheets[spreadsheet_id]
    assign_ndr_leads.lib.set_sheet_values_batch = lambda spreadsheet_id, updates: writes.append((spreadsheet_id, updates))
    assign_ndr_leads.record_new_assignments = lambda new_assignments: True
    try:
        assign_ndr_leads.main()
    finally:
        assign_ndr_leads.fetch_active_ndr_teams = orig_fetch_teams
        assign_ndr_leads.fetch_online_ndr_agents = orig_fetch_agents
        assign_ndr_leads.lib.get_sheet_values = orig_get_values
        assign_ndr_leads.lib.set_sheet_values_batch = orig_set_values
        assign_ndr_leads.record_new_assignments = orig_record

    assert len(writes) == 1, f"expected one run (one active team), got {len(writes)} writes"
    sheet_id, updates = writes[0]
    assert sheet_id == "SHEET_ONE", "with exactly one active team, its own sheet is authoritative"
    assigned_emails = {u["values"][0][0] for u in updates}
    assert assigned_emails == {"a@x.com", "b@x.com"}, \
        f"both leads must be assignable across both agents regardless of team_id below 2 " \
        f"active teams, got {assigned_emails!r}"




def _lead_row(awb, reason="", date="01-01-2026", agent=""):
    """One unassigned NDR sheet row carrying a Latest NDR Reason and Latest NDR Date, wide
    enough to reach COL_CONNECTED - the shape assign_for_run's own filter/sort path reads."""
    row = _sheet_row(awb, agent)
    row[assign_ndr_leads.COL_LATEST_NDR_DATE] = date
    row[assign_ndr_leads.COL_LATEST_NDR_REASON] = reason
    return row


def test_assign_for_run_does_not_starve_a_filtered_agent():
    """THE starvation test. One agent with a narrow reason filter alongside four unrestricted
    agents, and only four leads in the whole queue that her filter covers - sorted to the FRONT
    of the queue, since oldest-first is exactly the order that used to hand them away.

    The old pointer round-robin took the first agent from `idx` forward whose filters covered
    the lead, so an unrestricted agent absorbed leads only the filtered agent needed and she
    landed 1 of her 4. She must get all 4: nobody else is short of work, and those are the only
    leads she can ever be given."""
    orig_get_values = assign_ndr_leads.lib.get_sheet_values
    orig_set_values = assign_ndr_leads.lib.set_sheet_values_batch
    orig_record = assign_ndr_leads.record_new_assignments

    # 4 oldest leads carry her reason; 16 fresher ones nobody is restricted to.
    rows = [_lead_row(f"AWB-M{i}", reason="Address Issue - incomplete", date="01-01-2026") for i in range(4)]
    rows += [_lead_row(f"AWB-X{i}", reason="Customer not available", date="02-01-2026") for i in range(16)]

    writes = []
    assign_ndr_leads.lib.get_sheet_values = lambda spreadsheet_id, range_, **kw: rows
    assign_ndr_leads.lib.set_sheet_values_batch = lambda spreadsheet_id, updates: writes.extend(updates)
    assign_ndr_leads.record_new_assignments = lambda new_assignments: True

    agents = ["rasika@x.com", "u1@x.com", "u2@x.com", "u3@x.com", "u4@x.com"]
    try:
        assign_ndr_leads.assign_for_run(
            {"id": 1, "name": "NDR", "sheet_id": "SHEET_A", "sheet_tab": "Tab"},
            agents,
            {e: 20 for e in agents},          # quotas - nobody is near their cap
            {},                                # attempt filters - none
            {"rasika@x.com": ["address issue"]},  # already lowercased, as fetch_online_ndr_agents returns it
            {}, {},                            # payment-mode / brand filters - none
        )
    finally:
        assign_ndr_leads.lib.get_sheet_values = orig_get_values
        assign_ndr_leads.lib.set_sheet_values_batch = orig_set_values
        assign_ndr_leads.record_new_assignments = orig_record

    got = {}
    for u in writes:
        got[u["values"][0][0]] = got.get(u["values"][0][0], 0) + 1
    assert got.get("rasika@x.com") == 4, (
        f"filtered agent starved: expected all 4 leads her filter covers, got "
        f"{got.get('rasika@x.com', 0)} - full split {got!r}"
    )
    assert len(writes) == 20, f"every lead was coverable by someone - expected 20 writes, got {len(writes)}"


def test_assign_for_run_spreads_evenly_when_nobody_is_filtered():
    """Regression guard on the fairness the pointer round-robin used to provide: with no filters
    anywhere and equal quotas, 20 leads across 4 agents must still be 5 each, not 20 to whoever
    sorts first."""
    orig_get_values = assign_ndr_leads.lib.get_sheet_values
    orig_set_values = assign_ndr_leads.lib.set_sheet_values_batch
    orig_record = assign_ndr_leads.record_new_assignments

    rows = [_lead_row(f"AWB-{i}") for i in range(20)]
    writes = []
    assign_ndr_leads.lib.get_sheet_values = lambda spreadsheet_id, range_, **kw: rows
    assign_ndr_leads.lib.set_sheet_values_batch = lambda spreadsheet_id, updates: writes.extend(updates)
    assign_ndr_leads.record_new_assignments = lambda new_assignments: True

    agents = ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]
    try:
        assign_ndr_leads.assign_for_run(
            {"id": None, "name": "NDR", "sheet_id": "SHEET_A", "sheet_tab": "Tab"},
            agents, {e: 20 for e in agents}, {}, {}, {}, {},
        )
    finally:
        assign_ndr_leads.lib.get_sheet_values = orig_get_values
        assign_ndr_leads.lib.set_sheet_values_batch = orig_set_values
        assign_ndr_leads.record_new_assignments = orig_record

    got = {}
    for u in writes:
        got[u["values"][0][0]] = got.get(u["values"][0][0], 0) + 1
    assert sorted(got.values()) == [5, 5, 5, 5], f"expected an even 5-way split, got {got!r}"


def test_main_names_the_agents_excluded_for_having_no_team(capsys=None):
    """An online agent with team_id None gets nothing once isolation is on - correct, but it
    used to happen with no log line at all, which is how 'why am I getting no leads?' became
    unanswerable. main() must name them."""
    import io
    from contextlib import redirect_stdout

    orig_fetch_teams = assign_ndr_leads.fetch_active_ndr_teams
    orig_fetch_agents = assign_ndr_leads.fetch_online_ndr_agents
    orig_get_values = assign_ndr_leads.lib.get_sheet_values
    orig_set_values = assign_ndr_leads.lib.set_sheet_values_batch
    orig_record = assign_ndr_leads.record_new_assignments

    assign_ndr_leads.fetch_active_ndr_teams = lambda: [
        {"id": 1, "name": "Team A", "sheet_id": "SHEET_A", "sheet_tab": "Tab"},
        {"id": 2, "name": "Team B", "sheet_id": "SHEET_B", "sheet_tab": "Tab"},
    ]
    assign_ndr_leads.fetch_online_ndr_agents = lambda: (
        ["rasika@x.com", "b@x.com"], {}, {}, {}, {}, {},
        {"rasika@x.com": None, "b@x.com": 2},
    )
    assign_ndr_leads.lib.get_sheet_values = lambda spreadsheet_id, range_, **kw: [_lead_row("AWB-B")]
    assign_ndr_leads.lib.set_sheet_values_batch = lambda spreadsheet_id, updates: None
    assign_ndr_leads.record_new_assignments = lambda new_assignments: True

    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            assign_ndr_leads.main()
    finally:
        assign_ndr_leads.fetch_active_ndr_teams = orig_fetch_teams
        assign_ndr_leads.fetch_online_ndr_agents = orig_fetch_agents
        assign_ndr_leads.lib.get_sheet_values = orig_get_values
        assign_ndr_leads.lib.set_sheet_values_batch = orig_set_values
        assign_ndr_leads.record_new_assignments = orig_record

    out = buf.getvalue()
    assert "rasika@x.com" in out and "no team" in out.lower(), \
        f"an agent excluded for having no team must be named in the run output, got:\n{out}"


def test_record_new_assignments_writes_lead_attributes_when_given():
    ok, cursor, _fake = _run_record(
        [("AWB1", "a@x.com", "Delhivery", "Customer refused", "COD", "mCaffeine")])
    assert ok is True
    inserts = [p for sql, p in cursor.statements if "INSERT" in sql]
    assert len(inserts) == 1
    awb, email, now, courier, reason, payment_mode, brand = inserts[0]
    assert (courier, reason, payment_mode, brand) == ("Delhivery", "Customer refused", "COD", "mCaffeine")


def test_record_new_assignments_still_accepts_plain_two_tuples():
    # assign_for_run is the only real caller of the longer form; every other existing caller in
    # this test file (and any future one) must keep working with the original (awb, email) shape.
    ok, cursor, _fake = _run_record([("AWB2", "b@x.com")])
    assert ok is True
    inserts = [p for sql, p in cursor.statements if "INSERT" in sql]
    assert inserts[0][3:] == (None, None, None, None)


def test_record_new_assignments_trims_whitespace_only_attrs_to_none():
    # A whitespace-only sheet cell must become NULL, not a truthy space - otherwise it
    # permanently defeats backfill_ndr_lead_attributes_from_sheet.py's WHERE
    # delivery_partner IS NULL gap-filling guard for that row.
    ok, cursor, _fake = _run_record(
        [("AWB3", "c@x.com", "  Delhivery  ", "   ", "COD", "mCaffeine")])
    assert ok is True
    inserts = [p for sql, p in cursor.statements if "INSERT" in sql]
    awb, email, now, courier, reason, payment_mode, brand = inserts[0]
    assert (courier, reason, payment_mode) == ("Delhivery", None, "COD")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
