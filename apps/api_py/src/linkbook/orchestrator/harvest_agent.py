"""Harvest sub-agent. Tools wrap integrations/harvest.py.

Where Linkbook needs an invoice, it drafts in Harvest and Harvest's QBO
sync propagates (§4.1). Time logging and project creation are also here.
"""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent, tool
from sqlalchemy import select

from ..config import load_config
from ..db.models import IntegrationConnection
from ..integrations.harvest import create_harvest_client
from .context import get_agent_context, record_tool_call

_INSTRUCTIONS = """\
You handle Harvest actions for a small design studio.

Tools:
  - send_invoice: send an existing draft invoice
  - create_project: create a new project (used during kickoff)
  - archive_project: archive a project (true_undo for create)
  - log_time_entry: add a time entry on the operator's behalf
  - list_time_entries: read recent time entries

When asked to send an invoice, the harvest_invoice_id is given to you.
Don't fabricate ids.
"""


def _conn(ctx) -> IntegrationConnection:
    conn = ctx.db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "harvest")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("harvest integration not connected")
    return conn


@tool
async def send_invoice(harvest_invoice_id: str) -> dict[str, Any]:
    """Send a Harvest invoice that's already drafted."""
    ctx = get_agent_context()
    client = create_harvest_client(ctx.cfg, _conn(ctx))
    try:
        resp = await client.send_invoice(harvest_invoice_id)
        record_tool_call(
            "send_invoice", {"harvest_invoice_id": harvest_invoice_id}, response=resp, http_status=201
        )
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("send_invoice", {"harvest_invoice_id": harvest_invoice_id}, error=str(e))
        raise


@tool
async def create_project(name: str, client_id: str, budget_hours: int) -> dict[str, Any]:
    """Create a new Harvest project. Used during kickoff."""
    ctx = get_agent_context()
    client = create_harvest_client(ctx.cfg, _conn(ctx))
    args = {"name": name, "client_id": client_id, "budget_hours": budget_hours}
    try:
        resp = await client.create_project(args)
        record_tool_call("create_project", args, response=resp, http_status=201)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("create_project", args, error=str(e))
        raise


@tool
async def archive_project(project_id: str) -> dict[str, Any]:
    """Archive a Harvest project. The true_undo for create_project."""
    ctx = get_agent_context()
    client = create_harvest_client(ctx.cfg, _conn(ctx))
    try:
        resp = await client.archive_project(project_id)
        record_tool_call("archive_project", {"project_id": project_id}, response=resp, http_status=200)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("archive_project", {"project_id": project_id}, error=str(e))
        raise


@tool
async def log_time_entry(
    user_id: str, project_id: str, date: str, hours: float, notes: str | None = None
) -> dict[str, Any]:
    """Add a time entry on the operator's behalf. date is YYYY-MM-DD."""
    ctx = get_agent_context()
    client = create_harvest_client(ctx.cfg, _conn(ctx))
    args = {"user_id": user_id, "project_id": project_id, "date": date, "hours": hours, "notes": notes}
    try:
        resp = await client.log_time_entry(args)
        record_tool_call("log_time_entry", args, response=resp, http_status=201)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("log_time_entry", args, error=str(e))
        raise


@tool
async def list_time_entries() -> dict[str, Any]:
    """Read recent time entries."""
    ctx = get_agent_context()
    client = create_harvest_client(ctx.cfg, _conn(ctx))
    try:
        resp = await client.list_time_entries()
        record_tool_call("list_time_entries", {}, response=resp, http_status=200)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("list_time_entries", {}, error=str(e))
        raise


def build_harvest_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="harvest",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[send_invoice, create_project, archive_project, log_time_entry, list_time_entries],
    )
