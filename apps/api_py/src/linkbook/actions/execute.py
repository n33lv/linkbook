"""§2.4 — execute an approved action.

Phases:
  1. Re-fetch subject state (§5.3 hallucination guard).
  2. Dispatch per type.
  3. Persist audit_event with request + response (§2.6).
  4. Update status; auto-resolve originating event if appropriate.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action, ActionLeg, AuditEvent, Event, IntegrationConnection
from ..integrations.airtable import create_airtable_client
from ..integrations.dropboxsign import create_dropboxsign_client
from ..integrations.gmail import create_gmail_client
from ..integrations.harvest import create_harvest_client
from ..integrations.qbo import create_qbo_client
from ..lib.log import AppLogger

MAX_BODY_LEN = 4_000

# §2.3 — actions that mutate source state, such that a pending event for
# the same subject_ref is no longer applicable.
SOURCE_MUTATING = {
    "payment.apply",
    "invoice.mark_paid_manual",
    "project.update_status",
    "project.kickoff",
    "project.mark_complete",
}


@dataclass
class DispatchTrace:
    request: Any
    response: Any
    http_status: int | None


@dataclass
class ExecuteSucceeded:
    ok: Literal[True] = True
    status: Literal["succeeded"] = "succeeded"
    undo_token: str | None = None


@dataclass
class ExecuteCancelled:
    reason: str
    ok: Literal[True] = True
    status: Literal["cancelled"] = "cancelled"


@dataclass
class ExecuteFailed:
    error: str
    http_status: int | None
    ok: Literal[False] = False


ExecuteResult = ExecuteSucceeded | ExecuteCancelled | ExecuteFailed


@dataclass
class ExecuteOptions:
    already_executing: bool = False


def _connection(db: Session, source: str) -> IntegrationConnection | None:
    return db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == source)
    ).scalar_one_or_none()


def _redact(value: Any, depth: int = 0) -> Any:
    """Recursive secret-key masking. Bounded depth + string length."""
    import re

    if depth > 6:
        return "[truncated:depth]"
    if value is None:
        return value
    if isinstance(value, str):
        return value[:MAX_BODY_LEN] + "…" if len(value) > MAX_BODY_LEN else value
    if isinstance(value, list):
        return [_redact(v, depth + 1) for v in value]
    if isinstance(value, dict):
        out = {}
        secret_re = re.compile(r"auth|secret|token|password|key|cookie|bearer", re.I)
        for k, v in value.items():
            if secret_re.search(k):
                out[k] = "[redacted]"
            else:
                out[k] = _redact(v, depth + 1)
        return out
    return value


def _set_action_status(
    db: Session,
    action_id: str,
    status: str,
    *,
    executed_at: datetime | None = None,
    undo_token: str | None = None,
    queued_until: datetime | None = None,
) -> None:
    a = db.get(Action, action_id)
    if a is None:
        return
    a.status = status
    if executed_at is not None:
        a.executed_at = executed_at
    if undo_token is not None:
        a.undo_token = undo_token
    if queued_until is not None:
        a.queued_until = queued_until
    db.commit()


def _write_audit(db: Session, **fields: Any) -> None:
    db.add(AuditEvent(**fields))
    db.commit()


def _auto_resolve_events_for_subject(db: Session, subject_ref: str, reason: str) -> int:
    rows = db.execute(
        select(Event).where(Event.subject_ref == subject_ref, Event.state.in_(["unread", "read", "waiting"]))
    ).scalars().all()
    for r in rows:
        r.state = "done"
        db.add(
            AuditEvent(
                actor="system",
                originating_event_id=r.id,
                kind="event.auto_resolved",
                subject_ref=r.subject_ref,
                note=reason,
            )
        )
    db.commit()
    return len(rows)


# ------------------------- entry -------------------------


async def execute_action(
    cfg: AppConfig,
    db: Session,
    log: AppLogger,
    action: Action,
    options: ExecuteOptions | None = None,
) -> ExecuteResult:
    options = options or ExecuteOptions()
    log.info({"action_id": action.id, "type": action.type}, "executing action")

    # 1. Hallucination guard for invoice.remind.
    if action.type == "invoice.remind":
        params = action.params
        ok = await _reverify_invoice_still_overdue(cfg, db, log, params["invoice_id"])
        if not ok[0]:
            _set_action_status(db, action.id, "cancelled")
            _write_audit(
                db,
                actor="system",
                action_id=action.id,
                originating_event_id=action.originating_event_id,
                kind="action.cancelled",
                idempotency_key=action.idempotency_key,
                subject_ref=action.subject_ref,
                note=f"hallucination guard: {ok[1]}",
            )
            _auto_resolve_events_for_subject(db, action.subject_ref, ok[1])
            return ExecuteCancelled(reason=ok[1])

    # 2. Mark executing (unless caller already did via CAS).
    if not options.already_executing:
        _set_action_status(db, action.id, "executing", executed_at=datetime.utcnow())
        _write_audit(
            db,
            actor="system",
            action_id=action.id,
            originating_event_id=action.originating_event_id,
            kind="action.executing",
            idempotency_key=action.idempotency_key,
            subject_ref=action.subject_ref,
        )

    # 3. Dispatch.
    try:
        undo_token: str | None = None
        trace = DispatchTrace(request=None, response=None, http_status=None)
        t = action.type
        if t == "invoice.remind":
            trace = await _dispatch_invoice_remind(cfg, db, action)
            undo_token = f"compensating:{action.id}"
        elif t == "invoice.send":
            trace = await _dispatch_invoice_send(cfg, db, action)
        elif t == "invoice.mark_paid_manual":
            trace = await _dispatch_invoice_mark_paid(cfg, db, action)
            undo_token = f"compensating:{action.id}"
        elif t == "payment.apply":
            trace = await _dispatch_payment_apply(cfg, db, action)
            undo_token = f"compensating:{action.id}"
        elif t == "contract.send_reminder":
            trace = await _dispatch_contract_reminder(cfg, db, action)
        elif t == "contract.create_from_template":
            trace = await _dispatch_contract_create(cfg, db, action)
        elif t == "project.kickoff":
            await _dispatch_kickoff(cfg, db, log, action)
            undo_token = f"true_undo:{action.id}"
        elif t == "project.update_status":
            trace = await _dispatch_project_update(cfg, db, action)
            undo_token = f"true_undo:{action.id}"
        elif t == "time.self_nudge":
            trace = await _dispatch_self_nudge(action)
        elif t == "time.log_entry":
            trace = await _dispatch_log_time(cfg, db, action)
            undo_token = f"true_undo:{action.id}"
        elif t == "email.send_draft":
            trace = await _dispatch_email_send(cfg, db, action)
        elif t in (
            "task.create",
            "event.snooze",
            "event.dismiss",
            "event.mark_done",
            "project.mark_complete",
        ):
            pass
        else:
            raise RuntimeError(f"unhandled action type {t}")

        _set_action_status(db, action.id, "succeeded", undo_token=undo_token)
        _write_audit(
            db,
            actor="system",
            action_id=action.id,
            originating_event_id=action.originating_event_id,
            kind="action.succeeded",
            idempotency_key=action.idempotency_key,
            subject_ref=action.subject_ref,
            request=trace.request if isinstance(trace.request, dict) else (
                {"value": trace.request} if trace.request is not None else None
            ),
            response=_redact(trace.response) if trace.response is not None else None,
            http_status=str(trace.http_status) if trace.http_status is not None else None,
        )

        # §2.3 auto-resolve only on source-mutating action types.
        if action.originating_event_id and action.type in SOURCE_MUTATING:
            _auto_resolve_events_for_subject(
                db, action.subject_ref, f"action {action.type} succeeded"
            )

        return ExecuteSucceeded(undo_token=undo_token)
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        status = getattr(err, "status", None)
        body = getattr(err, "body", None)
        _set_action_status(db, action.id, "failed")
        _write_audit(
            db,
            actor="system",
            action_id=action.id,
            originating_event_id=action.originating_event_id,
            kind="action.failed",
            idempotency_key=action.idempotency_key,
            subject_ref=action.subject_ref,
            response=_redact(body) if body is not None else None,
            http_status=str(status) if status is not None else None,
            note=msg,
        )
        # Emit action.failed event.
        from .. import ingestion

        await ingestion.ingest_event(
            cfg,
            db,
            log,
            ingestion.IngestInput(
                source="linkbook",
                type="action.failed",
                subject_ref=f"action:{action.id}",
                occurred_at=datetime.utcnow(),
                payload={
                    "action_id": action.id,
                    "action_type": action.type,
                    "error": msg,
                    "http_status": status,
                },
                dedupe_key=f"{action.id}:fail",
            ),
        )
        return ExecuteFailed(error=msg, http_status=status)


# ------------------------- per-type -------------------------


async def _dispatch_invoice_remind(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "gmail")
    if conn is None:
        raise RuntimeError("gmail integration not connected")
    client = create_gmail_client(cfg, conn)
    p = action.params
    req = {"to": p["recipient"], "cc": p.get("cc", []), "subject": p["subject"], "thread_id": None}
    resp = await client.send({**req, "body": p["body"]})
    return DispatchTrace(request=req, response=resp, http_status=200)


async def _dispatch_invoice_send(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "harvest")
    if conn is None:
        raise RuntimeError("harvest integration not connected")
    client = create_harvest_client(cfg, conn)
    resp = await client.send_invoice(action.params["harvest_invoice_id"])
    return DispatchTrace(request=action.params, response=resp, http_status=201)


async def _dispatch_invoice_mark_paid(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "qbo")
    if conn is None:
        raise RuntimeError("qbo integration not connected")
    client = create_qbo_client(cfg, conn)
    req = {"invoice_id": action.params["invoice_id"], "mark": "paid"}
    resp = await client.update_invoice(req)
    return DispatchTrace(request=req, response=resp, http_status=200)


async def _dispatch_payment_apply(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "qbo")
    if conn is None:
        raise RuntimeError("qbo integration not connected")
    client = create_qbo_client(cfg, conn)
    resp = await client.apply_payment(action.params)
    return DispatchTrace(request=action.params, response=resp, http_status=200)


async def _dispatch_contract_reminder(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "dropboxsign")
    if conn is None:
        raise RuntimeError("dropbox sign not connected")
    client = create_dropboxsign_client(cfg, conn)
    resp = await client.send_reminder(action.params["signature_request_id"])
    return DispatchTrace(request=action.params, response=resp, http_status=200)


async def _dispatch_contract_create(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "dropboxsign")
    if conn is None:
        raise RuntimeError("dropbox sign not connected")
    client = create_dropboxsign_client(cfg, conn)
    req = {**action.params, "title": "New Agreement"}
    resp = await client.send_from_template(req)
    return DispatchTrace(request=req, response=resp, http_status=201)


async def _dispatch_project_update(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "airtable")
    if conn is None:
        raise RuntimeError("airtable not connected")
    client = create_airtable_client(cfg, conn)
    meta = conn.metadata_ or {}
    base_id = meta.get("base_id", "app_demo")
    table_id = meta.get("projects_table_id", "tbl_projects")
    p = action.params
    resp = await client.update_record(base_id, table_id, p["airtable_record_id"], {"Status": p["new_status"]})
    return DispatchTrace(request={**p, "baseId": base_id, "tableId": table_id}, response=resp, http_status=200)


async def _dispatch_self_nudge(action: Action) -> DispatchTrace:
    from ..integrations.mocks.store import get_mock_store
    from datetime import timezone as _tz

    store = get_mock_store()
    p = action.params
    store.sent_emails.append(
        {
            "to": "slack:self",
            "cc": [],
            "subject": "Linkbook · self-nudge",
            "body": p["message"],
            "thread_id": None,
            "at": datetime.now(_tz.utc).isoformat(),
        }
    )
    return DispatchTrace(request=p, response={"delivered": "slack-mock"}, http_status=200)


async def _dispatch_log_time(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "harvest")
    if conn is None:
        raise RuntimeError("harvest not connected")
    client = create_harvest_client(cfg, conn)
    p = action.params
    req = {
        "user_id": "me",
        "project_id": p["harvest_project_id"],
        "date": p["date"],
        "hours": p["hours"],
        "notes": p.get("notes"),
    }
    resp = await client.log_time_entry(req)
    return DispatchTrace(request=req, response=resp, http_status=201)


async def _dispatch_email_send(cfg: AppConfig, db: Session, action: Action) -> DispatchTrace:
    conn = _connection(db, "gmail")
    if conn is None:
        raise RuntimeError("gmail not connected")
    client = create_gmail_client(cfg, conn)
    p = action.params
    req = {"to": p["recipient"], "cc": p.get("cc", []), "subject": p["subject"], "thread_id": p.get("thread_id")}
    resp = await client.send({**req, "body": p["body"]})
    return DispatchTrace(request=req, response=resp, http_status=200)


async def _dispatch_kickoff(
    cfg: AppConfig, db: Session, log: AppLogger, action: Action
) -> None:
    legs = db.execute(
        select(ActionLeg).where(ActionLeg.action_id == action.id).order_by(ActionLeg.order)
    ).scalars().all()
    for leg in legs:
        if leg.status == "succeeded":
            continue

        # §2.5 — gmail leg goes through the 30s soft-undo queue as a
        # separate queueable email.send_draft action.
        if leg.target == "gmail:draft_welcome":
            await _spawn_email_leg_as_queued(db, action, leg)
            leg.status = "succeeded"
            leg.executed_at = datetime.utcnow()
            db.commit()
            continue

        leg.status = "executing"
        db.commit()
        try:
            trace = await _run_leg(cfg, db, leg.target, leg.params)
            leg.status = "succeeded"
            leg.executed_at = datetime.utcnow()
            db.commit()
            _write_audit(
                db,
                actor="system",
                action_id=action.id,
                kind="leg.succeeded",
                idempotency_key=leg.idempotency_key,
                subject_ref=action.subject_ref,
                request=trace.request if isinstance(trace.request, dict) else None,
                response=_redact(trace.response) if trace.response is not None else None,
                http_status=str(trace.http_status) if trace.http_status is not None else None,
                note=leg.target,
            )
        except Exception as e:  # noqa: BLE001
            leg.status = "failed"
            leg.error = str(e)
            db.commit()
            _write_audit(
                db,
                actor="system",
                action_id=action.id,
                kind="leg.failed",
                idempotency_key=leg.idempotency_key,
                subject_ref=action.subject_ref,
                response=_redact(getattr(e, "body", None)) if getattr(e, "body", None) is not None else None,
                http_status=(
                    str(getattr(e, "status", "")) if getattr(e, "status", None) is not None else None
                ),
                note=f"{leg.target}: {e}",
            )
            raise


async def _spawn_email_leg_as_queued(
    db: Session, parent: Action, leg: ActionLeg
) -> None:
    from .queue import enqueue_send_delay

    p = leg.params
    a = Action(
        type="email.send_draft",
        params={
            "recipient": p["recipient"],
            "cc": [],
            "subject": p["subject"],
            "body": p["body"],
            "thread_id": p.get("thread_id"),
        },
        mode="proposed",
        drafted_by=parent.drafted_by,
        status="drafted",
        reversal_class="no_undo",
        idempotency_key=leg.idempotency_key,
        preview=p["body"],
        originating_event_id=parent.originating_event_id,
        subject_ref=parent.subject_ref,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    await enqueue_send_delay(db, a.id)


async def _run_leg(
    cfg: AppConfig, db: Session, target: str, params: dict[str, Any]
) -> DispatchTrace:
    if target == "harvest:create_project":
        conn = _connection(db, "harvest")
        if conn is None:
            raise RuntimeError("harvest not connected")
        client = create_harvest_client(cfg, conn)
        resp = await client.create_project(params)
        return DispatchTrace(request=params, response=resp, http_status=201)
    if target == "airtable:insert_record":
        conn = _connection(db, "airtable")
        if conn is None:
            raise RuntimeError("airtable not connected")
        client = create_airtable_client(cfg, conn)
        meta = conn.metadata_ or {}
        base_id = meta.get("base_id", "app_demo")
        table_id = meta.get("projects_table_id", "tbl_projects")
        fields = params.get("fields") or params
        resp = await client.create_records(base_id, table_id, [{"fields": fields}])
        return DispatchTrace(request={"baseId": base_id, "tableId": table_id, "fields": fields}, response=resp, http_status=200)
    if target == "drive:create_folder":
        from datetime import timezone as _tz

        from ..integrations.mocks.store import get_mock_store

        store = get_mock_store()
        store.drive_folders.append(
            {"path": params["path"], "created_at": datetime.now(_tz.utc).isoformat()}
        )
        return DispatchTrace(request={"path": params["path"]}, response={"created": True}, http_status=200)
    raise RuntimeError(f"unhandled leg target: {target}")


# ------------------------- hallucination guard -------------------------


async def _reverify_invoice_still_overdue(
    cfg: AppConfig, db: Session, log: AppLogger, invoice_id: str
) -> tuple[bool, str]:
    """§5.3 — single-invoice GET against QBO. On any error, treat as
    'still overdue' and let the dispatch surface real issues."""
    conn = _connection(db, "qbo")
    if conn is None:
        return True, ""
    try:
        client = create_qbo_client(cfg, conn)
        inv = await client.get_invoice(invoice_id)
        if inv is None:
            return True, ""
        if inv["status"] == "paid":
            return False, "invoice paid externally"
        if inv["status"] == "voided":
            return False, "invoice voided"
    except Exception as e:  # noqa: BLE001
        log.warn({"err": str(e), "invoice_id": invoice_id}, "reverify failed; proceeding")
    return True, ""


async def _yield() -> None:
    """Test seam — lets the event loop drain."""
    await asyncio.sleep(0)
