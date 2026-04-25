"""§5.3 — Cash Chaser. Drafts tone-scaled reminder emails."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action, AuditEvent
from ..idempotency import compute_idempotency_key, find_duplicate_in_window
from ..lib.log import AppLogger
from ..types import ACTION_CATALOG
from .runtime import ProposeRequest, get_agentspan_client, propose_with_fallback

VERSION = "v1.0"


async def run_cash_chaser(
    event: dict[str, Any], cfg: AppConfig, db: Session, log: AppLogger
) -> None:
    if event["type"] not in (
        "invoice.overdue",
        "invoice.aging_30",
        "invoice.aging_60",
        "invoice.aging_90",
    ):
        return

    client = get_agentspan_client(cfg)
    result = await propose_with_fallback(
        client,
        ProposeRequest(
            agent="cash_chaser", agent_version=VERSION, event=event, context={}
        ),
        log,
    )
    if not result.ok:
        return  # fallback path; spec leaves this manual

    days = event["payload"]["days_overdue"]
    tone = "final" if days >= 60 else "firm" if days >= 30 else "polite"
    recipient = "client@example.com"  # TODO(integrations:gmail): real lookup
    invoice_id = event["payload"]["invoice_id"]
    subject = (
        f"Invoice {invoice_id} — "
        + ("a friendly reminder" if tone == "polite" else "second notice" if tone == "firm" else "urgent reminder")
    )
    body = _render_body(tone, event, cfg.DEV_PRINCIPAL_NAME)

    params = {
        "invoice_id": invoice_id,
        "recipient": recipient,
        "cc": [],
        "tone": tone,
        "subject": subject,
        "body": body,
    }
    idem = compute_idempotency_key("invoice.remind", event["subject_ref"], params)
    dup = find_duplicate_in_window(db, idem)
    if dup is not None:
        log.info({"idem": idem, "prior": dup.id}, "cash chaser: duplicate within 24h, skipping")
        return

    proposal = result.proposal
    db.add(
        Action(
            type="invoice.remind",
            params=params,
            mode="proposed",
            drafted_by=f"agent:cash_chaser@{VERSION}",
            status="drafted",
            reversal_class=ACTION_CATALOG["invoice.remind"].reversal_class,
            idempotency_key=idem,
            agent_confidence=str(proposal.confidence),
            agent_rationale=proposal.rationale,
            preview=body,
            originating_event_id=event["id"],
            subject_ref=event["subject_ref"],
        )
    )
    db.add(
        AuditEvent(
            actor=f"agent:cash_chaser@{VERSION}",
            originating_event_id=event["id"],
            kind="agent.proposed",
            idempotency_key=idem,
            subject_ref=event["subject_ref"],
            note=proposal.rationale,
        )
    )
    db.commit()


def _render_body(tone: str, e: dict[str, Any], sign_off: str) -> str:
    p = e["payload"]
    days = p["days_overdue"]
    amt = f"{p['amount_cents'] / 100:.2f}"
    inv = p["invoice_id"]
    if tone == "polite":
        return (
            f"Hi,\n\nQuick note that invoice {inv} (${amt}) is now {days} days past due. "
            f"Could you take a look when you get a moment?\n\nThanks,\n{sign_off}"
        )
    if tone == "firm":
        return (
            f"Hi,\n\nWe sent invoice {inv} (${amt}) and a follow-up without a response. "
            f"The invoice is now {days} days past due. Could you let me know whether this is "
            f"in process, or if there's a question on our end? Happy to jump on a call.\n\nThanks,\n{sign_off}"
        )
    return (
        f"Hi,\n\nInvoice {inv} (${amt}) is now {days} days past due. We need to resolve this "
        f"— please reply today or let me know a date you can pay by.\n\n{sign_off}"
    )
