"""Harvest sub-agent. Tools wrap integrations/harvest.py.

Where Linkbook needs an invoice, it drafts in Harvest and Harvest's QBO
sync propagates (§4.1). Time logging and project creation are also here.
"""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import AppConfig, load_config
from ..db.models import IntegrationConnection
from ..integrations.harvest import create_harvest_client
from .context import async_tool, tool_resources

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


def _harvest_client(cfg: AppConfig, db: Session):
    conn = db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "harvest")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("harvest integration not connected")
    return create_harvest_client(cfg, conn)


@async_tool
async def send_invoice(harvest_invoice_id: str) -> dict[str, Any]:
    """Send a Harvest invoice that's already drafted."""
    with tool_resources() as (cfg, db):
        client = _harvest_client(cfg, db)
        return await client.send_invoice(harvest_invoice_id)


@async_tool
async def create_project(name: str, client_id: str, budget_hours: int) -> dict[str, Any]:
    """Create a new Harvest project. Used during kickoff.

    The orchestrator passes whatever it pulled from action.params; this
    is usually our internal Linkbook UUID, which Harvest doesn't know.
    If client_id isn't already a numeric Harvest id, look up the client
    name in our DB and find-or-create on Harvest. Also fills the
    Harvest-required is_billable/bill_by fields the orchestrator can't
    be expected to know about.
    """
    from ..db.models import Client as LinkbookClient

    with tool_resources() as (cfg, db):
        client = _harvest_client(cfg, db)

        harvest_client_id: int
        if client_id.isdigit():
            harvest_client_id = int(client_id)
        else:
            row = db.get(LinkbookClient, client_id)
            client_name = row.name if row and row.name else "Linkbook Client"
            harvest_client_id = int(await client.find_or_create_client(client_name))

        return await client.create_project(
            {
                "name": name,
                "client_id": harvest_client_id,
                "is_billable": True,
                "bill_by": "Project",
                "budget_by": "project",
                "budget": budget_hours,
            }
        )


@async_tool
async def archive_project(project_id: str) -> dict[str, Any]:
    """Archive a Harvest project. The true_undo for create_project."""
    with tool_resources() as (cfg, db):
        client = _harvest_client(cfg, db)
        return await client.archive_project(project_id)


@async_tool
async def log_time_entry(
    user_id: str, project_id: str, date: str, hours: float, notes: str | None = None
) -> dict[str, Any]:
    """Add a time entry on the operator's behalf. date is YYYY-MM-DD."""
    with tool_resources() as (cfg, db):
        client = _harvest_client(cfg, db)
        return await client.log_time_entry(
            {
                "user_id": user_id,
                "project_id": project_id,
                "date": date,
                "hours": hours,
                "notes": notes,
            }
        )


@async_tool
async def list_time_entries() -> dict[str, Any]:
    """Read recent time entries."""
    with tool_resources() as (cfg, db):
        client = _harvest_client(cfg, db)
        return await client.list_time_entries()


def build_harvest_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="harvest",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[send_invoice, create_project, archive_project, log_time_entry, list_time_entries],
    )
