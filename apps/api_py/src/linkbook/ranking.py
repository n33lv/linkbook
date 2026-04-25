"""§1.3 priority_score formula. Pure function, deterministic, no ML.

score = w_money * money_at_stake_normalized
      + w_urgency * recency_decay(due_date)
      + w_client_tier * client_tier_weight
      + w_blocking * is_blocking_other_work
      + w_neglect * days_unread_in_inbox
      - w_snoozed * snooze_decay

All sub-terms normalized to [0, 1] before weighting. Scaled to 0..100.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .config import AppConfig

MONEY_ANCHOR_CENTS = 25_000_00


@dataclass
class RankInputs:
    money_at_stake_cents: int
    days_to_due: float | None
    client_tier: int | None  # 1..3 or None
    is_blocking_other_work: bool
    days_unread_in_inbox: float
    snooze_decay: float


@dataclass
class RankBreakdown:
    money: int
    urgency: int
    client_tier: int
    blocking: int
    neglect: int
    snoozed: int
    total: int


def _normalize_money(cents: int) -> float:
    if cents <= 0:
        return 0
    t = math.log10(1 + cents / MONEY_ANCHOR_CENTS) / math.log10(11)
    return max(0.0, min(1.0, t))


def _urgency_from_days(days_to_due: float | None) -> float:
    if days_to_due is None:
        return 0
    if days_to_due >= 0:
        return max(0.0, min(0.5, (60 - days_to_due) / 120))
    past = -days_to_due
    return min(1.0, 0.5 + past / 60)


def _tier_weight(tier: int | None) -> float:
    if tier == 1:
        return 1.0
    if tier == 2:
        return 0.55
    if tier == 3:
        return 0.25
    return 0.0


def _neglect(days_unread: float) -> float:
    return min(1.0, days_unread / 21)


def compute_priority_score(inputs: RankInputs, cfg: AppConfig) -> RankBreakdown:
    money = _normalize_money(inputs.money_at_stake_cents)
    urgency = _urgency_from_days(inputs.days_to_due)
    client_tier = _tier_weight(inputs.client_tier)
    blocking = 1.0 if inputs.is_blocking_other_work else 0.0
    neglect_t = _neglect(inputs.days_unread_in_inbox)
    snoozed = max(0.0, min(1.0, inputs.snooze_decay))

    positive_sum = (
        cfg.RANK_W_MONEY * money
        + cfg.RANK_W_URGENCY * urgency
        + cfg.RANK_W_CLIENT_TIER * client_tier
        + cfg.RANK_W_BLOCKING * blocking
        + cfg.RANK_W_NEGLECT * neglect_t
    )
    positive_denom = (
        cfg.RANK_W_MONEY
        + cfg.RANK_W_URGENCY
        + cfg.RANK_W_CLIENT_TIER
        + cfg.RANK_W_BLOCKING
        + cfg.RANK_W_NEGLECT
    )
    positive = positive_sum / positive_denom if positive_denom > 0 else 0
    penalty = cfg.RANK_W_SNOOZED * snoozed
    score = round(max(0.0, min(1.0, positive - penalty)) * 100)

    return RankBreakdown(
        money=round(money * 100),
        urgency=round(urgency * 100),
        client_tier=round(client_tier * 100),
        blocking=round(blocking * 100),
        neglect=round(neglect_t * 100),
        snoozed=round(snoozed * 100),
        total=score,
    )


def rank_inputs_from_event(
    event_type: str,
    payload: dict[str, Any],
    *,
    client_tier: int | None,
    is_blocking_other_work: bool,
    days_unread_in_inbox: float,
    snooze_decay: float,
) -> RankInputs:
    """Pull rank inputs from a (loaded) event's type + payload."""
    money_at_stake_cents = 0
    days_to_due: float | None = None

    if event_type in (
        "invoice.overdue",
        "invoice.aging_30",
        "invoice.aging_60",
        "invoice.aging_90",
    ):
        money_at_stake_cents = int(payload.get("amount_cents", 0))
        days_to_due = -float(payload.get("days_overdue", 0))
    elif event_type == "invoice.draft_ready_to_send":
        money_at_stake_cents = int(payload.get("amount_cents", 0))
    elif event_type == "payment.received_unapplied":
        money_at_stake_cents = int(payload.get("amount_cents", 0))
    elif event_type == "bill.due_in_3_days":
        money_at_stake_cents = int(payload.get("amount_cents", 0))
        due = payload.get("due_at")
        if due:
            from datetime import datetime

            due_dt = datetime.fromisoformat(due) if isinstance(due, str) else due
            from datetime import timezone as _tz

            now = datetime.now(_tz.utc).replace(tzinfo=None)
            days_to_due = (due_dt.replace(tzinfo=None) - now).total_seconds() / 86400
    elif event_type == "time.uninvoiced_over_threshold":
        money_at_stake_cents = int(payload.get("uninvoiced_amount_cents", 0))
    elif event_type in ("project.milestone_due_soon", "project.milestone_overdue"):
        due = payload.get("due_at")
        if due:
            from datetime import datetime, timezone as _tz

            due_dt = datetime.fromisoformat(due) if isinstance(due, str) else due
            now = datetime.now(_tz.utc).replace(tzinfo=None)
            days_to_due = (due_dt.replace(tzinfo=None) - now).total_seconds() / 86400

    return RankInputs(
        money_at_stake_cents=money_at_stake_cents,
        days_to_due=days_to_due,
        client_tier=client_tier,
        is_blocking_other_work=is_blocking_other_work,
        days_unread_in_inbox=days_unread_in_inbox,
        snooze_decay=snooze_decay,
    )
