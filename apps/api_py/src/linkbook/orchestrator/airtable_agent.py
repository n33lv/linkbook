"""Airtable sub-agent. Tools wrap integrations/airtable.py.

§4.4 — we never restructure their base. Mapping config (which table is
"projects", which fields are status/owner/etc) lives in the mappings
table from onboarding. The agent reads that mapping; it does not invent
field names.
"""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import AppConfig, load_config
from ..db.models import IntegrationConnection
from ..integrations.airtable import create_airtable_client
from .context import async_tool, tool_resources

_INSTRUCTIONS = """\
You handle Airtable actions for a small design studio.

Tools:
  - create_record: insert a new record into a table
  - update_record: update fields on an existing record
  - list_records: read records from a table

The studio's table id and field mapping come from the action params.
Never invent field names; only use the ones the orchestrator gave you.
We never restructure the studio's base.
"""


def _airtable_client_and_target(cfg: AppConfig, db: Session):
    """Return (client, base_id, table_id) for the Projects table."""
    conn = db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "airtable")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("airtable not connected")
    meta = conn.metadata_ or {}
    base_id = str(meta.get("base_id", "app_demo"))
    table_id = str(meta.get("projects_table_id", "tbl_projects"))
    return create_airtable_client(cfg, conn), base_id, table_id


@async_tool
async def create_record(fields: dict[str, Any]) -> dict[str, Any]:
    """Create a record in the configured Projects table."""
    with tool_resources() as (cfg, db):
        client, base_id, table_id = _airtable_client_and_target(cfg, db)
        return await client.create_records(base_id, table_id, [{"fields": fields}])


@async_tool
async def update_record(record_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    """Update fields on an existing record."""
    with tool_resources() as (cfg, db):
        client, base_id, table_id = _airtable_client_and_target(cfg, db)
        return await client.update_record(base_id, table_id, record_id, fields)


@async_tool
async def list_records() -> dict[str, Any]:
    """List records from the configured Projects table."""
    with tool_resources() as (cfg, db):
        client, base_id, table_id = _airtable_client_and_target(cfg, db)
        return await client.list_records(base_id, table_id)


def build_airtable_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="airtable",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[create_record, update_record, list_records],
    )
