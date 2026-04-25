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
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from linkbook.orchestrator import runtime as orch_runtime


@pytest.mark.asyncio
async def test_agent_dispatch_kickoff_routes_through_orchestrator(app_client, monkeypatch):
    """A project.kickoff (non-queueable) approval with USE_AGENT_DISPATCH
    on routes the dispatch through the stubbed orchestrator. Audit captures
    the tool-call trace; action transitions to succeeded."""
    _app, ac = app_client

    os.environ["USE_AGENT_DISPATCH"] = "true"
    monkeypatch.setattr(orch_runtime, "is_agentspan_available", lambda _cfg: True)

    captured: dict[str, Any] = {}

    async def fake_dispatch(cfg, db, log, action):
        captured["action_type"] = action.type
        captured["subject_ref"] = action.subject_ref
        return orch_runtime.AgentDispatchResult(
            ok=True,
            summary="Kicked off project via 4-leg composite (orchestrated)",
            trace=[
                {"tool": "create_project", "args": {"name": "x"}, "response": {"id": "h_x"}, "http_status": 201},
                {"tool": "create_record", "args": {"fields": {}}, "response": {}, "http_status": 200},
            ],
        )

    monkeypatch.setattr(orch_runtime, "dispatch_via_agents", fake_dispatch)

    await ac.post("/dev/mocks/reset")
    await ac.post("/dev/seed/connections")
    await ac.post(
        "/webhooks/dropboxsign",
        json={
            "event": {
                "type": "signature_request_signed",
                "signature_request_id": "sig_agent_kickoff",
                "title": "Cypress Bay — Brand System",
                "recipient": "mira@cypress.bay",
                "client_name": "Cypress Bay",
            }
        },
    )

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    kickoff = next(a for a in actions if a["type"] == "project.kickoff")
    res = await ac.post(f"/actions/{kickoff['id']}/approve")
    assert res.status_code == 200
    assert res.json()["status"] == "succeeded"

    # The orchestrator was called.
    assert captured["action_type"] == "project.kickoff"
    assert captured["subject_ref"] == kickoff["subject_ref"]

    # Audit row from the agent path.
    detail = (await ac.get(f"/actions/{kickoff['id']}")).json()
    succeeded = next((a for a in detail["audit"] if a["kind"] == "action.succeeded"), None)
    assert succeeded is not None
    assert succeeded["actor"].startswith("agent:orchestrator")
    # The trace got persisted.
    assert succeeded["response"] is not None
    assert "tool_calls" in succeeded["response"]
    assert len(succeeded["response"]["tool_calls"]) == 2


@pytest.mark.asyncio
async def test_agent_dispatch_falls_back_to_manual_after_2_failures(app_client, monkeypatch):
    """When dispatch_via_agents returns fallback_to_manual=True, an
    `agent.needs_approval` event hits the inbox AND the manual
    dispatcher takes over. The action still succeeds (the work gets done)."""
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

    await ac.post("/dev/mocks/reset")
    await ac.post("/dev/seed/connections")
    await ac.post(
        "/webhooks/dropboxsign",
        json={
            "event": {
                "type": "signature_request_signed",
                "signature_request_id": "sig_agent_fallback",
                "title": "Foxglove — Editorial",
                "recipient": "ed@foxglove.press",
                "client_name": "Foxglove Press",
            }
        },
    )

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    kickoff = next(a for a in actions if a["type"] == "project.kickoff")

    res = await ac.post(f"/actions/{kickoff['id']}/approve")
    # Manual dispatcher took over and succeeded.
    assert res.status_code == 200
    assert res.json()["status"] == "succeeded"

    # `agent.needs_approval` event surfaced for this subject.
    events = (await ac.get(f"/events?subject_ref={kickoff['subject_ref']}")).json()
    assert any(e["type"] == "agent.needs_approval" for e in events["events"]), (
        f"expected agent.needs_approval, got {[e['type'] for e in events['events']]}"
    )
