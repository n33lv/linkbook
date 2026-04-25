"""Entry point so `python -m linkbook` boots the API on 127.0.0.1:3000.

Defaults to 127.0.0.1 + port 3000 — match the Vite dev proxy without any
shell flags. Override via env: PORT, HOST. Reload mode is on in
development.
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "3000"))
    reload = os.environ.get("NODE_ENV", "development") == "development"
    uvicorn.run(
        "linkbook.app:app",
        host=host,
        port=port,
        reload=reload,
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
