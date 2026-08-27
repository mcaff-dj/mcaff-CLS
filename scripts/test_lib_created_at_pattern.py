"""Self-check for lib.py's CREATED_AT_PATTERN: matches both FlowCall Created At
formats (the old "D/M/YYYY, h:mm:ss am/pm" and the "D-M-YY H:MM:SS" 24h form
used since 2026-08-25), rejects everything else.
Run: python scripts/test_lib_created_at_pattern.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import CREATED_AT_PATTERN


def test_matches_old_format():
    assert CREATED_AT_PATTERN.match("10/8/2026, 2:32:59 PM")
    assert CREATED_AT_PATTERN.match("9/8/2026 12:05:00 am")  # comma optional


def test_matches_new_format():
    assert CREATED_AT_PATTERN.match("27-08-26 11:14:44")
    assert CREATED_AT_PATTERN.match("5-8-26 9:02:00")


def test_rejects_malformed():
    assert not CREATED_AT_PATTERN.match("garbage")
    assert not CREATED_AT_PATTERN.match("")
    assert not CREATED_AT_PATTERN.match("27-08-2026 11:14:44")  # 4-digit year not the new format


if __name__ == "__main__":
    test_matches_old_format()
    test_matches_new_format()
    test_rejects_malformed()
    print("all tests passed")
