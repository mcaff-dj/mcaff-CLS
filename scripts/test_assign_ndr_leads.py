"""Self-check for assign_ndr_leads.py's fetch_online_ndr_agents fail-open contract. No real
database involved.

TEMPORARY (2026-08-17): fetch_online_ndr_agents was reverted to reading Postgres agent_presence
(see its own docstring) - this test currently covers that Postgres fail-open path, not the
MySQL one. Restore the MySQL-path tests (missing MYSQL_* creds, mysql_lib.query call
verification) once that revert is undone.

Run directly: python scripts/test_assign_ndr_leads.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assign_ndr_leads  # noqa: E402


def test_fetch_online_ndr_agents_fails_open_without_postgres_url():
    old = os.environ.pop("POSTGRES_URL", None)
    try:
        result = assign_ndr_leads.fetch_online_ndr_agents()
        assert result == ([], {}, {}, {}, {}, {}), \
            "missing POSTGRES_URL must fail open, not raise"
    finally:
        if old is not None:
            os.environ["POSTGRES_URL"] = old


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
