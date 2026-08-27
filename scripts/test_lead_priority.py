"""Self-check for build_assignment_queue's reassignment reserve (lead_priority.py).

Without a reserve, every fresh/never-touched lead sorts ahead of every Connected=No
reassignment (see the function's own docstring), and a single-run cursor stops handing out
leads once every online agent hits quota. RTO's fresh backlog is routinely thousands of rows
against a few tens of slots per run, so the fresh pool never actually empties within one run -
which meant a reassignment eligible under reassignRetryCap/reassignMinHoldHours never reached
the front of the cursor and sat attached to its Connected=No agent forever. That is the bug
agents reported as "reassignment isn't happening" (Shubham's leads among them).

reassign_reserve_per_agent fixes this by holding back a few of each agent's open slots for
reassignment candidates before fresh claims them, then giving back whatever reassignment
doesn't use. These tests pin: (1) the reserve=0 path is untouched (proves the bug reproduces
without the fix), (2) the reserve actually gets reassignments assigned despite a fresh backlog
that dwarfs capacity, (3) an oversized reserve never wastes capacity - unused reserve flows
back to fresh in the same run, and (4) per-lead exclusion/payment-mode filters still apply
inside the reserved pass.

No real database or sheet involved - build_assignment_queue is pure.

Run directly: python scripts/test_lead_priority.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lead_priority import build_assignment_queue  # noqa: E402

AGENTS = ["a@x.com", "b@x.com", "c@x.com"]
QUOTA = 5  # 3 agents * 5 = 15 total capacity


def _fresh(n, start=0):
    # (row_index, rto_initiated_date, order_id, tier) - date/tier irrelevant to these tests.
    return [(start + i, None, f"FRESH{start + i}", 2) for i in range(n)]


def _reassign(n, start=1000, excluded_email="z-old-agent@x.com"):
    rows = _fresh(n, start)
    excluded_by_row = {row_index: {excluded_email} for row_index, *_ in rows}
    return rows, excluded_by_row


def test_reserve_zero_lets_backlog_starve_reassignment():
    # Pins the pre-fix bug: with the reserve off, a fresh backlog bigger than total capacity
    # consumes every slot before the cursor ever reaches a reassignment candidate.
    fresh = _fresh(20)
    reassign_rows, excluded_by_row = _reassign(3)
    pool = fresh + reassign_rows
    current_load = {e: 0 for e in AGENTS}

    assignments = build_assignment_queue(
        pool, AGENTS, current_load, quota=QUOTA,
        excluded_by_row=excluded_by_row, reassign_reserve_per_agent=0,
    )

    assert len(assignments) == 15, "capacity is 15 regardless of the reserve"
    reassigned_row_indices = {r for r, *_ in reassign_rows}
    assert not (set(assignments) & reassigned_row_indices), \
        "reserve=0 must reproduce the starvation bug: no reassignment gets a slot"


def test_reserve_guarantees_reassignment_gets_assigned():
    fresh = _fresh(20)
    reassign_rows, excluded_by_row = _reassign(3)
    pool = fresh + reassign_rows
    current_load = {e: 0 for e in AGENTS}

    assignments = build_assignment_queue(
        pool, AGENTS, current_load, quota=QUOTA,
        excluded_by_row=excluded_by_row, reassign_reserve_per_agent=2,
    )

    reassigned_row_indices = {r for r, *_ in reassign_rows}
    assigned_reassignments = set(assignments) & reassigned_row_indices
    assert len(assigned_reassignments) == 3, \
        "all 3 reassignment candidates must be assigned despite the 20-lead fresh backlog"
    assert len(assignments) == 15, \
        "reserve must not shrink total throughput - still fills every slot"


def test_unused_reserve_flows_back_to_fresh_not_wasted():
    # Reserve (2/agent = 6 total) far exceeds the single reassignment lead available - the
    # other 5 reserved slots must still go to fresh, not sit empty.
    fresh = _fresh(20)
    reassign_rows, excluded_by_row = _reassign(1)
    pool = fresh + reassign_rows
    current_load = {e: 0 for e in AGENTS}

    assignments = build_assignment_queue(
        pool, AGENTS, current_load, quota=QUOTA,
        excluded_by_row=excluded_by_row, reassign_reserve_per_agent=2,
    )

    assert len(assignments) == 15, "unused reserve must be reclaimed by fresh leads, not wasted"
    reassigned_row_indices = {r for r, *_ in reassign_rows}
    assert len(set(assignments) & reassigned_row_indices) == 1


def test_no_reassignment_pool_is_byte_identical_to_reserve_off():
    # An empty reassignment pool must behave exactly as before this parameter existed,
    # regardless of what the reserve is set to.
    fresh = _fresh(10)
    current_load = {e: 0 for e in AGENTS}

    with_reserve = build_assignment_queue(
        fresh, AGENTS, dict(current_load), quota=QUOTA, reassign_reserve_per_agent=2)
    without_reserve = build_assignment_queue(
        fresh, AGENTS, dict(current_load), quota=QUOTA, reassign_reserve_per_agent=0)

    assert with_reserve == without_reserve


def test_reserve_still_respects_per_lead_exclusion_and_payment_mode():
    # Exclusion and the hard reassign-payment-mode filter must still apply per lead even when
    # the lead is being assigned out of reserved capacity, not just out of leftover capacity.
    fresh = _fresh(20)
    row_index = 5000
    # Every agent except c@x.com excluded from this one reassignment lead.
    excluded_by_row = {row_index: {"a@x.com", "b@x.com"}}
    reassign_rows = [(row_index, None, "REASSIGN1", 0)]  # tier 0 = prepaid
    pool = fresh + reassign_rows
    current_load = {e: 0 for e in AGENTS}

    assignments = build_assignment_queue(
        pool, AGENTS, current_load, quota=QUOTA,
        excluded_by_row=excluded_by_row,
        agent_reassign_payment_mode={"c@x.com": "COD"},  # c only wants COD reassignments
        reassign_reserve_per_agent=2,
    )

    assert row_index not in assignments, \
        "the only non-excluded agent (c) has a COD-only reassign filter, this lead is Prepaid"



def test_prepaid_target_is_measured_against_capacity_not_the_running_tally():
    """An agent with a prepaid target still gets their share of prepaid leads.

    Prepaid is tier 0, so the sorted pool hands out EVERY prepaid lead before the first COD
    lead exists. A target measured against this run's running tally therefore always sees
    100% prepaid at decision time, and any agent with a target below 100 fails passes 1-2 on
    every prepaid lead in every run - so an agent with no target at all soaks up the whole
    prepaid pool and the targeted agents get none (the "we have prepaid in RTO but I never get
    one" report). The target has to be measured against the agent's capacity for the run.
    """
    agents = ["targeted@x.com", "untargeted@x.com"]
    quota = 10
    prepaid = [(i, None, f"PRE{i}", 0) for i in range(10)]
    cod = [(100 + i, None, f"COD{i}", 2) for i in range(10)]
    current_load = {e: 0 for e in agents}

    assignments = build_assignment_queue(
        prepaid + cod, agents, current_load, quota=quota,
        agent_prepaid_target={"targeted@x.com": 50},
    )

    prepaid_rows = {row_index for row_index, _, _, tier in prepaid}
    got = sum(1 for r, e in assignments.items() if r in prepaid_rows and e == "targeted@x.com")
    assert got == 5, f"targeted agent should get 50% of their 10 slots as prepaid, got {got}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
