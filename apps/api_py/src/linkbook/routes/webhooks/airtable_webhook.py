"""§4.4 — Airtable webhook."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ...config import load_config
from ...db import get_session
from ...ingestion import IngestInput, ingest_event
from ...lib.log import app_logger

router = APIRouter()


class _Event(BaseModel):
    type: Literal["record.updated", "project.status_stale"]
    payload: dict[str, Any]


class _Body(BaseModel):
    event: _Event


@router.post("/webhooks/airtable")
async def airtable(body: _Body, db: Session = Depends(get_session)) -> dict[str, bool]:
    cfg = load_config()
    log = app_logger()
    e = body.event
    if e.type == "project.status_stale":
        p = e.payload
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="airtable",
                type="project.status_stale",
                subject_ref=f"project:{p['project_id']}",
                occurred_at=datetime.utcnow(),
                payload=p,
                dedupe_key=f"stale:{p['days_silent']}",
            ),
        )
    return {"ok": True}
