"""§5.3 — Project Concierge. contract.signed → 4-leg kickoff composite."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action, ActionLeg, AuditEvent
from ..idempotency import compute_idempotency_key, find_duplicate_in_window
from ..lib.log import AppLogger
from ..types import ACTION_CATALOG
from .runtime import ProposeRequest, get_agentspan_client, propose_with_fallback

VERSION = "v1.0"


async def run_project_concierge(
    event: dict[str, Any], cfg: AppConfig, db: Session, log: AppLogger
) -> None:
    if event["type"] != "contract.signed":
        return

    client = get_agentspan_client(cfg)
    result = await propose_with_fallback(
        client,
        ProposeRequest(
            agent="project_concierge", agent_version=VERSION, event=event, context={}
        ),
        log,
    )
    if not result.ok:
        return

    p = event["payload"]
    project_name = f"{p['title']} — kickoff"
    params = {
        "contract_id": p["signature_request_id"],
        "client_id": p.get("client_id") or "00000000-0000-0000-0000-000000000000",
        "project_name": project_name,
        "budget_hours": 240,
        "drive_template": "retainer-brand-identity",
    }
    idem = compute_idempotency_key("project.kickoff", event["subject_ref"], params)
    dup = find_duplicate_in_window(db, idem)
    if dup is not None:
        log.info({"idem": idem, "prior": dup.id}, "concierge: duplicate within 24h, skipping")
        return

    action = Action(
        type="project.kickoff",
        params=params,
        mode="proposed",
        drafted_by=f"agent:project_concierge@{VERSION}",
        status="drafted",
        reversal_class=ACTION_CATALOG["project.kickoff"].reversal_class,
        idempotency_key=idem,
        agent_confidence=str(result.proposal.confidence),
        agent_rationale=result.proposal.rationale,
        preview=f"4-leg kickoff for {project_name}",
        originating_event_id=event["id"],
        subject_ref=event["subject_ref"],
    )
    db.add(action)
    db.flush()  # populate action.id

    # §2.4 — per-leg idempotency keys hash (action_id, target, params).
    # Legs aren't governed by the 24h rule; they only need to be unique
    # per (action_id, leg) under the action_legs unique index.
    legs: list[tuple[str, dict[str, Any]]] = [
        (
            "harvest:create_project",
            {
                "name": project_name,
                "client_id": params["client_id"],
                "budget_hours": params["budget_hours"],
            },
        ),
        (
            "airtable:insert_record",
            {
                "table": "projects",
                "fields": {"name": project_name, "status": "Kickoff"},
            },
        ),
        (
            "drive:create_folder",
            {"path": f"/clients/{params['client_id']}/{project_name}"},
        ),
        (
            "gmail:draft_welcome",
            {
                "thread_id": None,
                "recipient": "client@example.com",
                "subject": f"Welcome — {project_name}",
                "body": "Looking forward to the kickoff.",
            },
        ),
    ]
    for i, (target, leg_params) in enumerate(legs):
        leg_key = hashlib.sha256(
            f"{action.id}|{target}|{json.dumps(leg_params, sort_keys=True)}".encode()
        ).hexdigest()
        db.add(
            ActionLeg(
                action_id=action.id,
                order=i,
                target=target,
                params=leg_params,
                idempotency_key=leg_key,
            )
        )

    db.add(
        AuditEvent(
            actor=f"agent:project_concierge@{VERSION}",
            originating_event_id=event["id"],
            kind="agent.proposed",
            idempotency_key=idem,
            subject_ref=event["subject_ref"],
            note=result.proposal.rationale,
        )
    )
    db.commit()
