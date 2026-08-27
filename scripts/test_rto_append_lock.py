"""Self-check for the append lock in process_rto_csv_upload_job.py - the mutual exclusion that
stops two overlapping worker jobs from both passing the live AWB re-check and appending the same
AWB (real duplicates: SF3739213893MCA and a batch of SF36163*MCA rows).

GET_LOCK has three outcomes and only one of them means "you may append": 1 = acquired,
0 = timed out, NULL = error. Treating 0 or NULL as success would reopen the exact race the lock
exists to close, so that mapping is what this pins.

No MySQL, no network, no sheet: the connection is a stub. Run with
`python scripts/test_rto_append_lock.py`.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from process_rto_csv_upload_job import (  # noqa: E402
    APPEND_LOCK_NAME, APPEND_LOCK_TIMEOUT_SEC, _acquire_append_lock, _release_append_lock,
)


class _StubCursor:
    def __init__(self, conn, result):
        self._conn = conn
        self._result = result

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._conn.calls.append((sql, params))
        if self._conn.raise_on_execute:
            raise RuntimeError("connection gone")

    def fetchone(self):
        return (self._result,)


class _StubConn:
    """Returns `result` from every GET_LOCK/RELEASE_LOCK, recording the SQL it was asked to run."""

    def __init__(self, result, raise_on_execute=False):
        self._result = result
        self.raise_on_execute = raise_on_execute
        self.calls = []

    def cursor(self):
        return _StubCursor(self, self._result)


# 1. Only 1 counts as acquired. 0 (lock held by another worker until timeout) and None (server
# error) must both read as "did NOT get it" - the caller fails the job rather than appending.
assert _acquire_append_lock(_StubConn(1)) is True
assert _acquire_append_lock(_StubConn(0)) is False
assert _acquire_append_lock(_StubConn(None)) is False

# 2. The lock is requested by name, with a bounded wait - an unbounded one would let a stuck
# worker hold a later job past its own Lambda timeout.
conn = _StubConn(1)
_acquire_append_lock(conn)
sql, params = conn.calls[0]
assert "GET_LOCK" in sql, sql
assert params == (APPEND_LOCK_NAME, APPEND_LOCK_TIMEOUT_SEC), params
assert 0 < APPEND_LOCK_TIMEOUT_SEC < 900, "must stay under the worker's own 900s Lambda timeout"

# 3. Releasing names the same lock...
conn = _StubConn(1)
_release_append_lock(conn)
sql, params = conn.calls[0]
assert "RELEASE_LOCK" in sql, sql
assert params == (APPEND_LOCK_NAME,), params

# 4. ...and a failed release never propagates: the rows are already appended by then, and the
# lock dies with the connection anyway, so raising here would fail an upload that fully succeeded.
_release_append_lock(_StubConn(1, raise_on_execute=True))

print("test_rto_append_lock.py: all assertions passed")
