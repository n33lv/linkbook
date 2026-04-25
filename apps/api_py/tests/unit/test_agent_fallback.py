"""Unit — §5.3 agent fallback after 2 malformed responses."""

from datetime import datetime
from typing import Any

import pytest

from linkbook.agents.runtime import ProposeRequest, propose_with_fallback
from linkbook.lib.log import app_logger


_BASE_EVENT: dict[str, Any] = {
    "event_id": "00000000-0000-0000-0000-000000000001",
    "id": "00000000-0000-0000-0000-000000000001",
    "source": "qbo",
    "type": "invoice.aging_60",
    "subject_ref": "invoice:1",
    "occurred_at": datetime.utcnow(),
    "ingested_at": datetime.utcnow(),
    "priority_score": 50,
    "state": "unread",
    "suggested_actions": [],
    "dedupe_key": "d",
    "thread_id": None,
    "payload": {
        "invoice_id": "INV-1",
        "client_id": "00000000-0000-0000-0000-000000000010",
        "amount_cents": 100000,
        "currency": "USD",
        "issued_at": datetime.utcnow().isoformat(),
        "due_at": datetime.utcnow().isoformat(),
        "days_overdue": 60,
    },
}


@pytest.mark.asyncio
async def test_returns_ok_on_valid():
    class Client:
        async def propose(self, _req):
            return {
                "agent": "cash_chaser",
                "agent_version": "v1.0",
                "confidence": 0.85,
                "rationale": "good",
                "draft_action": None,
            }

    r = await propose_with_fallback(
        Client(),
        ProposeRequest(agent="cash_chaser", agent_version="v1.0", event=_BASE_EVENT, context={}),
        app_logger(),
    )
    assert r.ok is True


@pytest.mark.asyncio
async def test_falls_back_after_two_malformed():
    class Client:
        async def propose(self, _req):
            return {"totally": "wrong"}

    r = await propose_with_fallback(
        Client(),
        ProposeRequest(agent="cash_chaser", agent_version="v1.0", event=_BASE_EVENT, context={}),
        app_logger(),
    )
    assert r.ok is False
    assert r.reason == "fallback_to_manual"
    assert r.attempts == 2


@pytest.mark.asyncio
async def test_falls_back_after_two_throws():
    class Client:
        async def propose(self, _req):
            raise RuntimeError("agent down")

    r = await propose_with_fallback(
        Client(),
        ProposeRequest(agent="cash_chaser", agent_version="v1.0", event=_BASE_EVENT, context={}),
        app_logger(),
    )
    assert r.ok is False


@pytest.mark.asyncio
async def test_recovers_on_second_attempt():
    calls = {"n": 0}

    class Client:
        async def propose(self, _req):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"bad": True}
            return {
                "agent": "cash_chaser",
                "agent_version": "v1.0",
                "confidence": 0.7,
                "rationale": "recovered",
                "draft_action": None,
            }

    r = await propose_with_fallback(
        Client(),
        ProposeRequest(agent="cash_chaser", agent_version="v1.0", event=_BASE_EVENT, context={}),
        app_logger(),
    )
    assert r.ok is True
