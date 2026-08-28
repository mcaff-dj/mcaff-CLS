#!/usr/bin/env python3
"""Unit test for the clone-plan builder in migrate_team_dispositions.py. No DB - the plan is a
pure transform, which is the only part of that script worth testing without a connection."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from migrate_team_dispositions import plan_tree_clone

# (id, parent_id, label, description, sort_order, children_input_type), deliberately with a child
# BEFORE its parent - sort_order is scoped per parent, so the SELECT gives no cross-level order.
SHARED = [
    (10, None, "Connected", "got through", 0, "single"),
    (12, 11, "Reattempt", None, 0, "single"),
    (11, None, "Not Connected", None, 1, "multi"),
    (13, 12, "Wrong Address", None, 0, "text"),
]

plan = plan_tree_clone(SHARED)
assert len(plan) == 4, plan
labels = [p[2] for p in plan]
assert labels.index("Not Connected") < labels.index("Reattempt"), labels
assert labels.index("Reattempt") < labels.index("Wrong Address"), labels

by_label = {p[2]: p for p in plan}
# Roots carry no parent; a child points at its parent's temp key, never a source row's real id.
assert by_label["Connected"][1] is None
assert by_label["Wrong Address"][1] == by_label["Reattempt"][0]
assert by_label["Connected"][3] == "got through"
assert by_label["Not Connected"][4] == 1
assert by_label["Not Connected"][5] == "multi"
assert by_label["Wrong Address"][5] == "text"

# Empty tree plans nothing; an orphan row is dropped, never promoted to a top-level outcome.
assert plan_tree_clone([]) == []
assert plan_tree_clone([(5, 99, "Orphan", None, 0, "single")]) == []

print("test_migrate_team_dispositions.py: all assertions passed")
