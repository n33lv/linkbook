"""Shared types — Pydantic mirror of @linkbook/types.

Single source of truth for the closed event taxonomy (§1.2), action catalog
(§2.2 incl. semantic_fields allowlist), proposal shape, and source enum.
Until the TS backend is removed, this file must be kept in lockstep with
packages/types/src/.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


# =============================================================
# §1.1 — sources
# =============================================================


class Source(StrEnum):
    QBO = "qbo"
    HARVEST = "harvest"
    DROPBOXSIGN = "dropboxsign"
    AIRTABLE = "airtable"
    GMAIL = "gmail"
    LINKBOOK = "linkbook"


SourceLiteral: TypeAlias = Literal[
    "qbo", "harvest", "dropboxsign", "airtable", "gmail", "linkbook"
]


# =============================================================
# §1.2 — event taxonomy (closed set)
# =============================================================


EventType: TypeAlias = Literal[
    # Money in
    "invoice.overdue",
    "invoice.aging_30",
    "invoice.aging_60",
    "invoice.aging_90",
    "invoice.paid",
    "invoice.draft_ready_to_send",
    "payment.received_unapplied",
    # Money out
    "bill.due_in_3_days",
    "expense.uncategorized",
    # Time
    "time.missing_yesterday",
    "time.budget_threshold_80",
    "time.budget_threshold_100",
    "time.budget_threshold_120",
    "time.uninvoiced_over_threshold",
    # Contracts
    "contract.sent_unsigned_5d",
    "contract.signed",
    "contract.declined",
    # Project
    "project.status_stale",
    "project.milestone_due_soon",
    "project.milestone_overdue",
    # Client comms
    "email.client_reply_awaiting_response_3d",
    # System
    "integration.disconnected",
    "integration.harvest_qbo_sync_lag",
    "action.failed",
    "agent.needs_approval",
]


# §1.4 — event lifecycle
EventState: TypeAlias = Literal["unread", "read", "done", "snoozed", "dismissed", "waiting"]


class EventEnvelope(BaseModel):
    """Normalized event envelope (§1.1). Payload is a discriminated union
    by `type` in the Zod world; here we stay loose with `dict[str, Any]`
    and validate the per-type shape at the agent boundary if needed."""

    model_config = ConfigDict(populate_by_name=True)

    event_id: str
    source: SourceLiteral
    type: EventType
    subject_ref: str
    occurred_at: datetime
    ingested_at: datetime
    priority_score: int = Field(ge=0, le=100)
    state: EventState
    suggested_actions: list[str]
    payload: dict[str, Any]
    thread_id: str | None = None
    dedupe_key: str

    @field_validator("subject_ref")
    @classmethod
    def _check_subject_ref(cls, v: str) -> str:
        if ":" not in v or not v.split(":", 1)[0].replace("_", "").isalpha():
            raise ValueError("subject_ref must be 'kind:id'")
        return v


# =============================================================
# §2.2 — action catalog
# =============================================================


ActionType: TypeAlias = Literal[
    # Invoicing & payments
    "invoice.send",
    "invoice.remind",
    "invoice.mark_paid_manual",
    "payment.apply",
    # Contracts
    "contract.send_reminder",
    "contract.create_from_template",
    # Projects
    "project.kickoff",
    "project.mark_complete",
    "project.update_status",
    # Time
    "time.self_nudge",
    "time.log_entry",
    # Client comms
    "email.send_draft",
    # Internal
    "task.create",
    "event.snooze",
    "event.dismiss",
    "event.mark_done",
]


# §2.3 — manual or proposed; no Auto in v1
ActionMode: TypeAlias = Literal["manual", "proposed"]


# §2.1 — full state machine, including queued_30s for soft-undo (§2.5)
ActionStatus: TypeAlias = Literal[
    "drafted",
    "approved",
    "queued_30s",
    "executing",
    "succeeded",
    "failed",
    "cancelled",
    "undone",
]


# §2.5 — every action declares its reversal class at definition time.
ReversalClass: TypeAlias = Literal["true_undo", "compensating", "no_undo"]


class ActionCatalogEntry(BaseModel):
    type: ActionType
    reversal_class: ReversalClass
    default_mode: ActionMode
    # §2.4 — fields that participate in the idempotency hash. Everything
    # else in `params` is cosmetic and ignored.
    semantic_fields: tuple[str, ...]


ACTION_CATALOG: dict[ActionType, ActionCatalogEntry] = {
    "invoice.send": ActionCatalogEntry(
        type="invoice.send",
        reversal_class="no_undo",
        default_mode="manual",
        semantic_fields=("harvest_invoice_id",),
    ),
    "invoice.remind": ActionCatalogEntry(
        type="invoice.remind",
        reversal_class="compensating",
        default_mode="proposed",
        semantic_fields=("recipient", "invoice_id", "tone"),
    ),
    "invoice.mark_paid_manual": ActionCatalogEntry(
        type="invoice.mark_paid_manual",
        reversal_class="compensating",
        default_mode="manual",
        semantic_fields=("invoice_id", "amount_cents"),
    ),
    "payment.apply": ActionCatalogEntry(
        type="payment.apply",
        reversal_class="compensating",
        default_mode="proposed",
        semantic_fields=("payment_id", "invoice_id", "amount_cents"),
    ),
    "contract.send_reminder": ActionCatalogEntry(
        type="contract.send_reminder",
        reversal_class="no_undo",
        default_mode="proposed",
        semantic_fields=("signature_request_id", "recipient"),
    ),
    "contract.create_from_template": ActionCatalogEntry(
        type="contract.create_from_template",
        reversal_class="no_undo",
        default_mode="manual",
        semantic_fields=("template_id", "recipient"),
    ),
    "project.kickoff": ActionCatalogEntry(
        type="project.kickoff",
        reversal_class="true_undo",
        default_mode="proposed",
        semantic_fields=("contract_id", "client_id"),
    ),
    "project.mark_complete": ActionCatalogEntry(
        type="project.mark_complete",
        reversal_class="true_undo",
        default_mode="manual",
        semantic_fields=("project_id",),
    ),
    "project.update_status": ActionCatalogEntry(
        type="project.update_status",
        reversal_class="true_undo",
        default_mode="proposed",
        semantic_fields=("project_id", "new_status"),
    ),
    "time.self_nudge": ActionCatalogEntry(
        type="time.self_nudge",
        reversal_class="no_undo",
        default_mode="proposed",
        semantic_fields=(),
    ),
    "time.log_entry": ActionCatalogEntry(
        type="time.log_entry",
        reversal_class="true_undo",
        default_mode="manual",
        semantic_fields=("harvest_project_id", "date", "hours"),
    ),
    "email.send_draft": ActionCatalogEntry(
        type="email.send_draft",
        reversal_class="no_undo",
        default_mode="proposed",
        semantic_fields=("recipient", "thread_id"),
    ),
    "task.create": ActionCatalogEntry(
        type="task.create",
        reversal_class="true_undo",
        default_mode="manual",
        semantic_fields=("title", "subject_ref"),
    ),
    "event.snooze": ActionCatalogEntry(
        type="event.snooze",
        reversal_class="true_undo",
        default_mode="manual",
        semantic_fields=("event_id",),
    ),
    "event.dismiss": ActionCatalogEntry(
        type="event.dismiss",
        reversal_class="true_undo",
        default_mode="manual",
        semantic_fields=("event_id",),
    ),
    "event.mark_done": ActionCatalogEntry(
        type="event.mark_done",
        reversal_class="true_undo",
        default_mode="manual",
        semantic_fields=("event_id",),
    ),
}


# =============================================================
# §5.3 — agents and proposals
# =============================================================


AgentName: TypeAlias = Literal[
    "cash_chaser", "project_concierge", "time_sentinel", "reconciler", "triage"
]


# §5.3 — Reconciler proposes only at >= 0.85 confidence; below that the
# event remains a manual `payment.received_unapplied`.
RECONCILER_CONFIDENCE_THRESHOLD = 0.85


class Proposal(BaseModel):
    """Agent → executor return shape. The runtime validates this against
    every Agentspan response and falls back to Manual after two malformed
    attempts (§5.3)."""

    agent: AgentName
    agent_version: Annotated[str, Field(pattern=r"^v\d+(\.\d+)*$")]
    confidence: float = Field(ge=0, le=1)
    rationale: Annotated[str, Field(min_length=1, max_length=500)]
    # The Action shape to be persisted as `mode='proposed', status='drafted'`.
    # Kept as `Any` here to avoid a cyclic dep with the Action schemas; the
    # caller validates against the catalog before insert.
    draft_action: Any | None = None


__all__ = [
    "ACTION_CATALOG",
    "ActionCatalogEntry",
    "ActionMode",
    "ActionStatus",
    "ActionType",
    "AgentName",
    "EventEnvelope",
    "EventState",
    "EventType",
    "Proposal",
    "RECONCILER_CONFIDENCE_THRESHOLD",
    "ReversalClass",
    "Source",
    "SourceLiteral",
]
