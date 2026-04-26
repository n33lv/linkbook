"""QuickBooks sub-agent. Tools wrap integrations/qbo.py.

§4.1 hard rules — never write to journal entries, never touch closed-period
transactions. The tool surface is intentionally narrow: get_invoice for the
hallucination guard's read path, apply_payment + mark_invoice_paid for the
write paths the spec explicitly allows.
"""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent
from sqlalchemy import select

from ..config import load_config
from ..db.models import IntegrationConnection
from ..integrations.qbo import create_qbo_client
from .context import async_tool, get_agent_context, record_tool_call

_INSTRUCTIONS = """\
You handle QuickBooks actions for a small design studio.

Tools:
  - get_invoice: read-only invoice status check
  - apply_payment: link a received payment to an invoice
  - mark_invoice_paid: mark an invoice paid manually
  - void_invoice: void an invoice (compensating undo)

Hard constraints:
  - You NEVER write to journal entries.
  - You NEVER touch closed-period transactions.
  - Invoice creation is out of scope. Drafts happen in Harvest.

When the orchestrator passes you a payment.apply task, the matched invoice
ID is in the params. Verify the amount matches the payment before applying.
"""


def _conn(ctx) -> IntegrationConnection:
    conn = ctx.db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "qbo")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("qbo integration not connected")
    return conn


@async_tool
async def get_invoice(invoice_id: str) -> dict[str, Any]:
    """Fetch a single invoice's current status. Read-only."""
    ctx = get_agent_context()
    client = create_qbo_client(ctx.cfg, _conn(ctx))
    try:
        resp = await client.get_invoice(invoice_id)
        record_tool_call("get_invoice", {"invoice_id": invoice_id}, response=resp, http_status=200)
        return resp or {"status": "not_found"}
    except Exception as e:  # noqa: BLE001
        record_tool_call("get_invoice", {"invoice_id": invoice_id}, error=str(e))
        raise


@async_tool
async def apply_payment(payment_id: str, invoice_id: str, amount_cents: int) -> dict[str, Any]:
    """Link a received payment to an invoice."""
    ctx = get_agent_context()
    client = create_qbo_client(ctx.cfg, _conn(ctx))
    args = {"payment_id": payment_id, "invoice_id": invoice_id, "amount_cents": amount_cents}
    try:
        resp = await client.apply_payment(args)
        record_tool_call("apply_payment", args, response=resp, http_status=200)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("apply_payment", args, error=str(e))
        raise


@async_tool
async def mark_invoice_paid(invoice_id: str) -> dict[str, Any]:
    """Mark an invoice as paid manually (compensating-undoable via void)."""
    ctx = get_agent_context()
    client = create_qbo_client(ctx.cfg, _conn(ctx))
    args = {"invoice_id": invoice_id, "mark": "paid"}
    try:
        resp = await client.update_invoice(args)
        record_tool_call("mark_invoice_paid", args, response=resp, http_status=200)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("mark_invoice_paid", args, error=str(e))
        raise


@async_tool
async def void_invoice(invoice_id: str) -> dict[str, Any]:
    """Void an invoice. Used as the compensating undo for an erroneous mark_paid."""
    ctx = get_agent_context()
    client = create_qbo_client(ctx.cfg, _conn(ctx))
    args = {"invoice_id": invoice_id, "mark": "voided"}
    try:
        resp = await client.update_invoice(args)
        record_tool_call("void_invoice", args, response=resp, http_status=200)
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("void_invoice", args, error=str(e))
        raise


def build_qbo_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="qbo",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[get_invoice, apply_payment, mark_invoice_paid, void_invoice],
    )
