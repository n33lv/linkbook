"""Dispatcher entry point used by actions/execute.py.

Two execution modes, picked at runtime based on env:

1. **Server mode** (preferred — runs show up in the Agentspan UI).
   Triggered when AGENTSPAN_SERVER_URL is set. On the first dispatch we
   `runtime.deploy(orchestrator, *sub_agents)` once to register the agent
   definitions on the server, then every subsequent run is dispatched by
   name (`runtime.run("orchestrator", prompt)`). The Agentspan worker
   process (`linkbook-agent-worker`) holds the Python tool functions and
   polls the server for tool tasks.

2. **Direct mode** (fallback — no UI, but no infra needed).
   When ANTHROPIC_API_KEY is set but AGENTSPAN_SERVER_URL is empty, the
   SDK runs the orchestrator in-process against the LLM directly. Tool
   calls execute locally in the API process. Useful for dev / tests.

When neither key/URL is available we raise NotConfigured and the caller
(actions/execute.py) silently falls back to the manual switch dispatcher.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from ..config import AppConfig
from ..db.models import Action
from ..lib.log import AppLogger
from .context import AgentContext, set_agent_context


class NotConfigured(Exception):
    """Raised when agent dispatch isn't usable. Caller falls back to direct dispatch."""


@dataclass
class AgentDispatchResult:
    ok: bool
    summary: str  # natural-language result from the agent
    trace: list[dict[str, Any]]  # tool-call trace
    fallback_to_manual: bool = False  # §5.3 — set when 2 malformed attempts


def is_agentspan_available(cfg: AppConfig) -> bool:
    """Cheap precondition check before we try to spin up the runtime."""
    try:
        import agentspan.agents  # noqa: F401
    except Exception:
        return False
    # We need either an LLM API key (model goes direct) or an
    # Agentspan server with an LLM configured.
    if cfg.ANTHROPIC_API_KEY:
        os.environ.setdefault("ANTHROPIC_API_KEY", cfg.ANTHROPIC_API_KEY)
        return True
    if cfg.AGENTSPAN_SERVER_URL:
        # Mirror to os.environ so the SDK picks it up.
        os.environ["AGENTSPAN_SERVER_URL"] = str(cfg.AGENTSPAN_SERVER_URL)
        if cfg.AGENTSPAN_API_KEY:
            os.environ["AGENTSPAN_API_KEY"] = cfg.AGENTSPAN_API_KEY
        if cfg.AGENTSPAN_LLM_MODEL:
            os.environ["AGENTSPAN_LLM_MODEL"] = cfg.AGENTSPAN_LLM_MODEL
        return True
    return False


def _server_mode(cfg: AppConfig) -> bool:
    """Server mode dispatches by name through the Agentspan server (UI tracking).
    Direct mode runs in-process against the LLM directly (no UI)."""
    return bool(cfg.AGENTSPAN_SERVER_URL)


# Tracks consecutive malformed-output failures per (subject_ref, action_id)
# so we can apply the §5.3 "fall back to Manual after 2 attempts" rule.
# In-process cache; per-process. Restart resets it (acceptable — a fresh
# server gets a fresh chance).
_FAIL_COUNTS: dict[str, int] = {}


# Built once and reused. build_orchestrator() instantiates 5 sub-agents +
# the top-level Agent; doing that on every action dispatch is wasteful and
# also means deploy() would have to re-register them every time.
_AGENTS_LOCK = threading.Lock()
_AGENTS_CACHE: dict[str, Any] | None = None  # {"orchestrator": Agent, "subs": [Agent, ...]}
_DEPLOYED_TO: str | None = None  # the AGENTSPAN_SERVER_URL we deployed against


def get_agents() -> dict[str, Any]:
    """Return cached {orchestrator, subs}. Builds on first call."""
    global _AGENTS_CACHE
    with _AGENTS_LOCK:
        if _AGENTS_CACHE is None:
            from .airtable_agent import build_airtable_agent
            from .dropboxsign_agent import build_dropboxsign_agent
            from .gmail_agent import build_gmail_agent
            from .harvest_agent import build_harvest_agent
            from .main_agent import build_orchestrator
            from .qbo_agent import build_qbo_agent

            subs = [
                build_gmail_agent(),
                build_qbo_agent(),
                build_harvest_agent(),
                build_dropboxsign_agent(),
                build_airtable_agent(),
            ]
            orchestrator = build_orchestrator()
            _AGENTS_CACHE = {"orchestrator": orchestrator, "subs": subs}
        return _AGENTS_CACHE


