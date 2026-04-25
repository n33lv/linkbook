"""Unit — §1.3 priority score."""

from __future__ import annotations

import pytest

from linkbook.config import load_config
from linkbook.ranking import RankInputs, compute_priority_score


@pytest.fixture
def cfg():
    return load_config()


@pytest.fixture
def baseline() -> RankInputs:
    return RankInputs(
        money_at_stake_cents=0,
        days_to_due=None,
        client_tier=None,
        is_blocking_other_work=False,
        days_unread_in_inbox=0,
        snooze_decay=0,
    )


def test_zero_for_empty(cfg, baseline):
    assert compute_priority_score(baseline, cfg).total == 0


def test_money_monotonic(cfg, baseline):
    a = compute_priority_score(
        RankInputs(**{**baseline.__dict__, "money_at_stake_cents": 1_000_00}), cfg
    ).total
    b = compute_priority_score(
        RankInputs(**{**baseline.__dict__, "money_at_stake_cents": 50_000_00}), cfg
    ).total
    assert b > a


def test_past_due_dominates_future(cfg, baseline):
    past = compute_priority_score(
        RankInputs(**{**baseline.__dict__, "days_to_due": -30}), cfg
    ).total
    future = compute_priority_score(
        RankInputs(**{**baseline.__dict__, "days_to_due": 30}), cfg
    ).total
    assert past > future


def test_tier1_outweighs_tier3(cfg, baseline):
    t1 = compute_priority_score(
        RankInputs(**{**baseline.__dict__, "client_tier": 1}), cfg
    ).total
    t3 = compute_priority_score(
        RankInputs(**{**baseline.__dict__, "client_tier": 3}), cfg
    ).total
    assert t1 > t3


def test_w_neglect_no_decay(cfg, baseline):
    fresh = compute_priority_score(
        RankInputs(
            **{**baseline.__dict__, "money_at_stake_cents": 5_000_00, "days_unread_in_inbox": 0}
        ),
        cfg,
    ).total
    old = compute_priority_score(
        RankInputs(
            **{**baseline.__dict__, "money_at_stake_cents": 5_000_00, "days_unread_in_inbox": 21}
        ),
        cfg,
    ).total
    assert old > fresh


def test_snooze_suppresses(cfg, baseline):
    awake = compute_priority_score(
        RankInputs(
            **{
                **baseline.__dict__,
                "money_at_stake_cents": 25_000_00,
                "days_to_due": -60,
                "client_tier": 1,
                "snooze_decay": 0,
            }
        ),
        cfg,
    ).total
    asleep = compute_priority_score(
        RankInputs(
            **{
                **baseline.__dict__,
                "money_at_stake_cents": 25_000_00,
                "days_to_due": -60,
                "client_tier": 1,
                "snooze_decay": 1,
            }
        ),
        cfg,
    ).total
    assert asleep < awake


def test_clamped_0_100(cfg):
    r = compute_priority_score(
        RankInputs(
            money_at_stake_cents=999_999_99,
            days_to_due=-200,
            client_tier=1,
            is_blocking_other_work=True,
            days_unread_in_inbox=365,
            snooze_decay=0,
        ),
        cfg,
    )
    assert 0 <= r.total <= 100
