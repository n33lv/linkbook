"""OAuth connect/callback flows. Mounted by integrations_routes.

Real-mode implementation: redirect to provider, handle callback, exchange
code for tokens, persist into integration_connections.

In mock mode (USE_INTEGRATION_MOCKS=true), /connect short-circuits with a
note that real OAuth isn't needed; /dev/seed/connections gives test
sessions everything they need.
"""

from __future__ import annotations

import secrets
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import live_sources, load_config
from ..db import get_session
from ..db.models import IntegrationConnection
from ..integrations.harvest_account import resolve_harvest_account
from ..integrations.oauth import (
    airtable_oauth,
    begin_authorization_url,
    dropboxsign_oauth,
    exchange_code_for_tokens,
    google_oauth,
    harvest_oauth,
    qbo_oauth,
    random_state,
)

router = APIRouter()

# In-memory state map for `state` round-trips. Single-process v1.
_STATE: dict[str, str] = {}


def _builder_for(source: str, cfg) -> Any:
    return {
        "qbo": qbo_oauth,
        "harvest": harvest_oauth,
        "dropboxsign": dropboxsign_oauth,
        "airtable": airtable_oauth,
        "gmail": google_oauth,
    }.get(source)


@router.post("/integrations/{source}/connect")
async def connect(source: str) -> dict[str, Any]:
    cfg = load_config()
    # Mock mode short-circuit applies only to sources that are still
    # mocked. A source listed in INTEGRATION_LIVE_SOURCES runs real OAuth
    # even when USE_INTEGRATION_MOCKS=true.
    if cfg.USE_INTEGRATION_MOCKS and source not in live_sources(cfg):
        return {
            "redirect_url": None,
            "note": "mocks enabled; use /dev/seed/connections for test sessions",
        }
    builder = _builder_for(source, cfg)
    if builder is None:
        raise HTTPException(status_code=400, detail=f"unknown source {source}")
    o = builder(cfg)
    if o is None:
        raise HTTPException(
            status_code=400,
            detail=f"{source} OAuth not configured (missing CLIENT_ID/CLIENT_SECRET)",
        )
    state = random_state()
    _STATE[state] = source
    return {"redirect_url": begin_authorization_url(o, state)}


@router.get("/integrations/{source}/callback")
async def oauth_callback(
    source: str,
    request: Request,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    cfg = load_config()
    if cfg.USE_INTEGRATION_MOCKS and source not in live_sources(cfg):
        return {"ok": True, "note": "mocks enabled"}

    builder = _builder_for(source, cfg)
    if builder is None:
        raise HTTPException(status_code=400, detail=f"unknown source {source}")
    o = builder(cfg)
    if o is None:
        raise HTTPException(status_code=400, detail=f"{source} not configured")

    code = request.query_params.get("code")
    state = request.query_params.get("state")
    if not code or not state:
        raise HTTPException(status_code=400, detail="missing code/state")
    if _STATE.pop(state, None) != source:
        raise HTTPException(status_code=400, detail="invalid state")

    tokens = await exchange_code_for_tokens(o, code)

    # Provider-specific external_account_id lookup. Each provider's OAuth
    # response shape differs.
    metadata: dict[str, Any] = {}
    if source == "harvest":
        info = await resolve_harvest_account(tokens.access_token)
        external = info["id"]
        metadata = {"display_name": info["name"], "user": info.get("user")}
    else:
        external = tokens.raw.get("realmId") or tokens.raw.get("account_id") or "default"

    existing = db.execute(
        select(IntegrationConnection).where(
            IntegrationConnection.source == source,
            IntegrationConnection.external_account_id == str(external),
        )
    ).scalar_one_or_none()
    display_name = metadata.get("display_name") or source.upper()
    if existing is None:
        db.add(
            IntegrationConnection(
                source=source,
                external_account_id=str(external),
                display_name=display_name,
                status="connected",
                access_token=tokens.access_token,
                refresh_token=tokens.refresh_token,
                token_expires_at=tokens.expires_at,
                metadata_=metadata,
            )
        )
    else:
        existing.access_token = tokens.access_token
        existing.refresh_token = tokens.refresh_token
        existing.token_expires_at = tokens.expires_at
        existing.status = "connected"
        if metadata:
            existing.metadata_ = {**(existing.metadata_ or {}), **metadata}
            existing.display_name = display_name
    db.commit()

    return {"ok": True, "source": source, "external_account_id": str(external)}
