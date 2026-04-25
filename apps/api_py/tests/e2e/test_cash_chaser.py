"""E2E — Cash Chaser flow."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_full_cash_chaser_flow(app_client):
    _app, ac = app_client
    await ac.post("/dev/seed/connections")

    ingest = await ac.post(
        "/dev/ingest",
        json={
            "source": "qbo",
            "type": "invoice.aging_60",
            "subject_ref": "invoice:E2E-CC",
            "payload": {
                "invoice_id": "INV-E2E",
                "client_id": "00000000-0000-0000-0000-000000000099",
                "amount_cents": 1_840_000,
                "currency": "USD",
                "issued_at": "2026-02-22T00:00:00Z",
                "due_at": "2026-02-22T00:00:00Z",
                "days_overdue": 62,
            },
            "dedupe_key": "aging_60",
        },
    )
    assert ingest.json()["inserted"] is True

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    draft = next(
        (a for a in actions if a["type"] == "invoice.remind" and a["subject_ref"] == "invoice:E2E-CC"),
        None,
    )
    assert draft is not None

    approved = await ac.post(f"/actions/{draft['id']}/approve")
    assert approved.status_code == 200
    assert approved.json()["status"] == "queued_30s"

    # Duplicate approval rejected.
    dup = await ac.post(f"/actions/{draft['id']}/approve")
    assert dup.status_code == 409

    # Cancel via undo.
    undo = await ac.post(f"/actions/{draft['id']}/undo")
    assert undo.status_code == 200

    # Audit captured agent.proposed.
    detail = (await ac.get(f"/inbox/{ingest.json()['event_id']}")).json()
    kinds = [a["kind"] for a in detail["audit"]]
    assert "agent.proposed" in kinds


@pytest.mark.asyncio
async def test_hallucination_guard_proposal_exists(app_client):
    _app, ac = app_client
    await ac.post("/dev/seed/connections")
    await ac.post(
        "/dev/ingest",
        json={
            "source": "qbo",
            "type": "invoice.aging_60",
            "subject_ref": "invoice:E2E-PAID",
            "payload": {
                "invoice_id": "PAID-LOCAL",
                "client_id": "00000000-0000-0000-0000-000000000098",
                "amount_cents": 50_000,
                "currency": "USD",
                "issued_at": "2026-02-22T00:00:00Z",
                "due_at": "2026-02-22T00:00:00Z",
                "days_overdue": 62,
            },
            "dedupe_key": "aging_60",
        },
    )
    actions = (await ac.get("/actions?status=open")).json()["actions"]
    assert any(a["subject_ref"] == "invoice:E2E-PAID" for a in actions)
