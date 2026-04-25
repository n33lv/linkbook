"""Integrations status + Harvest→QBO probe (§4.1)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import load_config
from ..db import get_session
from ..db.models import IntegrationConnection

router = APIRouter()


@router.get("/integrations")
async def list_integrations(db: Session = Depends(get_session)) -> dict[str, Any]:
    rows = db.execute(select(IntegrationConnection)).scalars().all()
    cfg = load_config()
    return {
        "connections": [
            {
                "id": c.id,
                "source": c.source,
                "external_account_id": c.external_account_id,
                "display_name": c.display_name,
                "status": c.status,
                "last_sync_at": c.last_sync_at.isoformat() + "Z" if c.last_sync_at else None,
            }
            for c in rows
        ],
        "mocks": cfg.USE_INTEGRATION_MOCKS,
    }


@router.post("/integrations/harvest_qbo/probe")
async def probe() -> dict[str, Any]:
    cfg = load_config()
    if not cfg.USE_INTEGRATION_MOCKS:
        return {"ok": False, "reason": "real-mode probe not implemented yet"}
    return {"ok": True, "propagated_in_seconds": 2}
