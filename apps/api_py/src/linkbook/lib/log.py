"""Structured logging — small wrapper that mirrors AppLogger in TS."""

from __future__ import annotations

import logging

import structlog


def configure(level: str = "info") -> None:
    lvl = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(level=lvl, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(lvl),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "linkbook") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


# Minimal Logger Protocol identical to AppLogger in TS.
class AppLogger:
    """Adapter so callers don't need to know about structlog."""

    def __init__(self, log: structlog.stdlib.BoundLogger) -> None:
        self._l = log

    def info(self, obj: object | None = None, msg: str = "") -> None:
        self._l.info(msg, **(obj or {}) if isinstance(obj, dict) else {"obj": obj})

    def warn(self, obj: object | None = None, msg: str = "") -> None:
        self._l.warning(msg, **(obj or {}) if isinstance(obj, dict) else {"obj": obj})

    warning = warn

    def error(self, obj: object | None = None, msg: str = "") -> None:
        self._l.error(msg, **(obj or {}) if isinstance(obj, dict) else {"obj": obj})

    def debug(self, obj: object | None = None, msg: str = "") -> None:
        self._l.debug(msg, **(obj or {}) if isinstance(obj, dict) else {"obj": obj})


def app_logger() -> AppLogger:
    return AppLogger(get_logger())
