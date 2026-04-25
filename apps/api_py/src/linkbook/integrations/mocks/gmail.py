"""Gmail mock — mirrors apps/api/src/integrations/_mocks/gmail.ts."""

from __future__ import annotations

import base64
import re
import time
from datetime import datetime, timezone

from ..http import HttpRequest, HttpResponse
from .store import get_mock_store
from .transport import consume_failure_for, json_response


async def handle(req: HttpRequest, path: str) -> HttpResponse:
    fail = consume_failure_for(f"gmail:{req.method} {path}")
    if fail is not None:
        return fail
    store = get_mock_store()

    if req.method == "POST" and path.endswith("/messages/send"):
        body = req.body or {}
        new_id = f"gm_{int(time.time() * 1000)}"
        store.sent_emails.append(
            {
                "to": body.get("to"),
                "cc": body.get("cc", []),
                "subject": body.get("subject", ""),
                "body": body.get("body", ""),
                "thread_id": body.get("thread_id"),
                "at": datetime.now(timezone.utc).isoformat(),
            }
        )
        return json_response(
            200,
            {
                "id": new_id,
                "threadId": body.get("thread_id") or f"t_{new_id}",
                "labelIds": ["SENT"],
            },
        )

    m = re.match(r"^/gmail/v1/users/me/threads/([^/]+)/modify$", path)
    if req.method == "POST" and m:
        return json_response(200, {"id": m.group(1), "labelIds": ["INBOX"]})

    m = re.match(r"^/gmail/v1/users/me/threads/([^/]+)$", path)
    if req.method == "GET" and m:
        thread_id = m.group(1)
        msgs = [m for m in store.gmail_messages.values() if m.thread_id == thread_id]
        return json_response(
            200,
            {
                "id": thread_id,
                "messages": [
                    {
                        "id": msg.id,
                        "threadId": msg.thread_id,
                        "labelIds": msg.label_ids,
                        "payload": {
                            "headers": [
                                {"name": "From", "value": msg.from_},
                                {"name": "To", "value": ", ".join(msg.to)},
                                {"name": "Cc", "value": ", ".join(msg.cc)},
                                {"name": "Subject", "value": msg.subject},
                                {"name": "Date", "value": msg.sent_at},
                            ],
                            "body": {"data": base64.b64encode(msg.body.encode()).decode()},
                        },
                    }
                    for msg in msgs
                ],
            },
        )

    return json_response(404, {"error": f"gmail: unmocked {req.method} {path}"})
