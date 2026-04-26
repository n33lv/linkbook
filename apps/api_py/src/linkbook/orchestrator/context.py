"""Per-call context for agent tools.

Agentspan tools are bare Python functions, not methods. They don't get
ctx/db/cfg injected. We set the active context at the start of each
dispatch (in `runtime.dispatch_via_agents`) and tools read from it.

Single-process v1 is fine because the API serializes calls per dispatch.
When we move to a worker pool, this becomes a contextvars.ContextVar.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

from sqlalchemy.orm import Session

from ..config import AppConfig
from agentspan.agents import tool

F = TypeVar("F", bound=Callable[..., Any])


def async_tool(fn: F) -> F:
    """Wrap an async @tool body into a sync function the Agentspan worker
    can call. Without this, the SDK's task dispatcher receives a
    coroutine object back, fails JSON-serialization, and trips the tool
    circuit breaker after 10 retries. The wrapper runs the coroutine to
    completion and returns the awaited value.

    Each call creates a fresh event loop because workers run in threads
    that don't have one. If a loop is already running (e.g. in-process
    direct mode), we fall back to scheduling on it.
    """
    if not inspect.iscoroutinefunction(fn):
        return tool(fn)  # already sync — pass straight through

    @functools.wraps(fn)
    def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is None:
            return asyncio.run(fn(*args, **kwargs))
        # A loop is already running on this thread (rare in worker mode,
        # but possible in tests): run in a fresh thread to avoid nesting.
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(asyncio.run, fn(*args, **kwargs)).result()

    return tool(sync_wrapper)  # type: ignore[return-value]


@dataclass
class AgentContext:
    cfg: AppConfig
    db: Session
    # The action this agent run is fulfilling. Tools read action_id /
    # subject_ref so they can attribute their HTTP calls back to the
    # right audit row.
    action_id: str
    subject_ref: str
    # Captured tool-call trace for the audit log. Each entry: {tool,
    # args, response, http_status (optional), error (optional)}. The
    # dispatcher writes this into audit_events on action.succeeded /
    # action.failed.
    trace: list[dict[str, Any]]


_CTX: ContextVar[AgentContext | None] = ContextVar("agent_ctx", default=None)


def set_agent_context(ctx: AgentContext | None) -> None:
    _CTX.set(ctx)


def get_agent_context() -> AgentContext:
    ctx = _CTX.get()
    if ctx is None:
        raise RuntimeError("agent tool called outside of an agent dispatch")
    return ctx


def record_tool_call(
    tool: str,
    args: dict[str, Any],
    response: Any = None,
    http_status: int | None = None,
    error: str | None = None,
) -> None:
    """Append a tool-call entry to the active context's trace."""
    ctx = get_agent_context()
    entry: dict[str, Any] = {"tool": tool, "args": args}
    if response is not None:
        entry["response"] = response
    if http_status is not None:
        entry["http_status"] = http_status
    if error is not None:
        entry["error"] = error
    ctx.trace.append(entry)
