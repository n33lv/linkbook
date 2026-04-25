"""Mock HTTP transport. Routes requests to per-source handlers by hostname.

Mirrors apps/api/src/integrations/_mocks/transport.ts.
"""

from __future__ import annotations

from typing import Any

from ..http import HttpRequest, HttpResponse, HttpTransport, host_of, set_transport
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
    """Routes requests to per-source handlers by hostname."""

    async def request(self, req: HttpRequest) -> HttpResponse:
        host = host_of(req.url)
        path = req.url[req.url.index(host) + len(host) :].split("?", 1)[0] if host else req.url

        if not host:
            return json_response(404, {"error": f"unmocked url: {req.url}"})

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
