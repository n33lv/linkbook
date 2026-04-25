"""Integration — webhooks → ingestion → agent proposals."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_dropbox_signed_kickoff_4_legs(app_client):
    _app, ac = app_client
    res = await ac.post(
        "/webhooks/dropboxsign",
        json={
            "event": {
                "type": "signature_request_signed",
                "signature_request_id": "sig_test_signed",
                "title": "Northbeam — MSA",
                "recipient": "mira@northbeam.com",
                "client_name": "Northbeam Inc.",
            }
        },
    )
    assert res.status_code == 200

    inbox = (await ac.get("/inbox")).json()
    assert any(e["type"] == "contract.signed" for e in inbox["events"])

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    kickoff = next((a for a in actions if a["type"] == "project.kickoff"), None)
    assert kickoff is not None, "concierge should have drafted kickoff"

    detail = (await ac.get(f"/actions/{kickoff['id']}")).json()
    assert len(detail["legs"]) == 4
    assert sorted(l["target"] for l in detail["legs"]) == [
        "airtable:insert_record",
        "drive:create_folder",
        "gmail:draft_welcome",
        "harvest:create_project",
    ]


@pytest.mark.asyncio
async def test_harvest_invoice_draft_ready_in_inbox(app_client):
    _app, ac = app_client
    await ac.post(
        "/webhooks/harvest",
        json={
            "event": {
                "type": "invoice.draft_ready",
                "payload": {
                    "harvest_invoice_id": "H-WHX",
                    "client_id": "00000000-0000-0000-0000-000000000020",
                    "amount_cents": 250_000,
                },
            }
        },
    )
    inbox = (await ac.get("/inbox")).json()
    assert any(
        e["type"] == "invoice.draft_ready_to_send" and e["subject_ref"] == "invoice:H-WHX"
        for e in inbox["events"]
    )


@pytest.mark.asyncio
async def test_reconciler_stays_manual_low_conf(app_client):
    _app, ac = app_client
    await ac.post(
        "/dev/ingest",
        json={
            "source": "qbo",
            "type": "payment.received_unapplied",
            "subject_ref": "payment:test_lowconf",
            "payload": {
                "qbo_payment_id": "pay_test_lowconf",
                "customer_name_raw": "STELLATE STUDIOS LLC",
                "amount_cents": 640_000,
                "received_at": "2026-04-25T00:00:00Z",
                "candidate_invoice_ids": ["inv_a", "inv_b", "inv_c"],
            },
            "dedupe_key": "unapplied",
        },
    )

    inbox = (await ac.get("/inbox")).json()
    assert any(e["subject_ref"] == "payment:test_lowconf" for e in inbox["events"])

    actions = (await ac.get("/actions?status=open")).json()["actions"]
    assert not any(
        a["subject_ref"] == "payment:test_lowconf" and a["type"] == "payment.apply"
        for a in actions
    )
