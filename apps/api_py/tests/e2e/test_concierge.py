"""E2E — Project Concierge composite + partial-failure resume."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_kickoff_all_4_legs_succeed(app_client):
    _app, ac = app_client
    await ac.post("/dev/mocks/reset")
    await ac.post("/dev/seed/connections")

    await ac.post(
        "/webhooks/dropboxsign",
        json={
            "event": {
                "type": "signature_request_signed",
                "signature_request_id": "sig_e2e_kickoff",
                "title": "Cypress Bay — Brand System",
                "recipient": "mira@cypress.bay",
                "client_name": "Cypress Bay",
            }
        },
    )

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    kickoff = next((a for a in actions if a["type"] == "project.kickoff"), None)
    assert kickoff is not None

    approved = await ac.post(f"/actions/{kickoff['id']}/approve")
    assert approved.status_code == 200
    assert approved.json()["status"] == "succeeded"

    detail = (await ac.get(f"/actions/{kickoff['id']}")).json()
    assert all(l["status"] == "succeeded" for l in detail["legs"])

    mocks = (await ac.get("/dev/mocks")).json()
    assert any("Cypress Bay" in p["name"] for p in mocks["harvest_projects"])
    assert len(mocks["airtable_records"]) > 0
    assert any("Cypress" in f["path"] for f in mocks["drive_folders"])

    # §2.5 — welcome email leg goes through 30s queue.
    queue = (await ac.get("/actions?status=open")).json()["actions"]
    assert any(
        a["type"] == "email.send_draft" and a["status"] == "queued_30s" for a in queue
    )


@pytest.mark.asyncio
async def test_partial_failure_airtable_500(app_client):
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
                "signature_request_id": "sig_e2e_partial",
                "title": "Foxglove Press — Editorial",
                "recipient": "editor@foxglove.press",
                "client_name": "Foxglove Press",
            }
        },
    )

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    kickoff = next((a for a in actions if a["type"] == "project.kickoff"), None)
    assert kickoff is not None

    res = await ac.post(f"/actions/{kickoff['id']}/approve")
    assert res.status_code == 502

    detail = (await ac.get(f"/actions/{kickoff['id']}")).json()
    assert detail["action"]["status"] == "failed"
    sorted_legs = sorted(detail["legs"], key=lambda l: l["order"])
    assert sorted_legs[0]["status"] == "succeeded"  # harvest done
    assert sorted_legs[1]["status"] == "failed"  # airtable failed
    assert sorted_legs[2]["status"] == "drafted"  # never ran
    assert sorted_legs[3]["status"] == "drafted"
