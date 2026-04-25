"""§2.5 — 30s send-delay queue end-to-end (via in-process app)."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_approve_invoice_remind_queued_then_undo_cancels(app_client):
    _app, ac = app_client
    # Trigger an aging event so Cash Chaser drafts a reminder.
    res = await ac.post(
        "/dev/ingest",
        json={
            "source": "qbo",
            "type": "invoice.aging_60",
            "subject_ref": "invoice:test_q1",
            "payload": {
                "invoice_id": "INV-Q1",
                "client_id": "00000000-0000-0000-0000-000000000010",
                "amount_cents": 100_000,
                "currency": "USD",
                "issued_at": "2026-04-25T00:00:00Z",
                "due_at": "2026-04-25T00:00:00Z",
                "days_overdue": 60,
            },
            "dedupe_key": "aging_60",
        },
    )
    assert res.status_code == 200, res.text

    list_resp = await ac.get("/actions?status=open")
    actions = list_resp.json()["actions"]
    draft = next(
        (
            a
            for a in actions
            if a["type"] == "invoice.remind" and a["status"] == "drafted"
        ),
        None,
    )
    assert draft is not None, "cash chaser should have drafted a reminder"

    approved = await ac.post(f"/actions/{draft['id']}/approve")
    assert approved.status_code == 200
    assert approved.json()["status"] == "queued_30s"

    undone = await ac.post(f"/actions/{draft['id']}/undo")
    assert undone.status_code == 200
    assert undone.json()["method"] == "cancel_queued"

    detail = await ac.get(f"/actions/{draft['id']}")
    assert detail.json()["action"]["status"] == "cancelled"
