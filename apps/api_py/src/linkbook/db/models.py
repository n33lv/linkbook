"""SQLAlchemy 2.x typed mapped models — mirror of packages/db/src/schema/*.

Same 12 tables, same CHECK constraints, same indexes. UUIDs generated
app-side as hex32 (same shape as randomUUID() in TS — both produce
36-char hex/dash strings; here we use uuid4().hex.dashed via str(uuid4)
so JSON output matches the TS side exactly).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Declarative root."""


def _uuid() -> str:
    """Standard 36-char dashed UUID, matching TS randomUUID()."""
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    """UTC now without timezone (SQLite has no tz)."""
    return datetime.utcnow()


# ---------- §5.1 — clients (Linkbook-side merged identity) ----------


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # {qbo: "<customer_id>", harvest: "<client_id>", airtable: "<record_id>"}
    source_ids: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False, default=dict)
    email_domains: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    tier: Mapped[int | None] = mapped_column(Integer)
    cost_rate_cents: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint("name", name="clients_name_idx"),
    )


# ---------- §5.1 — projects (read-through join, NEVER OWNED) ----------


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    harvest_project_id: Mapped[str | None] = mapped_column(Text)
    airtable_record_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(Text)
    budget_hours: Mapped[int | None] = mapped_column(Integer)
    hours_used: Mapped[int | None] = mapped_column(Integer)
    last_status_update_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    harvest_etag: Mapped[str | None] = mapped_column(Text)
    airtable_etag: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint("harvest_project_id", name="projects_harvest_idx"),
        UniqueConstraint("airtable_record_id", name="projects_airtable_idx"),
    )


# ---------- invoices ----------


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), nullable=False)
    qbo_invoice_id: Mapped[str | None] = mapped_column(Text)
    harvest_invoice_id: Mapped[str | None] = mapped_column(Text)
    number: Mapped[str] = mapped_column(Text, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="USD")
    issued_at: Mapped[datetime | None] = mapped_column(DateTime)
    due_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="draft")
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint("qbo_invoice_id", name="invoices_qbo_idx"),
        UniqueConstraint("harvest_invoice_id", name="invoices_harvest_idx"),
        Index("invoices_client_due_idx", "client_id", "due_at"),
        Index("invoices_status_idx", "status"),
    )


# ---------- §1.1 — events ----------


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    subject_ref: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    priority_score: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="unread")
    suggested_actions: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    thread_id: Mapped[str | None] = mapped_column(String)
    snoozed_until: Mapped[datetime | None] = mapped_column(DateTime)
    dedupe_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        CheckConstraint(
            "state IN ('unread','read','done','snoozed','dismissed','waiting')",
            name="events_state_check",
        ),
        CheckConstraint("priority_score BETWEEN 0 AND 100", name="events_score_check"),
        UniqueConstraint("type", "subject_ref", "dedupe_key", name="events_dedupe_idx"),
        Index("events_inbox_idx", "state", "priority_score", "occurred_at"),
        Index("events_subject_idx", "subject_ref", "occurred_at"),
    )


# ---------- §2.1 — actions + composite legs ----------


class Action(Base):
    __tablename__ = "actions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    drafted_by: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="drafted")
    reversal_class: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    agent_confidence: Mapped[str | None] = mapped_column(Text)
    agent_rationale: Mapped[str | None] = mapped_column(Text)
    preview: Mapped[str] = mapped_column(Text, nullable=False, default="")
    originating_event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id"))
    subject_ref: Mapped[str] = mapped_column(Text, nullable=False)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime)
    undo_token: Mapped[str | None] = mapped_column(Text)
    queued_until: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('drafted','approved','queued_30s','executing','succeeded','failed','cancelled','undone')",
            name="actions_status_check",
        ),
        CheckConstraint("mode IN ('manual','proposed')", name="actions_mode_check"),
        CheckConstraint(
            "reversal_class IN ('true_undo','compensating','no_undo')",
            name="actions_reversal_check",
        ),
        Index("actions_idem_idx", "idempotency_key", "created_at"),
        Index("actions_queue_idx", "status", "queued_until"),
        Index("actions_subject_idx", "subject_ref", "created_at"),
    )


class ActionLeg(Base):
    __tablename__ = "action_legs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    action_id: Mapped[str] = mapped_column(
        ForeignKey("actions.id", ondelete="CASCADE"), nullable=False
    )
    order: Mapped[int] = mapped_column("order", Integer, nullable=False)
    target: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="drafted")
    error: Mapped[str | None] = mapped_column(Text)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)

    __table_args__ = (
        Index("action_legs_by_action", "action_id", "order"),
        UniqueConstraint("idempotency_key", name="action_legs_idem_idx"),
    )


# ---------- §2.6 — audit log (append-only, 13mo retention) ----------


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    action_id: Mapped[str | None] = mapped_column(ForeignKey("actions.id"))
    originating_event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id"))
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    subject_ref: Mapped[str] = mapped_column(Text, nullable=False)
    request: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    response: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    http_status: Mapped[str | None] = mapped_column(Text)
    transition: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), default=_utcnow
    )

    __table_args__ = (
        Index("audit_by_subject", "subject_ref", "created_at"),
        Index("audit_by_action", "action_id", "created_at"),
        Index("audit_by_kind", "kind", "created_at"),
    )


# ---------- §5.2 + §5.8 — credential vault ----------


class IntegrationConnection(Base):
    __tablename__ = "integration_connections"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    external_account_id: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="connected")
    access_token: Mapped[str | None] = mapped_column(Text)
    refresh_token: Mapped[str | None] = mapped_column(Text)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, nullable=False, default=dict)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint("source", "external_account_id", name="connections_source_account_idx"),
    )


# ---------- §4.4 — Airtable mapping wizard output (generic per-source) ----------


class Mapping(Base):
    __tablename__ = "mappings"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    external_account_id: Mapped[str] = mapped_column(Text, nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "source", "scope", "external_account_id", name="mappings_scoped_idx"
        ),
    )


# ---------- §4.5 — gmail (headers + 7d body cache) ----------


class GmailThread(Base):
    __tablename__ = "gmail_threads"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    gmail_thread_id: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False, default="in_scope")
    client_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint("gmail_thread_id", name="gmail_threads_thread_idx"),
        Index("gmail_threads_last_msg_idx", "last_message_at"),
    )


class GmailMessageHeader(Base):
    __tablename__ = "gmail_message_headers"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    gmail_thread_id: Mapped[str] = mapped_column(Text, nullable=False)
    gmail_message_id: Mapped[str] = mapped_column(Text, nullable=False)
    from_: Mapped[str | None] = mapped_column("from", Text)
    to: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    cc: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    subject: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)
    label_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)

    __table_args__ = (
        UniqueConstraint("gmail_message_id", name="gmail_msg_idx"),
        Index("gmail_msg_thread_idx", "gmail_thread_id", "sent_at"),
    )


class GmailBodyCache(Base):
    __tablename__ = "gmail_body_cache"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    gmail_message_id: Mapped[str] = mapped_column(Text, nullable=False)
    body_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    evict_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        UniqueConstraint("gmail_message_id", name="gmail_body_msg_idx"),
        Index("gmail_body_evict_idx", "evict_at"),
    )
