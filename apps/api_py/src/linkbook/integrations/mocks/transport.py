"""Mock HTTP transport. Routes requests to per-source handlers by hostname.

Per-source live escape hatch: if a hostname maps to a source listed in
INTEGRATION_LIVE_SOURCES, this transport delegates to the real httpx
transport instead of the mock handler. Lets you take one source live
(e.g. harvest) while everything else stays mocked.
"""

from __future__ import annotations

from typing import Any

from ...config import live_sources, load_config, source_for_host
from ..http import FetchTransport, HttpRequest, HttpResponse, host_of, set_transport
from .store import get_mock_store


def json_response(status: int, body: Any) -> HttpResponse:
    return HttpResponse(status=status, headers={"content-type": "application/json"}, body=body)


def consume_failure_for(key: str) -> HttpResponse | None:
    store = get_mock_store()
    spec = store.failures.consume(key)
    if spec is None:
        return None
    return HttpResponse(
        status=spec.status,
        headers={"content-type": "application/json"},
        body=spec.body if spec.body is not None else {"error": f"injected failure ({spec.status})"},
    )


class MockTransport:
    """Routes requests to per-source handlers by hostname.

    Sources whose name is in INTEGRATION_LIVE_SOURCES skip mocking and
    pass through to a real httpx transport.
    """

    def __init__(self) -> None:
        # Built lazily so a config reload during the process can be picked
        # up by a fresh MockTransport instance, but per-request lookup is
        # O(1) against the cached set.
        cfg = load_config()
        self._live: set[str] = live_sources(cfg)
        # Real transport reused across all live-source requests.
        self._real: FetchTransport | None = FetchTransport() if self._live else None

    async def request(self, req: HttpRequest) -> HttpResponse:
        host = host_of(req.url)
        path = req.url[req.url.index(host) + len(host) :].split("?", 1)[0] if host else req.url

        if not host:
            return json_response(404, {"error": f"unmocked url: {req.url}"})

        # Per-source live override — bypass mocks for this request.
        source = source_for_host(host)
        if source and source in self._live and self._real is not None:
            return await self._real.request(req)

        if "intuit.com" in host or "quickbooks" in host:
            from . import qbo

            return await qbo.handle(req, path)
        if "harvestapp.com" in host or "harvest.com" in host:
            from . import harvest

            return await harvest.handle(req, path)
        if "dropboxsign.com" in host or "hellosign.com" in host:
            from . import dropboxsign

            return await dropboxsign.handle(req, path)
        if "airtable.com" in host:
            from . import airtable

            return await airtable.handle(req, path)
        if "googleapis.com" in host or "gmail.com" in host:
            from . import gmail

            return await gmail.handle(req, path)

        return json_response(404, {"error": f"unmocked host: {host}"})


def install_mock_transport() -> None:
    set_transport(MockTransport())
