"""§5.3 — Agentspan runtime wrapper. Stub returns plausible canned proposals
in dev; real Agentspan client wires when AGENTSPAN_BASE_URL is set.
fallback-to-Manual after two malformed attempts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from pydantic import ValidationError

from ..config import AppConfig
from ..lib.log import AppLogger
from ..types import AgentName, Proposal


@dataclass
class ProposeRequest:
    agent: AgentName
    agent_version: str
    event: dict[str, Any]  # full event row (incl. payload)
    context: dict[str, Any]


@dataclass
class ProposeOk:
    ok: bool
    proposal: Proposal


@dataclass
class ProposeFail:
    ok: bool
    reason: str
    attempts: int


ProposeResult = ProposeOk | ProposeFail


class AgentspanClient(Protocol):
    async def propose(self, req: ProposeRequest) -> Any: ...


class StubClient:
    """Dev stub. Returns deterministic plausible proposals keyed by agent
    + event type. The real Agentspan client lands here when AGENTSPAN_*
    env vars are configured."""

    async def propose(self, req: ProposeRequest) -> Any:
        agent, event = req.agent, req.event
        evt_type = event["type"]
        payload = event.get("payload", {})

        if agent == "cash_chaser" and evt_type.startswith("invoice."):
            days = payload.get("days_overdue") or 0
            return {
                "agent": agent,
                "agent_version": "v1.0",
                "confidence": min(0.92, 0.6 + days / 200),
                "rationale": (
                    "Stellate-style 62-day pattern: firm reminder usually resolves within 5 days. cc principal."
                    if days >= 60
                    else "Standard polite reminder; client typically pays after first reminder."
                ),
                "draft_action": None,
            }
        if agent == "project_concierge" and evt_type == "contract.signed":
            return {
                "agent": agent,
                "agent_version": "v1.0",
                "confidence": 0.96,
                "rationale": (
                    "Counterparty matched to existing client; Drive template applies; "
                    "4-leg kickoff is the standard pattern."
                ),
                "draft_action": None,
            }
        if agent == "reconciler" and evt_type == "payment.received_unapplied":
            cands = payload.get("candidate_invoice_ids") or []
            n = len(cands)
            conf = 0.91 if n == 1 else (0.4 if n == 0 else 0.71)
            return {
                "agent": agent,
                "agent_version": "v1.0",
                "confidence": conf,
                "rationale": (
                    "Single open invoice for this customer matches the wire amount exactly."
                    if n == 1
                    else "Multiple open invoices and amount does not match exactly — leaving for manual review."
                ),
                "draft_action": None,
            }
        if agent == "time_sentinel" and evt_type == "time.missing_yesterday":
            return {
                "agent": agent,
                "agent_version": "v1.0",
                "confidence": 0.9,
                "rationale": "Workday with under 4h logged. Self-nudge is the standard response.",
                "draft_action": None,
            }
        if agent == "triage":
            return {
                "agent": agent,
                "agent_version": "v1.0",
                "confidence": 1,
                "rationale": "Deterministic triage.",
                "draft_action": None,
            }
        return None


_client: AgentspanClient | None = None


def get_agentspan_client(_cfg: AppConfig) -> AgentspanClient:
    global _client
    if _client is None:
        _client = StubClient()
    return _client


def set_agentspan_client(c: AgentspanClient | None) -> None:
    global _client
    _client = c


async def propose_with_fallback(
    client: AgentspanClient,
    req: ProposeRequest,
    log: AppLogger,
) -> ProposeResult:
    """Two attempts; on second failure, fall back to Manual (§5.3)."""
    last_err: Exception | None = None
    for attempt in (1, 2):
        try:
            raw = await client.propose(req)
            try:
                proposal = Proposal.model_validate(raw)
                return ProposeOk(ok=True, proposal=proposal)
            except ValidationError as ve:
                last_err = ve
                log.warn(
                    {"agent": req.agent, "attempt": attempt, "issues": ve.errors()},
                    "agent returned malformed output",
                )
        except Exception as e:  # noqa: BLE001
            last_err = e
            log.warn({"agent": req.agent, "attempt": attempt, "err": str(e)}, "agent invocation threw")
    log.error({"agent": req.agent, "attempts": 2, "err": str(last_err)}, "agent fell back to Manual")
    return ProposeFail(ok=False, reason="fallback_to_manual", attempts=2)
