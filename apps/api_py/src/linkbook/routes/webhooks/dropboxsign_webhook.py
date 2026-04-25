"""§4.3 — Dropbox Sign webhook with HMAC SHA-256 verification."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import load_config
from ...db import get_session
from ...db.models import Client
from ...ingestion import IngestInput, ingest_event
from ...integrations.mocks import get_mock_store
from ...integrations.mocks.store import MockContract
from ...integrations.webhook_verify import verify_dropboxsign
from ...lib.log import app_logger

router = APIRouter()


class _Event(BaseModel):
    type: Literal[
        "signature_request_sent", "signature_request_signed", "signature_request_declined"
    ]
    signature_request_id: str
    title: str
    recipient: str
    client_name: str | None = None


class _Body(BaseModel):
    event: _Event


def _ensure_client(db: Session, name: str) -> str | None:
    c = db.execute(select(Client).where(Client.name == name)).scalar_one_or_none()
    if c is not None:
        return c.id
    new = Client(name=name, source_ids={"dropboxsign": name}, email_domains=[])
    db.add(new)
    db.commit()
    db.refresh(new)
    return new.id


@router.post("/webhooks/dropboxsign")
async def dropboxsign(request: Request, db: Session = Depends(get_session)) -> dict[str, Any]:
    cfg = load_config()
    log = app_logger()
    raw = await request.body()

    if not cfg.USE_INTEGRATION_MOCKS:
        # Dropbox Sign signs payloads with HMAC-SHA256 keyed on the API key.
        api_key = cfg.DROPBOXSIGN_API_KEY or ""
        sig = request.headers.get("X-Hellosign-Signature", "") or request.headers.get(
            "X-Dropboxsign-Signature", ""
        )
        if not verify_dropboxsign(api_key, raw, sig):
            raise HTTPException(status_code=401, detail="invalid signature")

    try:
        body = _Body.model_validate(json.loads(raw))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad_payload: {exc}") from exc
    e = body.event

    store = get_mock_store()
    if e.type == "signature_request_sent":
        store.contracts[e.signature_request_id] = MockContract(
            id=e.signature_request_id,
            title=e.title,
            recipient=e.recipient,
            status="sent",
            sent_at=datetime.now(timezone.utc).isoformat(),
            signed_at=None,
        )
    else:
        c = store.contracts.get(e.signature_request_id)
        if c is not None:
            c.status = "signed" if e.type == "signature_request_signed" else "declined"
            if e.type == "signature_request_signed":
                c.signed_at = datetime.now(timezone.utc).isoformat()

    client_id = _ensure_client(db, e.client_name) if e.client_name else None

    if e.type == "signature_request_signed":
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="dropboxsign",
                type="contract.signed",
                subject_ref=f"contract:{e.signature_request_id}",
                occurred_at=datetime.utcnow(),
                payload={
                    "signature_request_id": e.signature_request_id,
                    "title": e.title,
                    "client_id": client_id,
                    "sent_at": datetime.utcnow().isoformat(),
                    "signed_at": datetime.utcnow().isoformat(),
                },
                dedupe_key="signed",
            ),
        )
    elif e.type == "signature_request_declined":
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="dropboxsign",
                type="contract.declined",
                subject_ref=f"contract:{e.signature_request_id}",
                occurred_at=datetime.utcnow(),
                payload={
                    "signature_request_id": e.signature_request_id,
                    "title": e.title,
                    "client_id": client_id,
                    "sent_at": datetime.utcnow().isoformat(),
                },
                dedupe_key="declined",
            ),
        )

    return {"ok": True}
