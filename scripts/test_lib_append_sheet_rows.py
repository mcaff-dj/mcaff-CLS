"""Self-check for lib.py's append_sheet_rows - the ONE Sheets write this whole feature makes
per upload, so it matters this hits the right Google endpoint with the right body shape.
Mocks requests.post; no live network. Run: python scripts/test_lib_append_sheet_rows.py"""
import sys
import urllib.parse
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib


def test_append_sheet_rows_calls_values_append_with_insert_rows():
    captured = {}

    def fake_post(url, headers=None, json=None):
        captured['url'] = url
        captured['headers'] = headers
        captured['json'] = json
        resp = MagicMock()
        resp.raise_for_status = lambda: None
        resp.json = lambda: {"updates": {"updatedRows": 2}}
        return resp

    with patch.object(lib, 'get_write_access_token', return_value='fake-token'), \
         patch.object(lib.requests, 'post', side_effect=fake_post):
        result = lib.append_sheet_rows('SHEET123', "'Data'!B2:P", [
            ["19-08-2026", "", "Reason A", "HYP1", "U1", "AWB1"],
            ["19-08-2026", "", "Reason B", "HYP2", "U2", "AWB2"],
        ])

    encoded = urllib.parse.quote("'Data'!B2:P", safe="")
    assert f"/values/{encoded}:append" in captured['url'], f"must have range in path before :append, got {captured['url']}"
    assert captured['url'].endswith(':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS'), f"wrong query params, got {captured['url']}"
    assert captured['json']['valueInputOption'] == 'USER_ENTERED'
    assert captured['json']['values'] == [
        ["19-08-2026", "", "Reason A", "HYP1", "U1", "AWB1"],
        ["19-08-2026", "", "Reason B", "HYP2", "U2", "AWB2"],
    ]
    assert result == {"updates": {"updatedRows": 2}}


def test_append_sheet_rows_empty_list_is_a_noop():
    # Never call Google for zero rows - avoids a pointless request and a confusing 400.
    with patch.object(lib.requests, 'post') as mock_post:
        result = lib.append_sheet_rows('SHEET123', "'Data'!B2:P", [])
    mock_post.assert_not_called()
    assert result == {"updates": {"updatedRows": 0}}


if __name__ == "__main__":
    test_append_sheet_rows_calls_values_append_with_insert_rows()
    print("  ok  test_append_sheet_rows_calls_values_append_with_insert_rows")
    test_append_sheet_rows_empty_list_is_a_noop()
    print("  ok  test_append_sheet_rows_empty_list_is_a_noop")
    print("2 passed")
