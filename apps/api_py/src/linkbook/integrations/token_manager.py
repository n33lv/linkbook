"""Centralized token refresh. Per-source clients call ensure_fresh_token()
before each request when there's a refresh token + an expiry close to now.

§4.1: QBO refresh tokens expire after 100 days of inactivity; our policy
is to refresh proactively when expires_at is within 30 days. Same shape
applies to Google (1 hour access tokens) and Harvest.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import IntegrationConnection
from .oauth import (
    airtable_oauth,
    dropboxsign_oauth,
    google_oauth,
    harvest_oauth,
    qbo_oauth,
    refresh_tokens,
)

REFRESH_BEFORE = timedelta(minutes=5)  # refresh if expires in <= 5 min


async def ensure_fresh_token(
    cfg: AppConfig, db: Session, conn: IntegrationConnection
) -> IntegrationConnection:
    if conn.refresh_token is None or conn.token_expires_at is None:
        return conn
    if conn.token_expires_at - datetime.utcnow() > REFRESH_BEFORE:
        return conn
    o = {
        "qbo": qbo_oauth,
        "harvest": harvest_oauth,
        "dropboxsign": dropboxsign_oauth,
        "airtable": airtable_oauth,
        "gmail": google_oauth,
    }.get(conn.source)
    if o is None:
        return conn
    cfg_o = o(cfg)
    if cfg_o is None:
        return conn
    new = await refresh_tokens(cfg_o, conn.refresh_token)
    conn.access_token = new.access_token
    if new.refresh_token:
        conn.refresh_token = new.refresh_token
    conn.token_expires_at = new.expires_at
    db.commit()
    db.refresh(conn)
    return conn
