"""§5.3 — agent-driven dispatch path.

When USE_AGENT_DISPATCH=true and the Agentspan runtime is available,
approving an action routes through the orchestrator. We stub
`dispatch_via_agents` here so the test doesn't need a real server.

Two cases:
  1. Happy: orchestrator returns ok=True with a tool-call trace; action
     transitions to succeeded; audit row records the trace.
  2. Fallback: orchestrator returns fallback_to_manual=True; an
     `agent.needs_approval` event lands in the inbox AND the manual
     dispatcher takes over (so the work still gets done).

Note: project.kickoff is intentionally NOT routed through the agent
(see execute.py — composite actions stay on the deterministic 4-leg
manual dispatcher). We use payment.apply here, which is a single-source
qbo action and exercises the agent path.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from linkbook.orchestrator import runtime as orch_runtime


async def _seed_payment_apply_action(ac, subject_ref: str = "payment:test_agent") -> dict[str, Any]:
    """Ingest a payment.received_unapplied with exactly one candidate so
    the reconciler proposes a high-confidence payment.apply action.
    Returns the drafted action row."""
    await ac.post("/dev/mocks/reset")
    await ac.post("/dev/seed/connections")
    # Need an invoice in the mock store the reconciler can match against.
    await ac.post(
        "/dev/ingest",
        json={
            "source": "qbo",
            "type": "invoice.aging_30",
            "subject_ref": "invoice:test_agent_inv",
            "payload": {
                "invoice_id": "test_agent_inv",
                "client_id": "00000000-0000-0000-0000-000000000010",
                "amount_cents": 100_000,
                "currency": "USD",
                "issued_at": "2026-04-01T00:00:00Z",
                "due_at": "2026-04-15T00:00:00Z",
                "days_overdue": 30,
            },
            "dedupe_key": "agent_inv",
        },
    )
    await ac.post(
        "/dev/ingest",
        json={
            "source": "qbo",
            "type": "payment.received_unapplied",
            "subject_ref": subject_ref,
            "payload": {
                "qbo_payment_id": "pay_test_agent",
                "customer_name_raw": "Stellate Studios",
                "amount_cents": 100_000,
                "received_at": "2026-04-25T00:00:00Z",
                # Exactly 1 candidate → reconciler proposes apply at high confidence.
                "candidate_invoice_ids": ["test_agent_inv"],
            },
            "dedupe_key": "agent_pay",
        },
    )
    actions = (await ac.get("/actions?status=open")).json()["actions"]
    apply_action = next(a for a in actions if a["type"] == "payment.apply")
    return apply_action


@pytest.mark.asyncio
async def test_agent_dispatch_routes_through_orchestrator(app_client, monkeypatch):
    """A payment.apply approval with USE_AGENT_DISPATCH on routes the
    dispatch through the stubbed orchestrator. Audit captures the
    tool-call trace; action transitions to succeeded."""
    _app, ac = app_client

    os.environ["USE_AGENT_DISPATCH"] = "true"
    monkeypatch.setattr(orch_runtime, "is_agentspan_available", lambda _cfg: True)

    captured: dict[str, Any] = {}

    async def fake_dispatch(cfg, db, log, action):
        captured["action_type"] = action.type
        captured["subject_ref"] = action.subject_ref
        return orch_runtime.AgentDispatchResult(
            ok=True,
            summary="Applied payment via QBO (orchestrated)",
            trace=[
                {
                    "tool": "apply_payment",
                    "args": {"payment_id": "pay_test_agent", "invoice_id": "test_agent_inv"},
                    "response": {"ok": True},
                    "http_status": 200,
                },
            ],
        )

    monkeypatch.setattr(orch_runtime, "dispatch_via_agents", fake_dispatch)

    apply_action = await _seed_payment_apply_action(ac)
    res = await ac.post(f"/actions/{apply_action['id']}/approve")
    assert res.status_code == 200
    assert res.json()["status"] == "succeeded"

    # The orchestrator was called.
    assert captured["action_type"] == "payment.apply"
    assert captured["subject_ref"] == apply_action["subject_ref"]

    # Audit row from the agent path.
    detail = (await ac.get(f"/actions/{apply_action['id']}")).json()
    succeeded = next((a for a in detail["audit"] if a["kind"] == "action.succeeded"), None)
    assert succeeded is not None
    assert succeeded["actor"].startswith("agent:orchestrator")
    # The trace got persisted.
    assert succeeded["response"] is not None
    assert "tool_calls" in succeeded["response"]
    assert len(succeeded["response"]["tool_calls"]) == 1


@pytest.mark.asyncio
async def test_agent_dispatch_falls_back_to_manual_after_2_failures(app_client, monkeypatch):
    """When dispatch_via_agents returns fallback_to_manual=True, an
    `agent.needs_approval` event hits the inbox AND the manual
    dispatcher takes over. The action still succeeds (the work gets done).

    We stub the downstream qbo.apply_payment call so the test stays
    focused on the fallback behavior — not on the mock store's payment
    bookkeeping."""
    _app, ac = app_client

    os.environ["USE_AGENT_DISPATCH"] = "true"
    monkeypatch.setattr(orch_runtime, "is_agentspan_available", lambda _cfg: True)

    async def fake_dispatch(cfg, db, log, action):
        return orch_runtime.AgentDispatchResult(
            ok=False,
            summary="agent failed after 2 attempts: bad output",
            trace=[],
            fallback_to_manual=True,
        )

    monkeypatch.setattr(orch_runtime, "dispatch_via_agents", fake_dispatch)

    # Stub the manual qbo.apply_payment so the test doesn't care that
    # our synthetic payment id isn't in the mock store. The fallback
    # path's job is to invoke the manual dispatcher; whether that
    # dispatcher itself succeeds is tested elsewhere.
    from linkbook.actions import execute as exec_mod

    class _StubClient:
        async def apply_payment(self, args):
            return {"ok": True, "stubbed": True}

    monkeypatch.setattr(exec_mod, "create_qbo_client", lambda _cfg, _conn: _StubClient())

    apply_action = await _seed_payment_apply_action(ac, subject_ref="payment:test_agent_fb")

    res = await ac.post(f"/actions/{apply_action['id']}/approve")
    # Manual dispatcher took over and succeeded.
    assert res.status_code == 200
    assert res.json()["status"] == "succeeded"

    # `agent.needs_approval` event surfaced for this subject.
    events = (await ac.get(f"/events?subject_ref={apply_action['subject_ref']}")).json()
    assert any(e["type"] == "agent.needs_approval" for e in events["events"]), (
        f"expected agent.needs_approval, got {[e['type'] for e in events['events']]}"
    )
