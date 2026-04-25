"""Shared OAuth helpers used by per-source integrations.

Production OAuth lives here so the per-integration files stay focused on
the API surface. Each source registers its callback URL + endpoints.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import AppConfig


@dataclass
class OAuthConfig:
    name: str  # 'qbo' | 'harvest' | 'dropboxsign' | 'airtable' | 'google'
    auth_url: str
    token_url: str
    client_id: str
    client_secret: str
    redirect_uri: str
    scopes: list[str]
    extra_auth_params: dict[str, str] | None = None
    pkce: bool = False  # Airtable + Google require PKCE


@dataclass
class OAuthTokens:
    access_token: str
    refresh_token: str | None
    expires_at: datetime | None
    raw: dict[str, Any]


def begin_authorization_url(o: OAuthConfig, state: str) -> str:
    """Build the redirect URL the browser should hit. Caller stores `state`."""
    params: dict[str, str] = {
        "client_id": o.client_id,
        "redirect_uri": o.redirect_uri,
        "response_type": "code",
        "scope": " ".join(o.scopes),
        "state": state,
        **(o.extra_auth_params or {}),
    }
    if o.pkce:
        # Caller must set code_challenge separately if PKCE is enabled.
        # Default approach: skip PKCE for the dev shim; production code
        # adds code_challenge + code_verifier round-trip.
        pass
    return f"{o.auth_url}?{urlencode(params)}"


def random_state() -> str:
    return secrets.token_urlsafe(24)


async def exchange_code_for_tokens(o: OAuthConfig, code: str) -> OAuthTokens:
    body = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": o.redirect_uri,
        "client_id": o.client_id,
        "client_secret": o.client_secret,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(o.token_url, data=body)
    res.raise_for_status()
    payload = res.json()
    return OAuthTokens(
        access_token=payload["access_token"],
        refresh_token=payload.get("refresh_token"),
        expires_at=(
            datetime.utcnow() + timedelta(seconds=int(payload["expires_in"]))
            if "expires_in" in payload
            else None
        ),
        raw=payload,
    )


async def refresh_tokens(o: OAuthConfig, refresh_token: str) -> OAuthTokens:
    body = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": o.client_id,
        "client_secret": o.client_secret,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(o.token_url, data=body)
    res.raise_for_status()
    payload = res.json()
    return OAuthTokens(
        access_token=payload["access_token"],
        refresh_token=payload.get("refresh_token") or refresh_token,
        expires_at=(
            datetime.utcnow() + timedelta(seconds=int(payload["expires_in"]))
            if "expires_in" in payload
            else None
        ),
        raw=payload,
    )


# Per-source factories. Return None if creds missing; caller falls back
# to mocks or a refusal.

def qbo_oauth(cfg: AppConfig) -> OAuthConfig | None:
    if not cfg.QBO_CLIENT_ID or not cfg.QBO_CLIENT_SECRET or not cfg.QBO_REDIRECT_URI:
        return None
    base_auth = "https://appcenter.intuit.com/connect/oauth2"
    base_token = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
    return OAuthConfig(
        name="qbo",
        auth_url=base_auth,
        token_url=base_token,
        client_id=cfg.QBO_CLIENT_ID,
        client_secret=cfg.QBO_CLIENT_SECRET,
        redirect_uri=str(cfg.QBO_REDIRECT_URI),
        scopes=["com.intuit.quickbooks.accounting"],
    )


def harvest_oauth(cfg: AppConfig) -> OAuthConfig | None:
    if not cfg.HARVEST_CLIENT_ID or not cfg.HARVEST_CLIENT_SECRET or not cfg.HARVEST_REDIRECT_URI:
        return None
    return OAuthConfig(
        name="harvest",
        auth_url="https://id.getharvest.com/oauth2/authorize",
        token_url="https://id.getharvest.com/api/v2/oauth2/token",
        client_id=cfg.HARVEST_CLIENT_ID,
        client_secret=cfg.HARVEST_CLIENT_SECRET,
        redirect_uri=str(cfg.HARVEST_REDIRECT_URI),
        scopes=[],  # Harvest requires no scopes; user picks account at consent
    )


def dropboxsign_oauth(cfg: AppConfig) -> OAuthConfig | None:
    if not cfg.DROPBOXSIGN_CLIENT_ID or not cfg.DROPBOXSIGN_CLIENT_SECRET:
        return None
    return OAuthConfig(
        name="dropboxsign",
        auth_url="https://app.dropboxsign.com/oauth/authorize",
        token_url="https://app.dropboxsign.com/oauth/token",
        client_id=cfg.DROPBOXSIGN_CLIENT_ID,
        client_secret=cfg.DROPBOXSIGN_CLIENT_SECRET,
        redirect_uri="",  # populated at runtime per request
        scopes=["basic_account_info", "request_signature", "signature_request_access"],
    )


def airtable_oauth(cfg: AppConfig) -> OAuthConfig | None:
    if (
        not cfg.AIRTABLE_CLIENT_ID
        or not cfg.AIRTABLE_CLIENT_SECRET
        or not cfg.AIRTABLE_REDIRECT_URI
    ):
        return None
    return OAuthConfig(
        name="airtable",
        auth_url="https://airtable.com/oauth2/v1/authorize",
        token_url="https://airtable.com/oauth2/v1/token",
        client_id=cfg.AIRTABLE_CLIENT_ID,
        client_secret=cfg.AIRTABLE_CLIENT_SECRET,
        redirect_uri=str(cfg.AIRTABLE_REDIRECT_URI),
        scopes=[
            "data.records:read",
            "data.records:write",
            "schema.bases:read",
            "webhook:manage",
        ],
        pkce=True,  # Airtable mandates PKCE for OAuth.
    )


def google_oauth(cfg: AppConfig) -> OAuthConfig | None:
    if not cfg.GOOGLE_CLIENT_ID or not cfg.GOOGLE_CLIENT_SECRET or not cfg.GOOGLE_REDIRECT_URI:
        return None
    return OAuthConfig(
        name="google",
        auth_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        client_id=cfg.GOOGLE_CLIENT_ID,
        client_secret=cfg.GOOGLE_CLIENT_SECRET,
        redirect_uri=str(cfg.GOOGLE_REDIRECT_URI),
        scopes=[
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.send",
        ],
        extra_auth_params={"access_type": "offline", "prompt": "consent"},
        pkce=True,
    )
