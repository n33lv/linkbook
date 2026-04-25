"""Dropbox Sign mock — mirrors apps/api/src/integrations/_mocks/dropboxsign.ts."""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone

from ..http import HttpRequest, HttpResponse
from .store import MockContract, get_mock_store
from .transport import consume_failure_for, json_response


async def handle(req: HttpRequest, path: str) -> HttpResponse:
    fail = consume_failure_for(f"dropboxsign:{req.method} {path}")
    if fail is not None:
        return fail
    store = get_mock_store()

    m = re.match(r"^/v3/signature_request/remind/([^/]+)$", path)
    if req.method == "POST" and m:
        sig_id = m.group(1)
        if sig_id not in store.contracts:
            return json_response(404, {"error": "signature_request not found"})
        store.contract_reminders.append(
            {"signature_request_id": sig_id, "at": datetime.now(timezone.utc).isoformat()}
        )
        return json_response(200, {"signature_request_id": sig_id, "reminded": True})

    if req.method == "POST" and path == "/v3/signature_request/send_with_template":
        body = req.body or {}
        new_id = f"sig_{int(time.time() * 1000)}"
        store.contracts[new_id] = MockContract(
            id=new_id,
            title=body.get("title", ""),
            recipient=body.get("recipient", ""),
            status="sent",
            sent_at=datetime.now(timezone.utc).isoformat(),
            signed_at=None,
        )
        return json_response(201, {"signature_request_id": new_id, "status": "sent"})

    m = re.match(r"^/v3/signature_request/cancel/([^/]+)$", path)
    if req.method == "POST" and m:
        sig_id = m.group(1)
        c = store.contracts.get(sig_id)
        if c is None:
            return json_response(404, {"error": "not found"})
        c.status = "expired"
        return json_response(200, {"signature_request_id": sig_id, "cancelled": True})

    return json_response(404, {"error": f"dropboxsign: unmocked {req.method} {path}"})
