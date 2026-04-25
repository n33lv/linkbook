"""Agent-driven action dispatch (§5.3 + §2.3).

The orchestrator agent + 5 per-source sub-agents replace the manual
switch/case dispatcher in actions/execute.py when USE_AGENT_DISPATCH=true.

How the integration with our existing safety contract works:
  - HITL gate (§2.3) — agents only run when a drafted action is approved
    by a human. The agent doesn't choose what to do; the action params
    define it. The agent decides HOW to do it (which tools to call, in
    what sequence).
  - Idempotency (§2.4) — actions still get hashed and dedupe-checked
    before reaching the agent.
  - Hallucination guard (§5.3) — runs before the orchestrator is
    invoked, in actions/execute.py.
  - Fallback to manual (§5.3) — if the orchestrator fails to form a
    valid tool call after 2 attempts, the action moves to failed and an
    `agent.needs_approval` event hits the inbox.
  - 30s soft-undo (§2.5) — wraps the orchestrator call from the outside.
  - Audit log (§2.6) — every tool call is captured into audit_events.
"""

from .runtime import (
    AgentContext,
    AgentDispatchResult,
    dispatch_via_agents,
    get_agents,
    is_agentspan_available,
    set_agent_context,
)

__all__ = [
    "AgentContext",
    "AgentDispatchResult",
    "dispatch_via_agents",
    "get_agents",
    "is_agentspan_available",
    "set_agent_context",
]
