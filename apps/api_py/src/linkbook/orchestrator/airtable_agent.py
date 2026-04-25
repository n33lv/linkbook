"""Airtable sub-agent. Tools wrap integrations/airtable.py.

§4.4 — we never restructure their base. Mapping config (which table is
"projects", which fields are status/owner/etc) lives in the mappings
table from onboarding. The agent reads that mapping; it does not invent
field names.
"""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent, tool
from sqlalchemy import select

from ..config import load_config
from ..db.models import IntegrationConnection
from ..integrations.airtable import create_airtable_client
from .context import get_agent_context, record_tool_call

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


def _conn(ctx) -> IntegrationConnection:
    conn = ctx.db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "airtable")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("airtable not connected")
    return conn


def _base_and_table(ctx) -> tuple[str, str]:
    """Pull the base/table mapping from the connection's metadata."""
    conn = _conn(ctx)
    meta = conn.metadata_ or {}
    return (
        str(meta.get("base_id", "app_demo")),
        str(meta.get("projects_table_id", "tbl_projects")),
    )


@tool
async def create_record(fields: dict[str, Any]) -> dict[str, Any]:
    """Create a record in the configured Projects table."""
    ctx = get_agent_context()
    client = create_airtable_client(ctx.cfg, _conn(ctx))
    base_id, table_id = _base_and_table(ctx)
    args = {"baseId": base_id, "tableId": table_id, "fields": fields}
    try:
        resp = await client.create_records(base_id, table_id, [{"fields": fields}])
        record_tool_call("create_record", args, response=resp, http_status=200)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("create_record", args, error=str(e))
        raise


@tool
async def update_record(record_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    """Update fields on an existing record."""
    ctx = get_agent_context()
    client = create_airtable_client(ctx.cfg, _conn(ctx))
    base_id, table_id = _base_and_table(ctx)
    args = {"baseId": base_id, "tableId": table_id, "record_id": record_id, "fields": fields}
    try:
        resp = await client.update_record(base_id, table_id, record_id, fields)
        record_tool_call("update_record", args, response=resp, http_status=200)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("update_record", args, error=str(e))
        raise


@tool
async def list_records() -> dict[str, Any]:
    """List records from the configured Projects table."""
    ctx = get_agent_context()
    client = create_airtable_client(ctx.cfg, _conn(ctx))
    base_id, table_id = _base_and_table(ctx)
    try:
        resp = await client.list_records(base_id, table_id)
        record_tool_call(
            "list_records", {"baseId": base_id, "tableId": table_id}, response=resp, http_status=200
        )
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("list_records", {"baseId": base_id, "tableId": table_id}, error=str(e))
        raise


def build_airtable_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="airtable",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[create_record, update_record, list_records],
    )
