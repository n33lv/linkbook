"""Long-lived Agentspan worker.

Run alongside the API (`linkbook-agent-worker`) when AGENTSPAN_SERVER_URL
is set. The API process pushes agent runs to the server by name; the
server breaks each run into tool tasks and hands them out to workers;
this process holds the actual Python tool functions and executes them.

Without a worker running, server-mode dispatch will hang waiting for
tools to be picked up. In direct mode (no AGENTSPAN_SERVER_URL) you do
NOT need this — the API process executes tools in-line.
"""

from __future__ import annotations

import sys

from agentspan.agents import AgentRuntime

from ..config import load_config
from ..lib.log import app_logger, configure
from .runtime import _ensure_deployed, get_agents, is_agentspan_available


def main() -> None:
    cfg = load_config()
    configure(cfg.LOG_LEVEL)
    log = app_logger()

    if not is_agentspan_available(cfg):
        print(
            "error: agentspan worker needs AGENTSPAN_SERVER_URL "
            "(and optionally AGENTSPAN_API_KEY) to be set.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not cfg.AGENTSPAN_SERVER_URL:
        print(
            "error: linkbook-agent-worker is for server mode only. "
            "Set AGENTSPAN_SERVER_URL to point at your Agentspan server.",
            file=sys.stderr,
        )
        sys.exit(1)

    agents = get_agents()
    # Make sure the server has the latest agent definitions before we
    # start polling for tasks. Cheap: just a single push at startup.
    _ensure_deployed(cfg, log)

    log.info(
        {
            "server": str(cfg.AGENTSPAN_SERVER_URL),
            "agents": ["orchestrator", *(a.name for a in agents["subs"])],
        },
        "agentspan worker starting — polling for tool tasks",
    )

    # blocking=True keeps the process alive until SIGTERM/Ctrl-C.
    with AgentRuntime() as rt:
        rt.serve(agents["orchestrator"], *agents["subs"], blocking=True)


if __name__ == "__main__":
    main()
