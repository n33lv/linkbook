"""Helpers for Agentspan tools.

Architecture decision (post-PoC): tools are STATELESS. They don't read
from a process-local ContextVar. This is required because Agentspan in
server mode runs tools in subprocess workers spawned by the SDK, and
ContextVars are per-process — anything we set in the API process is
invisible to the worker.

Instead, every tool builds its own AppConfig and opens its own DB
session at call time. AppConfig comes from env (which workers inherit
on spawn), and SQLite handles concurrent connections fine in WAL mode.

The trade: there's no shared per-action trace. Tools just do their job
and return JSON. The Agentspan UI shows the call sequence; the
action-level audit row in our DB notes "executed via agent." This keeps
tools fully portable between in-process direct mode and out-of-process
worker mode without conditional branches.

The legacy ContextVar (AgentContext / set_agent_context / get_agent_context)
remains so manual-dispatch tests and any in-process code paths that still
expect it don't break — but new tool code should use tool_resources().
"""

from __future__ import annotations

import asyncio
import functools
import inspect
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Iterator, TypeVar

from sqlalchemy.orm import Session

from agentspan.agents import tool

from ..config import AppConfig, load_config
from ..db import open_session

F = TypeVar("F", bound=Callable[..., Any])


def async_tool(fn: F) -> F:
    """Wrap an async @tool body into a sync function the Agentspan worker
    can call. Without this, the SDK's task dispatcher receives a
    coroutine object back, fails JSON-serialization, and trips the tool
    circuit breaker after 10 retries.

    Each call creates a fresh event loop because workers run in threads
    that don't have one. If a loop is already running (e.g. in-process
    direct mode used by older callers), we fall back to a worker thread.
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
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(asyncio.run, fn(*args, **kwargs)).result()

    return tool(sync_wrapper)  # type: ignore[return-value]


@contextmanager
def tool_resources() -> Iterator[tuple[AppConfig, Session]]:
    """Build a per-call (AppConfig, DB session) pair for an Agentspan tool.

    Each invocation gets fresh resources, which lets the same tool body
    run identically in-process (direct mode) and in a subprocess worker
    (server mode). The session is closed when the context exits. AppConfig
    is a Pydantic-settings instance built from env, which workers inherit.
    """
    cfg = load_config()
    db = open_session()
    try:
        yield cfg, db
    finally:
        db.close()


# ---------- legacy ContextVar (kept for non-agent code paths) ----------
# Code that doesn't go through Agentspan (manual dispatcher, tests that
# poke at action context) can still rely on these. New tool code should
# use tool_resources() instead.


@dataclass
class AgentContext:
    cfg: AppConfig
    db: Session
    action_id: str
    subject_ref: str
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
    """Append a tool-call entry to the active context's trace.

    No-op in worker mode (no ContextVar). Kept so legacy callers don't
    crash; the canonical trace is the Agentspan UI.
    """
    ctx = _CTX.get()
    if ctx is None:
        return
    entry: dict[str, Any] = {"tool": tool, "args": args}
    if response is not None:
        entry["response"] = response
    if http_status is not None:
        entry["http_status"] = http_status
    if error is not None:
        entry["error"] = error
    ctx.trace.append(entry)
