"""E2E — failure-path coverage."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_5xx_emits_action_failed_event(app_client):
    _app, ac = app_client
    await ac.post("/dev/mocks/reset")
    await ac.post("/dev/seed/connections")
    await ac.post(
        "/dev/mocks/fail-next",
        json={"key": "airtable:POST /v0/app_demo/tbl_projects", "status": 500},
    )
    await ac.post(
        "/webhooks/dropboxsign",
        json={
            "event": {
                "type": "signature_request_signed",
                "signature_request_id": "sig_fail_5xx",
                "title": "Hill & Houseman — SOW",
                "recipient": "pm@hillhouseman.com",
                "client_name": "Hill & Houseman",
            }
        },
    )
    actions = (await ac.get("/actions?status=open")).json()["actions"]
    kickoff = next((a for a in actions if a["type"] == "project.kickoff"), None)
    assert kickoff is not None
    await ac.post(f"/actions/{kickoff['id']}/approve")  # expected to 502

    inbox = (await ac.get("/inbox")).json()
    assert any(
        e["type"] == "action.failed" and e["subject_ref"] == f"action:{kickoff['id']}"
        for e in inbox["events"]
    )


@pytest.mark.asyncio
async def test_retry_resumes_from_failed_leg(app_client):
    _app, ac = app_client
    await ac.post("/dev/mocks/reset")
    await ac.post("/dev/seed/connections")
    await ac.post(
        "/dev/mocks/fail-next",
        json={"key": "airtable:POST /v0/app_demo/tbl_projects", "status": 500},
    )
    await ac.post(
        "/webhooks/dropboxsign",
        json={
            "event": {
                "type": "signature_request_signed",
                "signature_request_id": "sig_retry",
                "title": "Linkwell — SOW",
                "recipient": "team@linkwell.io",
                "client_name": "Linkwell",
            }
        },
    )
    actions = (await ac.get("/actions?status=open")).json()["actions"]
    kickoff = next((a for a in actions if a["type"] == "project.kickoff"), None)
    await ac.post(f"/actions/{kickoff['id']}/approve")  # fails

    retried = await ac.post(f"/actions/{kickoff['id']}/retry")
    assert retried.status_code == 200
    assert retried.json()["status"] == "succeeded"


@pytest.mark.asyncio
async def test_dedupe_no_second_proposal_within_24h(app_client):
    _app, ac = app_client
    await ac.post("/dev/mocks/reset")
    await ac.post("/dev/seed/connections")
    payload = {
        "source": "qbo",
        "type": "invoice.aging_60",
        "subject_ref": "invoice:DUPE",
        "payload": {
            "invoice_id": "INV-DUPE",
            "client_id": "00000000-0000-0000-0000-000000000111",
            "amount_cents": 100_000,
            "currency": "USD",
            "issued_at": "2026-02-22T00:00:00Z",
            "due_at": "2026-02-22T00:00:00Z",
            "days_overdue": 60,
        },
        "dedupe_key": "aging_60",
    }
    await ac.post("/dev/ingest", json=payload)
    await ac.post("/dev/ingest", json={**payload, "dedupe_key": "aging_60_again"})

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    reminders = [
        a for a in actions if a["type"] == "invoice.remind" and a["subject_ref"] == "invoice:DUPE"
    ]
    assert len(reminders) == 1
