"""E2E — queue actually fires after the delay."""

from __future__ import annotations

import asyncio
import os

import pytest


@pytest.mark.asyncio
async def test_queue_fires_after_delay(app_client):
    # Override the queue delay in-process so the test runs fast.
    os.environ["SEND_DELAY_MS"] = "80"
    try:
        _app, ac = app_client
        await ac.post("/dev/seed/connections")

        await ac.post(
            "/dev/ingest",
            json={
                "source": "qbo",
                "type": "invoice.aging_60",
                "subject_ref": "invoice:Q-FIRE",
                "payload": {
                    "invoice_id": "INV-Q-FIRE",
                    "client_id": "00000000-0000-0000-0000-000000000123",
                    "amount_cents": 100_000,
                    "currency": "USD",
                    "issued_at": "2026-02-22T00:00:00Z",
                    "due_at": "2026-02-22T00:00:00Z",
                    "days_overdue": 60,
                },
                "dedupe_key": "aging_60",
            },
        )
        list_resp = (await ac.get("/actions?status=open")).json()
        draft = next(
            (
                a
                for a in list_resp["actions"]
                if a["type"] == "invoice.remind" and a["subject_ref"] == "invoice:Q-FIRE"
            ),
            None,
        )
        assert draft is not None

        approved = await ac.post(f"/actions/{draft['id']}/approve")
        assert approved.json()["status"] == "queued_30s"

        await asyncio.sleep(0.4)

        detail = (await ac.get(f"/actions/{draft['id']}")).json()
        assert detail["action"]["status"] == "succeeded"

        mocks = (await ac.get("/dev/mocks")).json()
        assert len(mocks["sent_emails"]) > 0

        # §2.6 — audit captured request/response on success
        succeeded = next((a for a in detail["audit"] if a["kind"] == "action.succeeded"), None)
        assert succeeded is not None
        assert succeeded["request"] is not None
        assert succeeded["response"] is not None
        assert succeeded["http_status"] == "200"
    finally:
        os.environ.pop("SEND_DELAY_MS", None)
