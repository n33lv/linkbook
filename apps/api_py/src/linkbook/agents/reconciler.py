"""§5.3 — Reconciler. Proposes payment.apply only at >= 0.85 confidence
AND when there is exactly one candidate. Otherwise leaves the event
manual.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action, AuditEvent
from ..idempotency import compute_idempotency_key, find_duplicate_in_window
from ..lib.log import AppLogger
from ..types import ACTION_CATALOG, RECONCILER_CONFIDENCE_THRESHOLD
from .runtime import ProposeRequest, get_agentspan_client, propose_with_fallback

VERSION = "v1.0"


async def run_reconciler(
    event: dict[str, Any], cfg: AppConfig, db: Session, log: AppLogger
) -> None:
    if event["type"] != "payment.received_unapplied":
        return

    p = event["payload"]
    candidates = p.get("candidate_invoice_ids") or []

    client = get_agentspan_client(cfg)
    result = await propose_with_fallback(
        client,
        ProposeRequest(
            agent="reconciler",
            agent_version=VERSION,
            event=event,
            context={"candidate_invoice_ids": candidates},
        ),
        log,
    )
    if not result.ok:
        return
    if result.proposal.confidence < RECONCILER_CONFIDENCE_THRESHOLD:
        log.info(
            {
                "confidence": result.proposal.confidence,
                "threshold": RECONCILER_CONFIDENCE_THRESHOLD,
            },
            "reconciler below threshold — leaving as manual event",
        )
        return
    # Multi-candidate auto-apply is the failure mode that breaks
    # accountant trust. Only auto-propose when exactly one candidate.
    if len(candidates) != 1:
        log.info({"candidates": len(candidates)}, "reconciler: not exactly one candidate")
        return

    target_invoice_id = candidates[0]
    params = {
        "payment_id": p["qbo_payment_id"],
        "invoice_id": target_invoice_id,
        "amount_cents": p["amount_cents"],
    }
    idem = compute_idempotency_key("payment.apply", event["subject_ref"], params)
    dup = find_duplicate_in_window(db, idem)
    if dup is not None:
        log.info({"idem": idem, "prior": dup.id}, "reconciler: duplicate within 24h, skipping")
        return

    db.add(
        Action(
            type="payment.apply",
            params=params,
            mode="proposed",
            drafted_by=f"agent:reconciler@{VERSION}",
            status="drafted",
            reversal_class=ACTION_CATALOG["payment.apply"].reversal_class,
            idempotency_key=idem,
            agent_confidence=str(result.proposal.confidence),
            agent_rationale=result.proposal.rationale,
            preview=f"Apply ${params['amount_cents'] / 100:.2f} to {target_invoice_id}",
            originating_event_id=event["id"],
            subject_ref=event["subject_ref"],
        )
    )
    db.add(
        AuditEvent(
            actor=f"agent:reconciler@{VERSION}",
            originating_event_id=event["id"],
            kind="agent.proposed",
            idempotency_key=idem,
            subject_ref=event["subject_ref"],
            note=result.proposal.rationale,
        )
    )
    db.commit()
