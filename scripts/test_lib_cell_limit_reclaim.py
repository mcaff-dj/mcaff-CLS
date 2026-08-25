"""Self-check for lib.py's 10M-cell-cap recovery: is_cell_limit_error / last_used_row /
trim_empty_grid_rows / post_with_cell_reclaim. All network mocked; no live calls.
Run: python scripts/test_lib_cell_limit_reclaim.py"""
import re
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib

CELL_LIMIT_BODY = ('{"error":{"code":400,"message":"This action would increase the number of cells '
                   'in the workbook above the limit of 10000000 cells.","status":"INVALID_ARGUMENT"}}')


def _resp(status, text='', payload=None):
    r = MagicMock()
    r.status_code = status
    r.text = text
    r.ok = status < 400
    r.json = lambda: payload if payload is not None else {}
    r.raise_for_status = (lambda: None) if status < 400 else _raiser(status, text)
    return r


def _raiser(status, text):
    def raise_():
        raise RuntimeError(f"HTTP {status}: {text}")
    return raise_


def test_is_cell_limit_error_only_matches_the_cap_rejection():
    assert lib.is_cell_limit_error(_resp(400, CELL_LIMIT_BODY))
    # Cap value is not matched on - Google raised it 5M -> 10M once already.
    assert lib.is_cell_limit_error(_resp(400, CELL_LIMIT_BODY.replace('10000000', '20000000')))
    assert not lib.is_cell_limit_error(_resp(400, 'Range exceeds grid limits. Max rows: 1000'))
    assert not lib.is_cell_limit_error(_resp(429, 'rate limit'))
    assert not lib.is_cell_limit_error(_resp(200, ''))


def test_last_used_row_probes_from_the_bottom_and_sees_every_column():
    """5000 allocated rows, last data at row 1234 and only in column C. Must read the
    blank tail plus one chunk - not the whole tab - and must not miss a row blank in A."""
    seen = []

    def fake_get_sheet_values(_sid, range_):
        seen.append(range_)
        start, end = (int(n) for n in re.findall(r'\D(\d+)', range_.split('!')[1]))
        if start > 1234:
            return []  # values.get omits trailing empty rows entirely
        rows = [[''] * 3 for _ in range(start, 1235)]
        rows[1234 - start] = ['', '', 'x']  # data in C only
        return rows

    with patch.object(lib, 'get_sheet_values', side_effect=fake_get_sheet_values):
        assert lib.last_used_row('S', 'Tab', 'C', 5000, chunk=2000) == 1234
    assert seen == ["'Tab'!A3001:C5000", "'Tab'!A1001:C3000"], seen


def test_last_used_row_zero_for_a_fully_empty_tab():
    with patch.object(lib, 'get_sheet_values', return_value=[]):
        assert lib.last_used_row('S', 'Tab', 'Z', 1000, chunk=500) == 0


def test_trim_keeps_buffer_skips_small_tabs_and_never_deletes_row_1():
    meta = {"sheets": [
        {"properties": {"title": "Big", "gridProperties": {"rowCount": 100000, "columnCount": 26}}},
        {"properties": {"title": "Small", "gridProperties": {"rowCount": 600, "columnCount": 10}}},
        {"properties": {"title": "Empty", "gridProperties": {"rowCount": 1000, "columnCount": 26}}},
    ]}
    deletes = []
    last_used = {"Big": 500, "Small": 500, "Empty": 0}

    with patch.object(lib, 'get_access_token', return_value='t'), \
         patch.object(lib.requests, 'get', return_value=_resp(200, payload=meta)), \
         patch.object(lib, 'last_used_row', side_effect=lambda s, name, *a, **k: last_used[name]), \
         patch.object(lib, 'delete_sheet_rows', side_effect=lambda s, n, a, b: deletes.append((n, a, b))):
        freed = lib.trim_empty_grid_rows('S')

    # Big: rows 551..100000 (last data 500 + 50 buffer). Small: 50*10=500 cells < min_gain, skipped.
    # Empty: starts at 51, never at row 1 - a sheet must keep at least one row.
    assert deletes == [("Big", 551, 100000), ("Empty", 51, 1000)], deletes
    assert freed == 99450 * 26 + 950 * 26 == 2610400, freed


def test_append_trims_then_retries_once_on_the_cap():
    posts = []
    responses = [_resp(400, CELL_LIMIT_BODY), _resp(200, payload={"updates": {"updatedRows": 1}})]

    def fake_post(url, headers=None, json=None, timeout=None):
        posts.append(json)
        return responses[len(posts) - 1]

    with patch.object(lib, 'get_write_access_token', return_value='t'), \
         patch.object(lib, 'trim_empty_grid_rows', return_value=5000) as trim, \
         patch.object(lib.requests, 'post', side_effect=fake_post):
        result = lib.append_sheet_rows('S', "'Data'!A2:C", [['a', 'b', 'c']])

    trim.assert_called_once()
    assert len(posts) == 2 and posts[0] == posts[1] == {"values": [['a', 'b', 'c']]}
    assert result == {"updates": {"updatedRows": 1}}


def test_append_does_not_trim_on_an_unrelated_400():
    with patch.object(lib, 'get_write_access_token', return_value='t'), \
         patch.object(lib, 'trim_empty_grid_rows') as trim, \
         patch.object(lib.requests, 'post', return_value=_resp(400, 'Invalid range')):
        try:
            lib.append_sheet_rows('S', "'Data'!A2:C", [['a']])
            raise AssertionError("must propagate a non-cap 400")
        except RuntimeError:
            pass
    trim.assert_not_called()


def test_no_retry_when_there_is_nothing_left_to_trim():
    with patch.object(lib, 'get_write_access_token', return_value='t'), \
         patch.object(lib, 'trim_empty_grid_rows', return_value=0), \
         patch.object(lib.requests, 'post', return_value=_resp(400, CELL_LIMIT_BODY)) as post:
        try:
            lib.append_sheet_rows('S', "'Data'!A2:C", [['a']])
            raise AssertionError("must raise once the workbook is genuinely full")
        except RuntimeError:
            pass
    assert post.call_count == 1, "a trim that freed nothing must not trigger a doomed retry"


def test_ensure_grid_size_recomputes_instead_of_replaying_the_request():
    """A trim that shrinks the target tab must not be undone by a replay of the
    original absolute rowCount - the retry goes back through ensure_grid_size."""
    grids = [{"rowCount": 100000, "columnCount": 26}, {"rowCount": 600, "columnCount": 26}]
    bodies = []
    responses = [_resp(400, CELL_LIMIT_BODY), _resp(200, payload={})]

    def fake_post(url, headers=None, json=None, timeout=None):
        bodies.append(json["requests"][0]["updateSheetProperties"]["properties"]["gridProperties"])
        return responses[len(bodies) - 1]

    with patch.object(lib, 'get_write_access_token', return_value='t'), \
         patch.object(lib, '_get_sheet_gid_and_grid', side_effect=lambda s, n: (7, grids[len(bodies)])), \
         patch.object(lib, 'trim_empty_grid_rows', return_value=5000), \
         patch.object(lib.requests, 'post', side_effect=fake_post):
        lib.ensure_grid_size('S', 'Tab', 700, 30)

    assert bodies[0] == {"rowCount": 100000, "columnCount": 35}, bodies[0]
    # Post-trim the tab is 600 rows, so the retry asks for 750 - not the stale 100000.
    assert bodies[1] == {"rowCount": 750, "columnCount": 35}, bodies[1]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
