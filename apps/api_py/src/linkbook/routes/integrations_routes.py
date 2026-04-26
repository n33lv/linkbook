"""Integrations status + Harvest→QBO probe (§4.1)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import live_sources, load_config
from ..db import get_session
from ..db.models import IntegrationConnection
from ..integrations.harvest import create_harvest_client

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
        "live_sources": sorted(live_sources(cfg)),
    }


@router.get("/integrations/{source}/test")
async def smoke_test(source: str, db: Session = Depends(get_session)) -> dict[str, Any]:
    """Read-only health check against a live integration.

    Currently only Harvest. Returns a small payload from the source,
    proving auth + headers + base URL are right end-to-end.
    """
    if source != "harvest":
        raise HTTPException(status_code=400, detail=f"smoke test for {source} not implemented")
    cfg = load_config()
    # If both a seeded mock row and a real OAuth row exist, prefer the
    # real one (longer access_token; mocks use a stub like "fake_token").
    rows = (
        db.execute(
            select(IntegrationConnection).where(IntegrationConnection.source == "harvest")
        )
        .scalars()
        .all()
    )
    if not rows:
        raise HTTPException(status_code=404, detail="harvest not connected")
    rows.sort(key=lambda c: len(c.access_token or ""), reverse=True)
    conn = rows[0]
    client = create_harvest_client(cfg, conn)
    me = await client.me()
    projects = await client.list_projects()
    project_list = projects.get("projects", []) if isinstance(projects, dict) else []
    return {
        "ok": True,
        "user": {
            "id": me.get("id"),
            "email": me.get("email"),
            "first_name": me.get("first_name"),
            "last_name": me.get("last_name"),
        },
        "project_count": len(project_list),
        "projects": [
            {"id": p.get("id"), "name": p.get("name"), "code": p.get("code")}
            for p in project_list[:5]
        ],
    }


@router.post("/integrations/harvest_qbo/probe")
async def probe() -> dict[str, Any]:
    cfg = load_config()
    if not cfg.USE_INTEGRATION_MOCKS:
        return {"ok": False, "reason": "real-mode probe not implemented yet"}
    return {"ok": True, "propagated_in_seconds": 2}
