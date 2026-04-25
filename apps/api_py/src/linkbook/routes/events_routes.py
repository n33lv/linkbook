"""Ad-hoc event search."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from ..db import get_session
from ..db.models import Event
from .inbox_routes import _serialize_event

router = APIRouter()


@router.get("/events")
async def list_events(
    subject_ref: str | None = None, db: Session = Depends(get_session)
) -> dict[str, Any]:
    q = select(Event).order_by(desc(Event.occurred_at))
    if subject_ref:
        q = q.where(Event.subject_ref == subject_ref)
    rows = db.execute(q).scalars().all()
    return {"events": [_serialize_event(r, [], None) for r in rows]}
