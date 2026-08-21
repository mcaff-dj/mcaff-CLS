"""Self-check for build_assignment_queue's soft prepaid-target handling. No database, no
network - build_assignment_queue is pure, so these are plain in-memory calls.

Run directly: python scripts/test_lead_priority_prepaid_target.py
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lead_priority import build_assignment_queue  # noqa: E402

TARGETED = "targeted@x.com"
UNTARGETED = "untargeted@x.com"
D = datetime(2026, 8, 21)


def _prepaid_pool(n, start=0):
    """n fresh PREPAID leads (tier 0 - the tier build_assignment_queue sorts to the front)."""
    return [(start + i, D, f"ORD{start + i}", 0) for i in range(n)]


def _counts(result):
    out = {}
    for _row, email in result.items():
        out[email] = out.get(email, 0) + 1
    return out


def test_targeted_agent_can_take_a_prepaid_lead_as_their_first_of_the_run():
    """The bootstrap case. An agent's FIRST assignment of a run is necessarily 100% of their
    run so far, so a naive ratio test rejects it for ANY target below 100 - meaning an agent
    with a prepaid target could never accept a prepaid lead as their first lead, however much
    headroom they had. Here the untargeted agent has room for every lead in the pool, so the
    last-resort pass that ignores targets never fires and the targeted agent gets nothing at
    all."""
    pool = _prepaid_pool(5)
    result = build_assignment_queue(
        pool, [TARGETED, UNTARGETED], {}, quota={TARGETED: 20, UNTARGETED: 20},
        agent_prepaid_target={TARGETED: 10},
    )
    counts = _counts(result)
    assert len(result) == 5, f"every lead should be assigned, got {len(result)}"
    assert counts.get(TARGETED, 0) >= 1, (
        "an agent with a 10% prepaid target and 20 free slots got "
        f"{counts.get(TARGETED, 0)} of {len(pool)} prepaid leads - the ratio test rejected "
        "their very first lead because 1/1 reads as 100%"
    )


def test_prepaid_target_still_steers_the_bulk_away_from_a_low_target_agent():
    """The bootstrap exemption must not turn the soft target into a no-op. With a pool that
    fits inside the untargeted agent's headroom, the targeted agent should now participate -
    but only barely, with the untargeted agent still taking the clear majority."""
    pool = _prepaid_pool(20)
    result = build_assignment_queue(
        pool, [TARGETED, UNTARGETED], {}, quota={TARGETED: 20, UNTARGETED: 20},
        agent_prepaid_target={TARGETED: 10},
    )
    counts = _counts(result)
    assert len(result) == 20, f"every lead should be assigned, got {len(result)}"
    assert counts.get(TARGETED, 0) < counts.get(UNTARGETED, 0), (
        f"the target must still steer the bulk away: targeted={counts.get(TARGETED, 0)}, "
        f"untargeted={counts.get(UNTARGETED, 0)}")


def test_pool_exceeding_untargeted_capacity_still_fills_the_targeted_agent():
    """Regression guard on the pass-3 last-resort path, which was the ONLY way a targeted agent
    got prepaid leads before the bootstrap fix - it must keep working, not be traded away."""
    result = build_assignment_queue(
        _prepaid_pool(40), [TARGETED, UNTARGETED], {}, quota={TARGETED: 20, UNTARGETED: 20},
        agent_prepaid_target={TARGETED: 10},
    )
    counts = _counts(result)
    assert len(result) == 40, f"all 40 leads should be assigned, got {len(result)}"
    assert counts.get(TARGETED, 0) == 20 and counts.get(UNTARGETED, 0) == 20, (
        f"both agents should reach quota: {counts}")


def test_no_target_means_unrestricted():
    """An agent absent from agent_prepaid_target is unrestricted - the pre-feature behaviour."""
    result = build_assignment_queue(
        _prepaid_pool(5), [UNTARGETED], {}, quota={UNTARGETED: 20}, agent_prepaid_target={})
    assert _counts(result).get(UNTARGETED, 0) == 5, "an untargeted agent takes every prepaid lead"


def test_cod_leads_ignore_the_prepaid_target_entirely():
    """The target only ever constrains PREPAID leads (tier 0). A COD pool must be unaffected."""
    cod_pool = [(i, D, f"ORD{i}", 3) for i in range(5)]  # tier 3 = COD
    result = build_assignment_queue(
        cod_pool, [TARGETED], {}, quota={TARGETED: 20}, agent_prepaid_target={TARGETED: 10})
    assert _counts(result).get(TARGETED, 0) == 5, (
        "a 0%-prepaid-relevant COD pool must not be gated by the prepaid target")


def test_quota_and_load_still_cap_a_targeted_agent():
    """The bootstrap exemption must not let an agent exceed their quota."""
    result = build_assignment_queue(
        _prepaid_pool(10), [TARGETED], {TARGETED: 19}, quota={TARGETED: 20},
        agent_prepaid_target={TARGETED: 10})
    assert _counts(result).get(TARGETED, 0) == 1, (
        "an agent 1 slot short of quota must receive exactly 1 lead")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} passed")
