"""§2.5 — three reversal classes (true_undo, compensating, no_undo) +
queued_30s cancellation. 24h compensating-undo window enforced.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action, AuditEvent, IntegrationConnection
from ..integrations.airtable import create_airtable_client
from ..integrations.qbo import create_qbo_client
from ..lib.log import AppLogger
from .queue import cancel_send_delay


@dataclass
class UndoOk:
    method: Literal["cancel_queued", "true_undo", "compensating"]
    ok: Literal[True] = True


@dataclass
class UndoFail:
    reason: Literal["no_undo", "past_window", "not_found", "integration_error"]
    detail: str
    ok: Literal[False] = False


UndoResult = UndoOk | UndoFail


async def undo_action(
    cfg: AppConfig, db: Session, log: AppLogger, action_id: str
) -> UndoResult:
    a = db.get(Action, action_id)
    if a is None:
        return UndoFail(reason="not_found", detail="action not found")

    # 1. queued_30s → cancel timer.
    if a.status == "queued_30s":
        cancelled = await cancel_send_delay(db, action_id)
        if cancelled:
            return UndoOk(method="cancel_queued")

    if a.status != "succeeded":
        return UndoFail(reason="past_window", detail=f"cannot undo from status {a.status}")

    # §2.5 — 24h window for everything reversible.
    if a.executed_at is not None:
        age = datetime.utcnow() - a.executed_at
        if age > timedelta(hours=24):
            return UndoFail(reason="past_window", detail="beyond 24h undo window")

    cls = a.reversal_class
    if cls == "no_undo":
        return UndoFail(reason="no_undo", detail="action declared no_undo at create time")

    try:
        if cls == "true_undo":
            await _apply_true_undo(cfg, db, a)
            method = "true_undo"
        elif cls == "compensating":
            await _apply_compensating(cfg, db, a)
            method = "compensating"
        else:
            return UndoFail(reason="integration_error", detail="unknown reversal class")
    except Exception as e:  # noqa: BLE001
        return UndoFail(reason="integration_error", detail=str(e))

    a.status = "undone"
    db.add(
        AuditEvent(
            actor="user",
            action_id=a.id,
            originating_event_id=a.originating_event_id,
            kind="action.undone",
            idempotency_key=a.idempotency_key,
            subject_ref=a.subject_ref,
            note=method,
        )
    )
    db.commit()
    return UndoOk(method=method)  # type: ignore[arg-type]


def _connection(db: Session, source: str) -> IntegrationConnection | None:
    from sqlalchemy import select

    return db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == source)
    ).scalar_one_or_none()


async def _apply_true_undo(cfg: AppConfig, db: Session, a: Action) -> None:
    if a.type == "project.update_status":
        conn = _connection(db, "airtable")
        if conn is None:
            raise RuntimeError("airtable not connected")
        client = create_airtable_client(cfg, conn)
        meta = conn.metadata_ or {}
        base_id = meta.get("base_id", "app_demo")
        table_id = meta.get("projects_table_id", "tbl_projects")
        await client.update_record(base_id, table_id, a.params["airtable_record_id"], {"Status": "Undone"})
        return
    if a.type in ("task.create", "time.log_entry"):
        return
    raise RuntimeError(f"true_undo not implemented for {a.type}")


async def _apply_compensating(cfg: AppConfig, db: Session, a: Action) -> None:
    if a.type == "payment.apply":
        conn = _connection(db, "qbo")
        if conn is None:
            raise RuntimeError("qbo not connected")
        client = create_qbo_client(cfg, conn)
        await client.update_invoice({"invoice_id": a.params["invoice_id"], "mark": "voided"})
        return
    if a.type == "invoice.remind":
        return
    raise RuntimeError(f"compensating not implemented for {a.type}")
