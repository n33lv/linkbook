"""FastAPI app factory + lifespan. Mirrors apps/api/src/server.ts.

Boot:
  - load + validate config
  - build engine + apply schema (idempotent)
  - install mock transport when USE_INTEGRATION_MOCKS=true
  - recover queued_30s rows from DB
  - register routes + global error handler

Shutdown:
  - cancel queue timers
  - dispose engine
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .actions.queue import clear_all_timers, recover_queue_on_boot
from .config import load_config
from .db import close_engine, get_engine, get_session, open_session
from .integrations.mocks import install_mock_transport
from .lib.log import app_logger, configure
from .routes import (
    actions_routes,
    dashboard_routes,
    dev_routes,
    events_routes,
    inbox_routes,
    integrations_oauth,
    integrations_routes,
)
from .routes.webhooks import (
    airtable_webhook,
    dropboxsign_webhook,
    gmail_webhook,
    harvest_webhook,
)


def build_app() -> FastAPI:
    cfg = load_config()
    configure(cfg.LOG_LEVEL)
    log = app_logger()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Startup
        eng = get_engine(cfg.DATABASE_URL)
        # idempotent — applies schema if missing
        from .db.models import Base

        Base.metadata.create_all(eng)

        if cfg.USE_INTEGRATION_MOCKS:
            install_mock_transport()
            log.info({}, "integration mocks installed (USE_INTEGRATION_MOCKS=true)")

        # Restart recovery for queued_30s rows.
        with open_session() as db:
            await recover_queue_on_boot(db, log)

        log.info(
            {"port": cfg.PORT, "studio": cfg.STUDIO_NAME, "user": cfg.DEV_PRINCIPAL_EMAIL},
            "Linkbook API ready",
        )
        try:
            yield
        finally:
            # Shutdown
            log.info({}, "shutting down")
            clear_all_timers()
            close_engine()

    app = FastAPI(title="Linkbook API", lifespan=lifespan)

    # CORS — only allow the local Vite dev server in dev. Prod is locked
    # to same-origin until we have a multi-domain story.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=(
            ["http://localhost:5173", "http://127.0.0.1:5173"]
            if cfg.NODE_ENV == "development"
            else []
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Global error handler — Pydantic ValidationError → 400; everything
    # else → 500 with a request_id (stack trace stays in logs).
    @app.exception_handler(ValidationError)
    async def _on_validation_error(_req: Request, exc: ValidationError) -> JSONResponse:  # noqa: D401
        return JSONResponse(
            status_code=400,
            content={
                "error": "invalid_request",
                "issues": [
                    {"path": list(e["loc"]), "message": e["msg"]} for e in exc.errors()
                ],
            },
        )

    @app.exception_handler(Exception)
    async def _on_unhandled(_req: Request, exc: Exception) -> JSONResponse:  # noqa: D401
        rid = str(uuid.uuid4())
        log.error({"err": str(exc), "request_id": rid}, "unhandled route error")
        return JSONResponse(status_code=500, content={"error": "internal", "request_id": rid})

    @app.get("/healthz")
    async def _healthz() -> dict[str, bool]:
        return {"ok": True}

    app.include_router(inbox_routes.router)
    app.include_router(actions_routes.router)
    app.include_router(events_routes.router)
    app.include_router(dashboard_routes.router)
    app.include_router(integrations_routes.router)
    app.include_router(integrations_oauth.router)
    app.include_router(dev_routes.router)
    app.include_router(harvest_webhook.router)
    app.include_router(dropboxsign_webhook.router)
    app.include_router(airtable_webhook.router)
    app.include_router(gmail_webhook.router)

    # Expose deps for tests.
    app.state.cfg = cfg
    app.state.get_session = get_session

    return app


# Default app for `uvicorn linkbook.app:app`.
app = build_app()
