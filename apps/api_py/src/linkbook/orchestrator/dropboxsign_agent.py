"""Dropbox Sign sub-agent. Tools wrap integrations/dropboxsign.py."""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import AppConfig, load_config
from ..db.models import IntegrationConnection
from ..integrations.dropboxsign import create_dropboxsign_client
from .context import async_tool, tool_resources

_INSTRUCTIONS = """\
You handle Dropbox Sign actions for a small design studio.

Tools:
  - send_reminder: nudge a counterparty whose signature is pending
  - send_from_template: send a contract from a saved template
  - cancel: void a sent signature request

The signature_request_id is always given. Never fabricate one.
"""


def _ds_client(cfg: AppConfig, db: Session):
    conn = db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "dropboxsign")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("dropbox sign not connected")
    return create_dropboxsign_client(cfg, conn)


@async_tool
async def send_reminder(signature_request_id: str) -> dict[str, Any]:
    """Nudge a counterparty whose signature is pending."""
    with tool_resources() as (cfg, db):
        client = _ds_client(cfg, db)
        return await client.send_reminder(signature_request_id)


@async_tool
async def send_from_template(template_id: str, recipient: str, title: str) -> dict[str, Any]:
    """Create + send a new signature request from a saved template."""
    with tool_resources() as (cfg, db):
        client = _ds_client(cfg, db)
        return await client.send_from_template(
            {"template_id": template_id, "recipient": recipient, "title": title}
        )


@async_tool
async def cancel(signature_request_id: str) -> dict[str, Any]:
    """Void a sent signature request."""
    with tool_resources() as (cfg, db):
        client = _ds_client(cfg, db)
        return await client.cancel(signature_request_id)


def build_dropboxsign_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="dropboxsign",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[send_reminder, send_from_template, cancel],
    )
