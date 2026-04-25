"""Entry point so `python -m linkbook` boots the API on 127.0.0.1:3000.

Defaults to 127.0.0.1 + port 3000 — match the Vite dev proxy without any
shell flags. Override via env: PORT, HOST.

Reload mode is OFF by default. uvicorn's reload spawns a parent + worker
process pair which can leave orphans on hard crash, leading to "two
servers on the same port" bugs. Set RELOAD=true to opt back in.
"""

from __future__ import annotations

import os
import socket
import sys

import uvicorn


def _port_in_use(host: str, port: int) -> bool:
    """Check if anything is *actively listening* on host:port.

    We use SO_REUSEADDR so a freshly-released TIME_WAIT socket from a
    just-killed previous server doesn't trip the check. We then probe by
    trying to connect — if the connect succeeds, something is listening.
    Pure bind() without SO_REUSEADDR sees TIME_WAIT as in-use, which led
    to spurious "port already has a listener" errors.
    """
    # 1. cheap: try to connect. If we can, port is held by a live server.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.15)
        try:
            s.connect((host, port))
            return True
        except OSError:
            pass
    # 2. Try to bind with SO_REUSEADDR; if even that fails, something's
    # genuinely holding the address.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return False
        except OSError:
            return True


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "3000"))
    reload = os.environ.get("RELOAD", "").lower() in ("1", "true", "yes")

    if _port_in_use(host, port):
        print(
            f"\033[31merror:\033[0m port {port} on {host} already has a "
            f"listener.\n"
            f"  another linkbook is probably running. find + kill it:\n"
            f"    lsof -iTCP:{port} -sTCP:LISTEN\n"
            f"    pkill -f linkbook\n",
            file=sys.stderr,
        )
        sys.exit(1)

    uvicorn.run(
        "linkbook.app:app",
        host=host,
        port=port,
        reload=reload,
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
