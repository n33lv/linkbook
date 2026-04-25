"""§4.5 — Gmail Pub/Sub push receiver (mock-shape body in dev)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ...config import load_config
from ...db import get_session
from ...ingestion import IngestInput, ingest_event
from ...lib.log import app_logger

router = APIRouter()


class _Payload(BaseModel):
    gmail_thread_id: str
    client_id: str
    last_inbound_at: datetime
    subject: str


class _Event(BaseModel):
    type: Literal["client_reply_awaiting"]
    payload: _Payload


class _Body(BaseModel):
    event: _Event


@router.post("/webhooks/gmail")
async def gmail(body: _Body, db: Session = Depends(get_session)) -> dict[str, bool]:
    cfg = load_config()
    log = app_logger()
    p = body.event.payload
    await ingest_event(
        cfg,
        db,
        log,
        IngestInput(
            source="gmail",
            type="email.client_reply_awaiting_response_3d",
            subject_ref=f"thread:{p.gmail_thread_id}",
            occurred_at=datetime.utcnow(),
            payload={
                "gmail_thread_id": p.gmail_thread_id,
                "client_id": p.client_id,
                "last_inbound_at": p.last_inbound_at.isoformat(),
                "subject": p.subject,
            },
            dedupe_key="3d",
        ),
    )
    return {"ok": True}
