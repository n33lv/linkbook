"""HTTP transport abstraction. Mirrors apps/api/src/integrations/_http/client.ts.

Real fetch (httpx) for prod; mock transport routes to per-source handlers
when USE_INTEGRATION_MOCKS=true.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx


@dataclass
class HttpRequest:
    method: str  # 'GET'|'POST'|'PATCH'|'PUT'|'DELETE'
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    body: Any | None = None
    hint: dict[str, Any] | None = None


@dataclass
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: Any  # parsed JSON if Content-Type matches; else str


class HttpTransport(Protocol):
    async def request(self, req: HttpRequest) -> HttpResponse: ...


class FetchTransport:
    """httpx-backed transport. Used in prod and when USE_INTEGRATION_MOCKS=false."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=30.0)

    async def request(self, req: HttpRequest) -> HttpResponse:
        kwargs: dict[str, Any] = {"headers": dict(req.headers)}
        if req.body is not None:
            if isinstance(req.body, str | bytes):
                kwargs["content"] = req.body
            else:
                kwargs["json"] = req.body
        res = await self._client.request(req.method, req.url, **kwargs)
        ct = res.headers.get("content-type", "")
        body: Any = res.text
        if "application/json" in ct and res.text:
            try:
                body = json.loads(res.text)
            except json.JSONDecodeError:
                pass
        return HttpResponse(
            status=res.status_code,
            headers=dict(res.headers),
            body=body,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# Module-global transport (replaceable). Tests / dev install MockTransport.
_transport: HttpTransport | None = None


def set_transport(t: HttpTransport) -> None:
    global _transport
    _transport = t


def get_transport() -> HttpTransport:
    global _transport
    if _transport is None:
        _transport = FetchTransport()
    return _transport


def host_of(url: str) -> str:
    return urlparse(url).hostname or ""


def http_err(label: str, status: int, body: Any) -> Exception:
    err = HttpError(f"{label} failed: {status}")
    err.status = status
    err.body = body
    return err


class HttpError(Exception):
    status: int = 0
    body: Any = None
