"""Engine + session factories. Single global engine; session per request."""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker

from ..config import sqlalchemy_url

_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def create_engine_from_url(url: str) -> Engine:
    """Build a SQLite engine. WAL mode + FK enforcement match the Drizzle
    runtime in apps/api/src/db/client.ts."""
    sa_url = sqlalchemy_url(url)
    engine = create_engine(
        sa_url,
        connect_args={"check_same_thread": False},
        future=True,
    )

    @event.listens_for(engine, "connect")
    def _set_pragmas(dbapi_conn: Any, _record: Any) -> None:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode = WAL")
        cur.execute("PRAGMA foreign_keys = ON")
        cur.execute("PRAGMA synchronous = NORMAL")
        cur.close()

    return engine


def get_engine(url: str | None = None) -> Engine:
    """Returns the global engine. First call lazily builds it."""
    global _engine, _SessionLocal
    if _engine is None:
        if url is None:
            from ..config import load_config

            url = load_config().DATABASE_URL
        _engine = create_engine_from_url(url)
        _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def get_session() -> Generator[Session, None, None]:
    """FastAPI dependency. Closes on request end."""
    if _SessionLocal is None:
        get_engine()
    assert _SessionLocal is not None
    sess = _SessionLocal()
    try:
        yield sess
    finally:
        sess.close()


def close_engine() -> None:
    """Tear down for graceful shutdown / tests."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
        _engine = None
        _SessionLocal = None


def open_session() -> Session:
    """Manual session — used by background paths (queue timer, agents)."""
    if _SessionLocal is None:
        get_engine()
    assert _SessionLocal is not None
    return _SessionLocal()


__all__ = ["close_engine", "create_engine_from_url", "get_engine", "get_session", "open_session", "text"]
