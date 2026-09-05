"""Self-check for mysql_lib.py's shared connection - no real database involved, just a fake
pymysql.connect that records its kwargs.

Guards the actual bug this file exists for: _get_connection() reuses one connection for the
process's lifetime (a warm Lambda container can span many invocations), and query() never
commits (only execute()/executemany() do). Without autocommit=True, that leaves every
SELECT-only caller sitting inside one never-closed REPEATABLE READ transaction, frozen at
whichever snapshot it first opened - a fresh commit from another connection (e.g. an
agent_presence heartbeat) becomes invisible until the container happens to recycle. This is
exactly what made assign_ndr_leads.py report an online, heartbeat-fresh agent as stale on
every invocation while an ad-hoc connection saw her fine.

Run directly: python scripts/test_mysql_lib_autocommit.py
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib  # noqa: E402


def test_get_connection_passes_autocommit_true():
    calls = []

    class FakeConn:
        def ping(self, reconnect=True):
            pass

    fake_pymysql = types.SimpleNamespace(connect=lambda **kw: (calls.append(kw), FakeConn())[1])
    orig_module = sys.modules.get("pymysql")
    orig_conn = mysql_lib._conn
    orig_current_db = mysql_lib._current_db
    sys.modules["pymysql"] = fake_pymysql
    mysql_lib._conn = None
    mysql_lib._current_db = None
    try:
        mysql_lib._get_connection({
            "host": "h", "user": "u", "password": "p", "database": "PEP_CLS", "port": 3306,
        })
        assert len(calls) == 1, "expected exactly one pymysql.connect() call"
        assert calls[0].get("autocommit") is True, \
            "connection must be autocommit=True, or a long-lived SELECT-only caller can be " \
            "stuck reading a frozen snapshot forever"
    finally:
        if orig_module is not None:
            sys.modules["pymysql"] = orig_module
        else:
            sys.modules.pop("pymysql", None)
        mysql_lib._conn = orig_conn
        mysql_lib._current_db = orig_current_db


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
