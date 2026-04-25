"""§5.3 — Time Sentinel. Proposes a self-nudge when < 4h logged."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action
from ..idempotency import compute_idempotency_key, find_duplicate_in_window
from ..lib.log import AppLogger
from ..types import ACTION_CATALOG
from .runtime import ProposeRequest, get_agentspan_client, propose_with_fallback

VERSION = "v1.0"


async def run_time_sentinel(
    event: dict[str, Any], cfg: AppConfig, db: Session, log: AppLogger
) -> None:
    if event["type"] != "time.missing_yesterday":
        return

    client = get_agentspan_client(cfg)
    result = await propose_with_fallback(
        client,
        ProposeRequest(
            agent="time_sentinel", agent_version=VERSION, event=event, context={}
        ),
        log,
    )
    if not result.ok:
        return

    p = event["payload"]
    msg = (
        f"You logged {p['hours_logged']}h on {p['date']}. "
        "Mind finishing your timesheet before Friday?"
    )
    params = {"message": msg}
    idem = compute_idempotency_key("time.self_nudge", event["subject_ref"], params)
    dup = find_duplicate_in_window(db, idem)
    if dup is not None:
        log.info({"idem": idem, "prior": dup.id}, "time sentinel: duplicate within 24h, skipping")
        return

    db.add(
        Action(
            type="time.self_nudge",
            params=params,
            mode="proposed",
            drafted_by=f"agent:time_sentinel@{VERSION}",
            status="drafted",
            reversal_class=ACTION_CATALOG["time.self_nudge"].reversal_class,
            idempotency_key=idem,
            agent_confidence=str(result.proposal.confidence),
            agent_rationale=result.proposal.rationale,
            preview=msg,
            originating_event_id=event["id"],
            subject_ref=event["subject_ref"],
        )
    )
    db.commit()
