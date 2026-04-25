"""§2.5 — 30s soft-undo for email/Slack actions.

In-process v1: an asyncio task per row, persisted to actions.queued_until
so it survives restart. Race-free CAS on actions.status.
"""

from __future__ import annotations

import asyncio
import os
import random
from datetime import datetime, timedelta

from sqlalchemy import and_, select, update
from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action, AuditEvent
from ..lib.log import AppLogger

QUEUEABLE = {"invoice.remind", "email.send_draft", "time.self_nudge"}

_TIMERS: dict[str, asyncio.Task[None]] = {}


def is_queueable(type_: str) -> bool:
    return type_ in QUEUEABLE


def get_send_delay_ms() -> int:
    raw = os.environ.get("SEND_DELAY_MS")
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except ValueError:
            pass
    return 30_000


def cas_status(
    db: Session, action_id: str, *, frm: str, to: str, **fields: object
) -> int:
    """Compare-and-swap status. Returns rowcount (0 or 1)."""
    stmt = (
        update(Action)
        .where(and_(Action.id == action_id, Action.status == frm))
        .values(status=to, updated_at=datetime.utcnow(), **fields)
    )
    res = db.execute(stmt)
    db.commit()
    return res.rowcount or 0


async def enqueue_send_delay(db: Session, action_id: str) -> None:
    delay_ms = get_send_delay_ms()
    queued_until = datetime.utcnow() + timedelta(milliseconds=delay_ms)

    changed = cas_status(db, action_id, frm="drafted", to="queued_30s", queued_until=queued_until)
    if changed == 0:
        cur = db.get(Action, action_id)
        if cur is None:
            raise RuntimeError("action not found")
        if cur.status != "queued_30s":
            raise RuntimeError("action not in drafted state")
    a = db.get(Action, action_id)
    if a is None:
        return
    db.add(
        AuditEvent(
            actor="system",
            action_id=a.id,
            originating_event_id=a.originating_event_id,
            kind="action.queued",
            idempotency_key=a.idempotency_key,
            subject_ref=a.subject_ref,
        )
    )
    db.commit()
    _arm_timer(action_id, delay_ms)


def _arm_timer(action_id: str, ms: int) -> None:
    """Schedule an async task to fire when the timer elapses."""
    loop = asyncio.get_event_loop()

    async def fire() -> None:
        await asyncio.sleep(max(0, ms / 1000))
        _TIMERS.pop(action_id, None)
        # Open a fresh session — the original db session may be closed.
        from ..db import open_session
        from ..config import load_config
        from ..lib.log import app_logger

        cfg = load_config()
        log = app_logger()
        db = open_session()
        try:
            won = cas_status(
                db,
                action_id,
                frm="queued_30s",
                to="executing",
                executed_at=datetime.utcnow(),
            )
            if won == 0:
                log.info({"action_id": action_id}, "queue: timer fired but action already cancelled")
                return
            a = db.get(Action, action_id)
            if a is None:
                return
            db.add(
                AuditEvent(
                    actor="system",
                    action_id=a.id,
                    originating_event_id=a.originating_event_id,
                    kind="action.executing",
                    idempotency_key=a.idempotency_key,
                    subject_ref=a.subject_ref,
                    note="queue timer elapsed",
                )
            )
            db.commit()
            from .execute import ExecuteOptions, execute_action

            await execute_action(cfg, db, log, a, ExecuteOptions(already_executing=True))
        except Exception as e:  # noqa: BLE001
            log.error({"err": str(e), "action_id": action_id}, "queue dispatch failed")
        finally:
            db.close()

    task = loop.create_task(fire())
    _TIMERS[action_id] = task


async def cancel_send_delay(db: Session, action_id: str) -> bool:
    """§2.5 soft-undo: clicked Undo within the 30s window.

    Returns the action to `drafted` so the user can approve again or reject.
    The integration call never fired, so there's nothing to compensate.

    State transition: queued_30s → drafted (with queued_until cleared).
    """
    t = _TIMERS.pop(action_id, None)
    if t is not None:
        t.cancel()
    changed = cas_status(
        db, action_id, frm="queued_30s", to="drafted", queued_until=None
    )
    if changed == 0:
        return False
    a = db.get(Action, action_id)
    if a is None:
        return False
    db.add(
        AuditEvent(
            actor="user",
            action_id=a.id,
            originating_event_id=a.originating_event_id,
            kind="action.unqueued",
            idempotency_key=a.idempotency_key,
            subject_ref=a.subject_ref,
            note="soft-undo (30s window) — returned to drafted",
        )
    )
    db.commit()
    return True


async def recover_queue_on_boot(db: Session, log: AppLogger) -> None:
    """Boot recovery: fire past-deadline rows with random jitter; re-arm
    timers for the rest. Persistent state across restarts (§2.5)."""
    rows = db.execute(select(Action).where(Action.status == "queued_30s")).scalars().all()
    for a in rows:
        remaining_ms = (
            int((a.queued_until - datetime.utcnow()).total_seconds() * 1000)
            if a.queued_until is not None
            else 0
        )
        arm_after = remaining_ms if remaining_ms > 0 else random.randint(0, 500)
        _arm_timer(a.id, arm_after)
    if rows:
        log.info({"count": len(rows)}, "queue: recovered queued_30s actions on boot")


def clear_all_timers() -> None:
    for t in list(_TIMERS.values()):
        t.cancel()
    _TIMERS.clear()