def _ensure_deployed(cfg: AppConfig, log: AppLogger) -> None:
    """Push agent defs to the server once per process per server URL.
    No-op in direct mode."""
    global _DEPLOYED_TO
    if not _server_mode(cfg):
        return
    target = str(cfg.AGENTSPAN_SERVER_URL)
    if _DEPLOYED_TO == target:
        return
    from agentspan.agents import AgentRuntime

    agents = get_agents()
    log.info(
        {"server": target, "agents": ["orchestrator", *(a.name for a in agents["subs"])]},
        "deploying agents to Agentspan server",
    )
    with AgentRuntime() as rt:
        rt.deploy(agents["orchestrator"], *agents["subs"])
    _DEPLOYED_TO = target


def _build_prompt(action: Action) -> str:
    """Build a structured prompt for the orchestrator from an action.

    The action's `type` + `params` already say everything the agent needs
    to dispatch. We pass them as-is so the LLM doesn't have to guess.
    """
    return (
        f"Execute this action.\n"
        f"action_type: {action.type}\n"
        f"subject_ref: {action.subject_ref}\n"
        f"params:\n{json.dumps(action.params, indent=2, default=str)}\n"
        f"\nUse the right specialist tool. Don't invent values. "
        f"After the tool returns, summarize what you did in one sentence."
    )


async def dispatch_via_agents(
    cfg: AppConfig,
    db: Session,
    log: AppLogger,
    action: Action,
) -> AgentDispatchResult:
    """Run the orchestrator for a single action. The caller (execute.py)
    has already done the hallucination guard + status flip; we just need
    to make the integration calls happen via tools and capture the trace.
    """
    if not is_agentspan_available(cfg):
        raise NotConfigured(
            "agent dispatch needs ANTHROPIC_API_KEY or AGENTSPAN_SERVER_URL"
        )

    # Fresh trace bucket for this dispatch.
    ctx = AgentContext(
        cfg=cfg,
        db=db,
        action_id=action.id,
        subject_ref=action.subject_ref,
        trace=[],
    )
    set_agent_context(ctx)

    try:
        from agentspan.agents import AgentRuntime

        agents = get_agents()
        prompt = _build_prompt(action)

        # In server mode we deploy once and dispatch by name so the UI
        # records it. In direct mode we hand the Agent object straight to
        # run() and the SDK executes it locally.
        if _server_mode(cfg):
            _ensure_deployed(cfg, log)
            target: Any = "orchestrator"
            mode = "server"
        else:
            target = agents["orchestrator"]
            mode = "direct"

        log.info(
            {"action_id": action.id, "type": action.type, "mode": mode},
            "dispatching via Agentspan orchestrator",
        )

        # AgentRuntime is a sync context manager today. Wrap in an executor
        # so we don't block the asyncio loop.
        import asyncio

        def _run() -> Any:
            with AgentRuntime() as runtime:
                return runtime.run(
                    target,
                    prompt,
                    idempotency_key=action.idempotency_key,
                )

        try:
            result = await asyncio.to_thread(_run)
        except Exception as e:  # noqa: BLE001
            # SDK / server / model failure. Bump fail count; if we hit 2,
            # surface the §5.3 fallback signal.
            n = _FAIL_COUNTS.get(action.id, 0) + 1
            _FAIL_COUNTS[action.id] = n
            log.warn({"action_id": action.id, "attempt": n, "err": str(e)}, "agent run failed")
            if n >= 2:
                _FAIL_COUNTS.pop(action.id, None)
                return AgentDispatchResult(
                    ok=False,
                    summary=f"agent failed after {n} attempts: {e}",
                    trace=ctx.trace,
                    fallback_to_manual=True,
                )
            raise

        # Reset fail count on success.
        _FAIL_COUNTS.pop(action.id, None)

        summary = _summary_from_result(result)
        return AgentDispatchResult(ok=True, summary=summary, trace=ctx.trace)
    finally:
        # Clear the context so a follow-up tool call can't accidentally
        # write into a stale trace.
        set_agent_context(None)


def _summary_from_result(result: Any) -> str:
    """Best-effort extraction of a human-readable summary from Agentspan's
    Result object. SDK shape varies by version; we try a few attrs and
    fall back to repr."""
    for attr in ("output", "text", "content", "final_output"):
        val = getattr(result, attr, None)
        if isinstance(val, str) and val.strip():
            return val.strip()
    # As a last resort: stringify it. result.print_result() exists per the
    # examples but writes to stdout; we want a string.
    return str(result)


__all__ = [
    "AgentContext",
    "AgentDispatchResult",
    "NotConfigured",
    "dispatch_via_agents",
    "is_agentspan_available",
    "get_agents",
    "set_agent_context",
]
