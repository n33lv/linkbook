"""Gmail sub-agent. Tools wrap integrations/gmail.py.

§4.5 — only known-client threads + Linkbook/* labels are observable; this
agent doesn't read messages, so the scope-discipline rule is enforced by
the listener side. Sends require an explicit recipient.
"""

from __future__ import annotations

from typing import Any

from agentspan.agents import Agent

from ..config import load_config
from ..integrations.gmail import create_gmail_client
from .context import async_tool, get_agent_context, record_tool_call

_INSTRUCTIONS = """\
You handle Gmail actions for a small design studio.

Tools:
  - send_email: send a plain-text email to a recipient
  - apply_labels: tag a thread with one or more labels

When sending an email:
  - never invent recipient addresses
  - keep the body close to the operator-drafted text the orchestrator hands you
  - if the request is ambiguous, return a short clarification instead of guessing

You do not read or summarize email bodies.
"""


@async_tool
async def send_email(to: str, subject: str, body: str, cc: list[str] | None = None) -> dict[str, Any]:
    """Send a plain-text email via Gmail. Returns Gmail's response."""
    ctx = get_agent_context()
    cfg = ctx.cfg
    from sqlalchemy import select
    from ..db.models import IntegrationConnection

    conn = ctx.db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "gmail")
    ).scalar_one_or_none()
    if conn is None:
        record_tool_call("send_email", {"to": to, "subject": subject}, error="gmail not connected")
        raise RuntimeError("gmail integration not connected")
    client = create_gmail_client(cfg, conn)
    try:
        resp = await client.send({"to": to, "cc": cc or [], "subject": subject, "body": body, "thread_id": None})
        record_tool_call(
            "send_email",
            {"to": to, "subject": subject, "cc": cc or []},
            response=resp,
            http_status=200,
        )
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("send_email", {"to": to, "subject": subject}, error=str(e))
        raise


@async_tool
async def apply_labels(thread_id: str, add_label_ids: list[str]) -> dict[str, Any]:
    """Apply Gmail labels to a thread."""
    ctx = get_agent_context()
    from sqlalchemy import select
    from ..db.models import IntegrationConnection

    conn = ctx.db.execute(
        select(IntegrationConnection).where(IntegrationConnection.source == "gmail")
    ).scalar_one_or_none()
    if conn is None:
        record_tool_call("apply_labels", {"thread_id": thread_id, "add": add_label_ids}, error="gmail not connected")
        raise RuntimeError("gmail integration not connected")
    client = create_gmail_client(ctx.cfg, conn)
    try:
        resp = await client.apply_labels(thread_id, add_label_ids)
        record_tool_call(
            "apply_labels",
            {"thread_id": thread_id, "add": add_label_ids},
            response=resp,
            http_status=200,
        )
        return resp
    except Exception as e:  # noqa: BLE001
        record_tool_call("apply_labels", {"thread_id": thread_id, "add": add_label_ids}, error=str(e))
        raise


def build_gmail_agent() -> Agent:
    cfg = load_config()
    model = _resolve_model(cfg)
    return Agent(
        name="gmail",
        model=model,
        instructions=_INSTRUCTIONS,
        tools=[send_email, apply_labels],
    )


def _resolve_model(cfg) -> str:
    """Pick the model the orchestrator + sub-agents use.

    Priority: explicit AGENTSPAN_LLM_MODEL (operator set it) > Anthropic
    default if a key is set > a sensible OpenAI default.
    """
    if cfg.AGENTSPAN_LLM_MODEL:
        return cfg.AGENTSPAN_LLM_MODEL
    if cfg.ANTHROPIC_API_KEY:
        return "anthropic/claude-sonnet-4-6"
    return "openai/gpt-4o-mini"
