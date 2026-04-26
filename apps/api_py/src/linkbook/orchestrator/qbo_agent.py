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
from sqlalchemy.orm import Session

from ..config import AppConfig, load_config
from ..db.models import IntegrationConnection
from ..integrations.qbo import create_qbo_client
from .context import async_tool, tool_resources

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


def _qbo_client(cfg: AppConfig, db: Session):
    conn = db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "qbo")
    ).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("qbo integration not connected")
    return create_qbo_client(cfg, conn)


@async_tool
async def get_invoice(invoice_id: str) -> dict[str, Any]:
    """Fetch a single invoice's current status. Read-only."""
    with tool_resources() as (cfg, db):
        client = _qbo_client(cfg, db)
        resp = await client.get_invoice(invoice_id)
        return resp or {"status": "not_found"}


@async_tool
async def apply_payment(payment_id: str, invoice_id: str, amount_cents: int) -> dict[str, Any]:
    """Link a received payment to an invoice."""
    with tool_resources() as (cfg, db):
        client = _qbo_client(cfg, db)
        return await client.apply_payment(
            {"payment_id": payment_id, "invoice_id": invoice_id, "amount_cents": amount_cents}
        )


@async_tool
async def mark_invoice_paid(invoice_id: str) -> dict[str, Any]:
    """Mark an invoice as paid manually (compensating-undoable via void)."""
    with tool_resources() as (cfg, db):
        client = _qbo_client(cfg, db)
        return await client.update_invoice({"invoice_id": invoice_id, "mark": "paid"})


@async_tool
async def void_invoice(invoice_id: str) -> dict[str, Any]:
    """Void an invoice. Used as the compensating undo for an erroneous mark_paid."""
    with tool_resources() as (cfg, db):
        client = _qbo_client(cfg, db)
        return await client.update_invoice({"invoice_id": invoice_id, "mark": "voided"})


def build_qbo_agent() -> Agent:
    from .gmail_agent import _resolve_model

    cfg = load_config()
    return Agent(
        name="qbo",
        model=_resolve_model(cfg),
        instructions=_INSTRUCTIONS,
        tools=[get_invoice, apply_payment, mark_invoice_paid, void_invoice],
    )
