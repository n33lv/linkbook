"""Shared fixtures."""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio


@pytest.fixture(autouse=True)
def env_setup() -> Iterator[None]:
    keep = dict(os.environ)
    os.environ.setdefault("DEV_PRINCIPAL_EMAIL", "neel@flightdesign.co")
    os.environ.setdefault("DEV_PRINCIPAL_NAME", "Neel")
    os.environ.setdefault("STUDIO_NAME", "Flight Design Co.")
    os.environ.setdefault("STUDIO_FISCAL_YEAR_START", "01-01")
    os.environ.setdefault("STUDIO_BILLABLE_TARGET_PCT", "70")
    os.environ.setdefault("STUDIO_LOADED_COST_RATE", "85")
    os.environ.setdefault("USE_INTEGRATION_MOCKS", "true")
    # Tests run against pure mocks. Force-clear any developer-only .env
    # leakage that would otherwise redirect calls at real APIs / a real
    # Agentspan server and break the suite. setdefault won't suffice
    # because pydantic-settings reads .env on disk.
    os.environ["INTEGRATION_LIVE_SOURCES"] = ""
    os.environ["USE_AGENT_DISPATCH"] = "false"
    os.environ["AGENTSPAN_SERVER_URL"] = ""
    os.environ["AGENTSPAN_API_KEY"] = ""
    os.environ["AGENTSPAN_LLM_MODEL"] = ""
    os.environ["ANTHROPIC_API_KEY"] = ""
    os.environ["HARVEST_CLIENT_ID"] = ""
    os.environ["HARVEST_CLIENT_SECRET"] = ""
    os.environ["HARVEST_REDIRECT_URI"] = ""
    os.environ.setdefault("LOG_LEVEL", "fatal")
    os.environ.setdefault("PORT", "3001")
    os.environ.setdefault("NODE_ENV", "test")
    yield
    os.environ.clear()
    os.environ.update(keep)


@pytest.fixture
def tmp_db_path() -> Iterator[str]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        yield path
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


@pytest_asyncio.fixture
async def app_client(tmp_db_path: str) -> AsyncIterator[tuple[object, object]]:
    """In-process FastAPI app + httpx ASGI client. Lifespan runs around it."""
    os.environ["DATABASE_URL"] = f"file:{tmp_db_path}"

    from linkbook.db import close_engine
    close_engine()

    import importlib
    import linkbook.app as app_mod
    importlib.reload(app_mod)
    app = app_mod.build_app()

    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    # Drive the FastAPI lifespan manually.
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield app, ac

    close_engine()
    from linkbook.integrations.mocks import reset_mock_store
    reset_mock_store()
