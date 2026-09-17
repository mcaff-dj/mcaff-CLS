#!/usr/bin/env python3
"""Behavior check for the Detractor-feedback keyword categorizer.

No Sheets/MySQL access: runs on hand-built strings. `python scripts/test_nps_feedback_categorizer.py`
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nps_feedback_categorizer import OTHER_CATEGORY, categorize


def test_single_category_match():
    assert categorize("the fragrance is way too strong") == ["Fragrance"]


def test_multi_category_match():
    hits = categorize("bottle leaked in transit and it smells different now")
    assert "Packaging/Leakage" in hits
    assert "Fragrance" in hits
    assert len(hits) == 2


def test_no_match_falls_back_to_other():
    assert categorize("just okay overall, nothing special") == [OTHER_CATEGORY]


def test_empty_string_does_not_crash():
    assert categorize("") == [OTHER_CATEGORY]
    assert categorize(None) == [OTHER_CATEGORY]


def test_match_is_case_insensitive():
    assert categorize("SMELL is terrible") == ["Fragrance"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all passed")
