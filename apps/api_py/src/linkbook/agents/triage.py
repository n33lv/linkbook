"""§5.3 — Triage. Recommended actions are deterministic per event type."""

from __future__ import annotations

from typing import Any

from ..lib.log import AppLogger

RECOMMENDED_ACTIONS: dict[str, list[str]] = {
    # Money in
    "invoice.overdue": ["invoice.remind", "event.snooze"],
    "invoice.aging_30": ["invoice.remind"],
    "invoice.aging_60": ["invoice.remind"],
    "invoice.aging_90": ["invoice.remind"],
    "invoice.paid": [],
    "invoice.draft_ready_to_send": ["invoice.send"],
    "payment.received_unapplied": ["payment.apply"],
    # Money out
    "bill.due_in_3_days": [],
    "expense.uncategorized": [],
    # Time
    "time.missing_yesterday": ["time.self_nudge"],
    "time.budget_threshold_80": ["email.send_draft", "project.update_status"],
    "time.budget_threshold_100": ["email.send_draft", "project.update_status"],
    "time.budget_threshold_120": ["email.send_draft", "project.update_status"],
    "time.uninvoiced_over_threshold": [],
    # Contracts
    "contract.sent_unsigned_5d": ["contract.send_reminder"],
    "contract.signed": ["project.kickoff"],
    "contract.declined": [],
    # Project
    "project.status_stale": ["project.update_status"],
    "project.milestone_due_soon": [],
    "project.milestone_overdue": [],
    # Client comms
    "email.client_reply_awaiting_response_3d": ["email.send_draft"],
    # System
    "integration.disconnected": [],
    "integration.harvest_qbo_sync_lag": [],
    "action.failed": [],
    "agent.needs_approval": [],
}


def recommended_actions_for(event_type: str) -> list[str]:
    return list(RECOMMENDED_ACTIONS.get(event_type, []))


async def run_triage(_event: dict[str, Any], _cfg: Any, _log: AppLogger) -> None:
    """No-op today — kept as the named hook for an LLM-shaped triage later."""
    return
