"""Dev/test routes — NOT mounted in production."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import load_config
from ..db import get_session
from ..db.models import Action, IntegrationConnection
from ..ingestion import IngestInput, ingest_event
from ..lib.log import app_logger

router = APIRouter()


class IngestBody(BaseModel):
    source: Literal["qbo", "harvest", "dropboxsign", "airtable", "gmail", "linkbook"]
    type: str
    subject_ref: str
    occurred_at: datetime | None = None
    payload: dict[str, Any]
    dedupe_key: str = "default"


@router.post("/dev/ingest")
async def dev_ingest(body: IngestBody, db: Session = Depends(get_session)) -> dict[str, Any]:
    cfg = load_config()
    log = app_logger()
    out = await ingest_event(
        cfg,
        db,
        log,
        IngestInput(
            source=body.source,
            type=body.type,
            subject_ref=body.subject_ref,
            occurred_at=body.occurred_at or datetime.utcnow(),
            payload=body.payload,
            dedupe_key=body.dedupe_key,
        ),
    )
    return {
        "inserted": out.inserted,
        "event_id": out.event_id,
        "priority_score": out.priority_score,
    }


@router.post("/dev/seed/connections")
async def seed_connections(db: Session = Depends(get_session)) -> dict[str, bool]:
    sources = ["qbo", "harvest", "dropboxsign", "airtable", "gmail"]
    from sqlalchemy import select

    for src in sources:
        existing = db.execute(
            select(IntegrationConnection).where(IntegrationConnection.source == src)
        ).scalar_one_or_none()
        if existing is not None:
            continue
        meta = (
            {"base_id": "app_demo", "projects_table_id": "tbl_projects"}
            if src == "airtable"
            else {}
        )
        db.add(
            IntegrationConnection(
                source=src,
                external_account_id="realm_dev" if src == "qbo" else f"{src}_acct",
                display_name=src.upper(),
                status="connected",
                access_token="dev_token",
                metadata_=meta,
            )
        )
    db.commit()
    return {"ok": True}


class RewindBody(BaseModel):
    action_id: str
    past_seconds: int = 5


@router.post("/dev/queue/rewind")
async def queue_rewind(body: RewindBody, db: Session = Depends(get_session)) -> dict[str, bool]:
    a = db.get(Action, body.action_id)
    if a is None:
        raise HTTPException(status_code=404, detail="not_found")
    a.queued_until = datetime.utcnow() - timedelta(seconds=body.past_seconds)
    db.commit()
    return {"ok": True}


@router.get("/dev/mocks")
async def dev_mocks() -> dict[str, Any]:
    from ..integrations.mocks import get_mock_store

    s = get_mock_store()
    return {
        "sent_emails": s.sent_emails,
        "contract_reminders": s.contract_reminders,
        "airtable_records": list(s.airtable_records.items()),
        "harvest_projects": list(s.harvest_projects.values()),
        "drive_folders": s.drive_folders,
        "invoices": [
            {
                "id": i.id,
                "doc_number": i.doc_number,
                "amount_cents": i.amount_cents,
                "status": i.status,
            }
            for i in s.invoices.values()
        ],
        "payments": [{"id": p.id, "amount_cents": p.amount_cents} for p in s.payments.values()],
    }


@router.post("/dev/mocks/reset")
async def dev_mocks_reset() -> dict[str, bool]:
    from ..integrations.mocks import reset_mock_store

    reset_mock_store()
    return {"ok": True}


class FailNextBody(BaseModel):
    key: str
    status: int
    body: Any | None = None


@router.post("/dev/mocks/fail-next")
async def dev_mocks_fail_next(body: FailNextBody) -> dict[str, bool]:
    from ..integrations.mocks import get_mock_store
    from ..integrations.mocks.store import FailureSpec

    get_mock_store().failures.queue_next(
        body.key, FailureSpec(status=body.status, body=body.body)
    )
    return {"ok": True}
