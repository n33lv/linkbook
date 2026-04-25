"""Single funnel for every source. Webhooks + CDC + crons all build a
NewEvent shape and call ingest_event. Computes priority, dedupes,
inserts, fans out to every agent.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .agents import (
    recommended_actions_for,
    run_cash_chaser,
    run_project_concierge,
    run_reconciler,
    run_time_sentinel,
)
from .config import AppConfig
from .db.models import AuditEvent, Client, Event
from .lib.log import AppLogger
from .ranking import compute_priority_score, rank_inputs_from_event


@dataclass
class IngestInput:
    source: str
    type: str
    subject_ref: str
    occurred_at: datetime
    payload: dict[str, Any]
    dedupe_key: str


@dataclass
class IngestOutput:
    inserted: bool
    event_id: str
    priority_score: int


async def ingest_event(
    cfg: AppConfig, db: Session, log: AppLogger, input: IngestInput
) -> IngestOutput:
    # 1. Look up client tier (if payload carries client_id) for ranking.
    tier: int | None = None
    client_id = input.payload.get("client_id")
    if client_id:
        c = db.execute(select(Client).where(Client.id == client_id)).scalar_one_or_none()
        if c is not None:
            tier = c.tier

    inputs = rank_inputs_from_event(
        input.type,
        input.payload,
        client_tier=tier,
        is_blocking_other_work=False,
        days_unread_in_inbox=0,
        snooze_decay=0,
    )
    score = compute_priority_score(inputs, cfg).total

    suggested = recommended_actions_for(input.type)

    # 2. Dedupe + insert.
    existing = db.execute(
        select(Event).where(
            and_(
                Event.type == input.type,
                Event.subject_ref == input.subject_ref,
                Event.dedupe_key == input.dedupe_key,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        log.debug({"type": input.type, "subject_ref": input.subject_ref}, "event deduped")
        return IngestOutput(
            inserted=False, event_id=existing.id, priority_score=existing.priority_score
        )

    row = Event(
        source=input.source,
        type=input.type,
        subject_ref=input.subject_ref,
        occurred_at=input.occurred_at,
        payload=input.payload,
        priority_score=score,
        suggested_actions=suggested,
        dedupe_key=input.dedupe_key,
        state="unread",
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.execute(
            select(Event).where(
                and_(
                    Event.type == input.type,
                    Event.subject_ref == input.subject_ref,
                    Event.dedupe_key == input.dedupe_key,
                )
            )
        ).scalar_one()
        return IngestOutput(
            inserted=False, event_id=existing.id, priority_score=existing.priority_score
        )

    db.refresh(row)
    log.info(
        {"type": input.type, "subject_ref": input.subject_ref, "score": score},
        "event ingested",
    )

    # 3. Audit row for the ingest.
    db.add(
        AuditEvent(
            actor="system",
            originating_event_id=row.id,
            kind="event.ingested",
            subject_ref=row.subject_ref,
            note=f"score={score}",
        )
    )
    db.commit()

    # 4. Agent fan-out. Each agent gates internally on event.type.
    event_dict = _to_event_dict(row)
    results = await asyncio.gather(
        run_cash_chaser(event_dict, cfg, db, log),
        run_project_concierge(event_dict, cfg, db, log),
        run_time_sentinel(event_dict, cfg, db, log),
        run_reconciler(event_dict, cfg, db, log),
        return_exceptions=True,
    )
    for r in results:
        if isinstance(r, Exception):
            log.warn({"err": str(r)}, "agent failed during fan-out")

    return IngestOutput(inserted=True, event_id=row.id, priority_score=score)


def _to_event_dict(row: Event) -> dict[str, Any]:
    return {
        "id": row.id,
        "event_id": row.id,
        "source": row.source,
        "type": row.type,
        "subject_ref": row.subject_ref,
        "occurred_at": row.occurred_at,
        "ingested_at": row.ingested_at,
        "priority_score": row.priority_score,
        "state": row.state,
        "suggested_actions": row.suggested_actions,
        "payload": row.payload,
        "thread_id": row.thread_id,
        "dedupe_key": row.dedupe_key,
    }
