"""Dropbox Sign sub-agent. Tools wrap integrations/dropboxsign.py."""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent, tool
from sqlalchemy import select

from ..config import load_config
from ..db.models import IntegrationConnection
from ..integrations.dropboxsign import create_dropboxsign_client
from .context import get_agent_context, record_tool_call

_INSTRUCTIONS = """\
You handle Dropbox Sign actions for a small design studio.

Tools:
  - send_reminder: nudge a counterparty whose signature is pending
  - send_from_template: send a contract from a saved template
  - cancel: void a sent signature request

The signature_request_id is always given. Never fabricate one.
"""


def _conn(ctx) -> IntegrationConnection:
    conn = ctx.db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "dropboxsign")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("dropbox sign not connected")
    return conn


@tool
async def send_reminder(signature_request_id: str) -> dict[str, Any]:
    """Nudge a counterparty whose signature is pending."""
    ctx = get_agent_context()
    client = create_dropboxsign_client(ctx.cfg, _conn(ctx))
    try:
        resp = await client.send_reminder(signature_request_id)
        record_tool_call(
            "send_reminder",
            {"signature_request_id": signature_request_id},
            response=resp,
            http_status=200,
        )
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call(
            "send_reminder", {"signature_request_id": signature_request_id}, error=str(e)
        )
        raise


@tool
async def send_from_template(template_id: str, recipient: str, title: str) -> dict[str, Any]:
    """Create + send a new signature request from a saved template."""
    ctx = get_agent_context()
    client = create_dropboxsign_client(ctx.cfg, _conn(ctx))
    args = {"template_id": template_id, "recipient": recipient, "title": title}
    try:
        resp = await client.send_from_template(args)
        record_tool_call("send_from_template", args, response=resp, http_status=201)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("send_from_template", args, error=str(e))
        raise


@tool
async def cancel(signature_request_id: str) -> dict[str, Any]:
    """Void a sent signature request."""
    ctx = get_agent_context()
    client = create_dropboxsign_client(ctx.cfg, _conn(ctx))
    try:
        resp = await client.cancel(signature_request_id)
        record_tool_call(
            "cancel", {"signature_request_id": signature_request_id}, response=resp, http_status=200
        )
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call(
            "cancel", {"signature_request_id": signature_request_id}, error=str(e)
        )
        raise


def build_dropboxsign_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="dropboxsign",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[send_reminder, send_from_template, cancel],
    )
