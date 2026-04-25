"""E2E — queued_30s rows whose timer would have fired during downtime get
drained on next 'boot' (lifespan re-run)."""

from __future__ import annotations

import asyncio
import importlib
import os

import pytest
from httpx import ASGITransport, AsyncClient

from linkbook.db import close_engine
from linkbook.integrations.mocks import reset_mock_store


@pytest.mark.asyncio
async def test_past_deadline_fires_on_next_boot(tmp_db_path):
    """Drive the same DB through two app instances. Between them, rewind
    queued_until into the past so recovery has work to do."""
    os.environ["DATABASE_URL"] = f"file:{tmp_db_path}"
    os.environ["SEND_DELAY_MS"] = "30000"  # long delay so timer doesn't fire mid-test
    try:
        # Boot 1: ingest, get a draft, approve.
        close_engine()
        import linkbook.app as app_mod
        importlib.reload(app_mod)
        app1 = app_mod.build_app()
        async with app1.router.lifespan_context(app1):
            transport = ASGITransport(app=app1)
            async with AsyncClient(transport=transport, base_url="http://t") as ac:
                await ac.post("/dev/seed/connections")
                await ac.post(
                    "/dev/ingest",
                    json={
                        "source": "qbo",
                        "type": "invoice.aging_60",
                        "subject_ref": "invoice:RECOV",
                        "payload": {
                            "invoice_id": "INV-RECOV",
                            "client_id": "00000000-0000-0000-0000-000000000222",
                            "amount_cents": 100_000,
                            "currency": "USD",
                            "issued_at": "2026-02-22T00:00:00Z",
                            "due_at": "2026-02-22T00:00:00Z",
                            "days_overdue": 60,
                        },
                        "dedupe_key": "aging_60",
                    },
                )
                actions = (await ac.get("/actions?status=open")).json()["actions"]
                draft = next(
                    a for a in actions if a["type"] == "invoice.remind" and a["subject_ref"] == "invoice:RECOV"
                )
                await ac.post(f"/actions/{draft['id']}/approve")
                await ac.post(
                    "/dev/queue/rewind", json={"action_id": draft["id"], "past_seconds": 5}
                )
        close_engine()

        # Boot 2: lifespan recovery should fire the queued action.
        os.environ["SEND_DELAY_MS"] = "30000"
        importlib.reload(app_mod)
        app2 = app_mod.build_app()
        async with app2.router.lifespan_context(app2):
            transport = ASGITransport(app=app2)
            async with AsyncClient(transport=transport, base_url="http://t") as ac:
                # recoverQueueOnBoot fires within 0–500ms of jitter
                await asyncio.sleep(1.0)
                detail = (await ac.get(f"/actions/{draft['id']}")).json()
                assert detail["action"]["status"] == "succeeded"
        close_engine()
    finally:
        os.environ.pop("SEND_DELAY_MS", None)
        reset_mock_store()
