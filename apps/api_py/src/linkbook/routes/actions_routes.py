"""§2 — Actions routes (queue + per-action lifecycle)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import and_, desc, func, select, update
from sqlalchemy.orm import Session

from ..actions.execute import execute_action
from ..actions.queue import enqueue_send_delay, is_queueable
from ..actions.undo import undo_action
from ..config import load_config
from ..db import get_session
from ..db.models import Action, ActionLeg, AuditEvent
from ..idempotency import compute_idempotency_key
from ..lib.log import app_logger
from .inbox_routes import _serialize_action

router = APIRouter()


@router.get("/actions")
async def list_actions(
    status: Literal["open", "failed", "done", "all"] = "open",
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    if status == "open":
        where = Action.status.in_(["drafted", "queued_30s", "approved", "executing"])
    elif status == "failed":
        where = Action.status == "failed"
    elif status == "done":
        where = Action.status.in_(["succeeded", "undone", "cancelled"])
    else:
        where = True  # noqa: E712
    rows = (
        db.execute(select(Action).where(where).order_by(desc(Action.created_at)))
        .scalars()
        .all()
    )
    stats = _queue_stats(db)
    return {"actions": [_serialize_action(a) for a in rows], "stats": stats}


@router.get("/actions/{action_id}")
async def get_action(action_id: str, db: Session = Depends(get_session)) -> dict[str, Any]:
    a = db.get(Action, action_id)
    if a is None:
        raise HTTPException(status_code=404, detail="not_found")
    legs = (
        db.execute(select(ActionLeg).where(ActionLeg.action_id == action_id).order_by(ActionLeg.order))
        .scalars()
        .all()
    )
    audit = (
        db.execute(
            select(AuditEvent)
            .where(AuditEvent.subject_ref == a.subject_ref)
            .order_by(desc(AuditEvent.created_at))
        )
        .scalars()
        .all()
    )
    return {
        "action": _serialize_action(a),
        "legs": [
            {
                "id": l.id,
                "action_id": l.action_id,
                "order": l.order,
                "target": l.target,
                "idempotency_key": l.idempotency_key,
                "params": l.params,
                "status": l.status,
                "error": l.error,
                "executed_at": l.executed_at.isoformat() + "Z" if l.executed_at else None,
                "created_at": l.created_at.isoformat() + "Z",
            }
            for l in legs
        ],
        "audit": [
            {
                "id": e.id,
                "actor": e.actor,
                "action_id": e.action_id,
                "originating_event_id": e.originating_event_id,
                "kind": e.kind,
                "idempotency_key": e.idempotency_key,
                "subject_ref": e.subject_ref,
                "request": e.request,
                "response": e.response,
                "http_status": e.http_status,
                "transition": e.transition,
                "note": e.note,
                "created_at": e.created_at.isoformat() + "Z",
            }
            for e in audit
        ],
    }


@router.post("/actions/{action_id}/approve")
async def approve_action(
    action_id: str, request: Request, db: Session = Depends(get_session)
) -> Any:
    a = db.get(Action, action_id)
    if a is None:
        raise HTTPException(status_code=404, detail="not_found")
    if a.status != "drafted":
        raise HTTPException(status_code=409, detail={"error": "not_drafted", "status": a.status})

    cfg = load_config()
    log = app_logger()
    if is_queueable(a.type):
        await enqueue_send_delay(db, action_id)
        return {"ok": True, "status": "queued_30s"}

    result = await execute_action(cfg, db, log, a)
    if result.ok and result.status == "cancelled":
        return {"ok": True, "status": "cancelled", "reason": result.reason}
    if result.ok:
        return {"ok": True, "status": "succeeded", "undo_token": result.undo_token}
    raise HTTPException(status_code=502, detail={"error": "execute_failed", "detail": result.error})


@router.post("/actions/{action_id}/retry")
async def retry_action(action_id: str, db: Session = Depends(get_session)) -> Any:
    a = db.get(Action, action_id)
    if a is None:
        raise HTTPException(status_code=404, detail="not_found")
    if a.status != "failed":
        raise HTTPException(status_code=409, detail={"error": "not_failed", "status": a.status})
    cfg = load_config()
    log = app_logger()
    result = await execute_action(cfg, db, log, a)
    if result.ok and result.status == "cancelled":
        return {"ok": True, "status": "cancelled", "reason": result.reason}
    if result.ok:
        return {"ok": True, "status": "succeeded", "undo_token": result.undo_token}
    raise HTTPException(status_code=502, detail={"error": "retry_failed", "detail": result.error})


class EditBody(BaseModel):
    params: dict[str, Any]


@router.post("/actions/{action_id}/edit")
async def edit_action(
    action_id: str, body: EditBody, db: Session = Depends(get_session)
) -> dict[str, Any]:
    a = db.get(Action, action_id)
    if a is None:
        raise HTTPException(status_code=404, detail="not_found")
    if a.status != "drafted":
        raise HTTPException(status_code=409, detail={"error": "not_drafted"})
    new_key = compute_idempotency_key(a.type, a.subject_ref, body.params)  # type: ignore[arg-type]
    a.params = body.params
    a.idempotency_key = new_key
    db.commit()
    return {"ok": True, "idempotency_key": new_key}


@router.post("/actions/{action_id}/reject")
async def reject_action(action_id: str, db: Session = Depends(get_session)) -> dict[str, bool]:
    # CAS-guarded: drafted → cancelled.
    res = db.execute(
        update(Action)
        .where(and_(Action.id == action_id, Action.status == "drafted"))
        .values(status="cancelled", updated_at=datetime.utcnow())
    )
    db.commit()
    if (res.rowcount or 0) == 0:
        cur = db.get(Action, action_id)
        if cur is None:
            raise HTTPException(status_code=404, detail="not_found")
        raise HTTPException(status_code=409, detail={"error": "not_drafted", "status": cur.status})
    a = db.get(Action, action_id)
    db.add(
        AuditEvent(
            actor="user",
            action_id=action_id,
            originating_event_id=a.originating_event_id if a else None,
            kind="action.rejected",
            idempotency_key=a.idempotency_key if a else None,
            subject_ref=a.subject_ref if a else "",
        )
    )
    db.commit()
    return {"ok": True}


@router.post("/actions/{action_id}/undo")
async def undo_action_route(action_id: str, db: Session = Depends(get_session)) -> Any:
    cfg = load_config()
    log = app_logger()
    result = await undo_action(cfg, db, log, action_id)
    if result.ok:
        return {"ok": True, "method": result.method}
    raise HTTPException(status_code=409, detail={"reason": result.reason, "detail": result.detail})


def _queue_stats(db: Session) -> dict[str, int]:
    def count_where(where: Any) -> int:
        return int(db.execute(select(func.count()).select_from(Action).where(where)).scalar_one())

    return {
        "open": count_where(Action.status.in_(["drafted", "queued_30s", "approved", "executing"])),
        "in_flight": count_where(Action.status.in_(["queued_30s", "executing"])),
        "failed_today": count_where(Action.status == "failed"),
        "done_today": count_where(Action.status.in_(["succeeded", "undone", "cancelled"])),
    }
