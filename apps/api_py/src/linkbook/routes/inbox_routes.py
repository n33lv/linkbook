"""§1 — Inbox routes. Mirrors apps/api/src/routes/inbox.ts."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import and_, desc, func, select
from sqlalchemy.orm import Session

from ..db import get_session
from ..db.models import Action, AuditEvent, Client, Event

router = APIRouter()

FILTER_PILLS = ["all", "money", "projects", "contracts", "time"]
TYPE_GROUPS: dict[str, list[str]] = {
    "all": [],
    "money": [
        "invoice.overdue",
        "invoice.aging_30",
        "invoice.aging_60",
        "invoice.aging_90",
        "invoice.draft_ready_to_send",
        "invoice.paid",
        "payment.received_unapplied",
        "bill.due_in_3_days",
        "expense.uncategorized",
    ],
    "projects": [
        "project.status_stale",
        "project.milestone_due_soon",
        "project.milestone_overdue",
        "time.budget_threshold_80",
        "time.budget_threshold_100",
        "time.budget_threshold_120",
    ],
    "contracts": ["contract.sent_unsigned_5d", "contract.signed", "contract.declined"],
    "time": ["time.missing_yesterday", "time.uninvoiced_over_threshold"],
}


def _serialize_event(e: Event, proposed: list[Action], client: Client | None) -> dict[str, Any]:
    return {
        "id": e.id,
        "source": e.source,
        "type": e.type,
        "subject_ref": e.subject_ref,
        "occurred_at": e.occurred_at.isoformat() + "Z",
        "ingested_at": e.ingested_at.isoformat() + "Z",
        "priority_score": e.priority_score,
        "state": e.state,
        "suggested_actions": e.suggested_actions,
        "payload": e.payload,
        "thread_id": e.thread_id,
        "snoozed_until": e.snoozed_until.isoformat() + "Z" if e.snoozed_until else None,
        "dedupe_key": e.dedupe_key,
        "created_at": e.created_at.isoformat() + "Z",
        "updated_at": e.updated_at.isoformat() + "Z",
        "proposed_actions": [_serialize_action(a) for a in proposed],
        "client": ({"name": client.name, "tier": client.tier} if client else None),
    }


def _serialize_action(a: Action) -> dict[str, Any]:
    return {
        "id": a.id,
        "type": a.type,
        "params": a.params,
        "mode": a.mode,
        "drafted_by": a.drafted_by,
        "status": a.status,
        "reversal_class": a.reversal_class,
        "idempotency_key": a.idempotency_key,
        "agent_confidence": a.agent_confidence,
        "agent_rationale": a.agent_rationale,
        "preview": a.preview,
        "originating_event_id": a.originating_event_id,
        "subject_ref": a.subject_ref,
        "executed_at": a.executed_at.isoformat() + "Z" if a.executed_at else None,
        "undo_token": a.undo_token,
        "queued_until": a.queued_until.isoformat() + "Z" if a.queued_until else None,
        "created_at": a.created_at.isoformat() + "Z",
        "updated_at": a.updated_at.isoformat() + "Z",
    }


@router.get("/inbox")
async def get_inbox(
    request: Request,
    filter: Literal["all", "money", "projects", "contracts", "time"] = "all",
    include_resolved: bool = False,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    state_filter = (
        Event.state.in_(["unread", "read", "snoozed", "waiting", "done", "dismissed"])
        if include_resolved
        else Event.state.in_(["unread", "read", "snoozed", "waiting"])
    )
    type_filter = (
        Event.type.in_(TYPE_GROUPS[filter]) if TYPE_GROUPS[filter] else True  # noqa: E712
    )
    rows = db.execute(
        select(Event)
        .where(and_(state_filter, type_filter))
        .order_by(desc(Event.priority_score), desc(Event.occurred_at))
    ).scalars().all()

    if not rows:
        return {"events": [], "counts": _empty_counts()}

    ids = [r.id for r in rows]
    drafted = db.execute(
        select(Action).where(
            and_(
                Action.originating_event_id.in_(ids),
                Action.status.in_(["drafted", "queued_30s", "approved", "executing"]),
            )
        )
    ).scalars().all()
    drafted_by_ev: dict[str, list[Action]] = {}
    for a in drafted:
        if a.originating_event_id is not None:
            drafted_by_ev.setdefault(a.originating_event_id, []).append(a)

    client_ids = {p.get("client_id") for r in rows for p in [r.payload] if p.get("client_id")}
    clients_by_id = {}
    if client_ids:
        clients = db.execute(select(Client).where(Client.id.in_(client_ids))).scalars().all()
        clients_by_id = {c.id: c for c in clients}

    events_out = []
    for r in rows:
        cid = (r.payload or {}).get("client_id")
        client = clients_by_id.get(cid) if cid else None
        events_out.append(_serialize_event(r, drafted_by_ev.get(r.id, []), client))

    counts = _compute_counts(db)
    return {"events": events_out, "counts": counts}


@router.get("/inbox/{event_id}")
async def get_inbox_event(event_id: str, db: Session = Depends(get_session)) -> dict[str, Any]:
    e = db.get(Event, event_id)
    if e is None:
        return {"event": None, "thread": [], "audit": []}
    thread = (
        db.execute(
            select(Event).where(Event.subject_ref == e.subject_ref).order_by(desc(Event.occurred_at))
        )
        .scalars()
        .all()
    )
    audit = (
        db.execute(
            select(AuditEvent)
            .where(AuditEvent.subject_ref == e.subject_ref)
            .order_by(desc(AuditEvent.created_at))
        )
        .scalars()
        .all()
    )
    return {
        "event": _serialize_event(e, [], None),
        "thread": [_serialize_event(t, [], None) for t in thread],
        "audit": [
            {
                "id": a.id,
                "actor": a.actor,
                "action_id": a.action_id,
                "originating_event_id": a.originating_event_id,
                "kind": a.kind,
                "idempotency_key": a.idempotency_key,
                "subject_ref": a.subject_ref,
                "request": a.request,
                "response": a.response,
                "http_status": a.http_status,
                "transition": a.transition,
                "note": a.note,
                "created_at": a.created_at.isoformat() + "Z",
            }
            for a in audit
        ],
    }


class StateBody(BaseModel):
    state: Literal["read", "done", "snoozed", "dismissed"]
    wake_at: datetime | None = None


@router.post("/inbox/{event_id}/state")
async def post_inbox_state(
    event_id: str, body: StateBody, db: Session = Depends(get_session)
) -> dict[str, bool]:
    cur = db.get(Event, event_id)
    if cur is None:
        raise HTTPException(status_code=404, detail="not_found")
    if body.state == "snoozed":
        cur.snoozed_until = body.wake_at or (datetime.utcnow() + timedelta(days=7))
        cur.state = "snoozed"
    else:
        cur.state = body.state
    db.commit()
    db.add(
        AuditEvent(
            actor="user",
            originating_event_id=cur.id,
            kind="event.state_changed",
            subject_ref=cur.subject_ref,
            transition={"to": body.state},
        )
    )
    db.commit()
    return {"ok": True}


def _empty_counts() -> dict[str, int]:
    return {"all": 0, "money": 0, "projects": 0, "contracts": 0, "time": 0}


def _compute_counts(db: Session) -> dict[str, int]:
    counts = _empty_counts()
    rows = db.execute(
        select(Event.type, func.count())
        .where(Event.state.in_(["unread", "read"]))
        .group_by(Event.type)
    ).all()
    for type_, n in rows:
        counts["all"] += int(n)
        for pill, types in TYPE_GROUPS.items():
            if pill == "all":
                continue
            if type_ in types:
                counts[pill] += int(n)
    return counts
