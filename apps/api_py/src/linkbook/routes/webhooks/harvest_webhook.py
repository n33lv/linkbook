"""§4.2 — Harvest webhook with HMAC SHA-256 signature verification."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ...config import load_config
from ...db import get_session
from ...ingestion import IngestInput, ingest_event
from ...integrations.webhook_verify import verify_harvest
from ...lib.log import app_logger

router = APIRouter()


class _Event(BaseModel):
    type: Literal["invoice.draft_ready", "time_entry.created", "project.budget_threshold"]
    payload: dict[str, Any]


class _Body(BaseModel):
    event: _Event


@router.post("/webhooks/harvest")
async def harvest(request: Request, db: Session = Depends(get_session)) -> dict[str, bool]:
    cfg = load_config()
    log = app_logger()
    raw = await request.body()

    # Real mode: verify Harvest's X-Harvest-Signature header.
    if not cfg.USE_INTEGRATION_MOCKS:
        secret = cfg.HARVEST_CLIENT_SECRET or ""
        sig = request.headers.get("X-Harvest-Signature", "")
        if not verify_harvest(secret, raw, sig):
            raise HTTPException(status_code=401, detail="invalid signature")

    try:
        body = _Body.model_validate(json.loads(raw))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad_payload: {exc}") from exc

    e = body.event

    if e.type == "invoice.draft_ready":
        p = e.payload
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="harvest",
                type="invoice.draft_ready_to_send",
                subject_ref=f"invoice:{p['harvest_invoice_id']}",
                occurred_at=datetime.utcnow(),
                payload={
                    "harvest_invoice_id": p["harvest_invoice_id"],
                    "client_id": p.get("client_id"),
                    "amount_cents": p["amount_cents"],
                    "drafted_at": datetime.utcnow().isoformat(),
                },
                dedupe_key="ready",
            ),
        )
    elif e.type == "project.budget_threshold":
        p = e.payload
        t = p["threshold"]
        type_map = {
            80: "time.budget_threshold_80",
            100: "time.budget_threshold_100",
            120: "time.budget_threshold_120",
        }
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="harvest",
                type=type_map.get(t, "time.budget_threshold_100"),
                subject_ref=f"project:{p['project_id']}",
                occurred_at=datetime.utcnow(),
                payload={
                    "project_id": p["project_id"],
                    "harvest_project_id": p.get("harvest_project_id", ""),
                    "hours_used": p["hours_used"],
                    "hours_budgeted": p["hours_budgeted"],
                    "pct": (
                        p["hours_used"] / p["hours_budgeted"]
                        if p["hours_budgeted"]
                        else 0
                    ),
                },
                dedupe_key=f"t{t}",
            ),
        )
    return {"ok": True}
