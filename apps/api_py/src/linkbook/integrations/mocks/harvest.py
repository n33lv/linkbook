"""Harvest mock — mirrors apps/api/src/integrations/_mocks/harvest.ts."""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone

from ..http import HttpRequest, HttpResponse
from .store import MockTimeEntry, get_mock_store
from .transport import consume_failure_for, json_response


async def handle(req: HttpRequest, path: str) -> HttpResponse:
    fail = consume_failure_for(f"harvest:{req.method} {path}")
    if fail is not None:
        return fail
    store = get_mock_store()

    # Send invoice
    m = re.match(r"^/v2/invoices/([^/]+)/messages$", path)
    if req.method == "POST" and m:
        inv = store.invoices.get(m.group(1))
        if inv is None:
            return json_response(404, {"error": "invoice not found"})
        inv.status = "sent"
        return json_response(
            201, {"id": m.group(1), "status": "sent", "sent_at": datetime.now(timezone.utc).isoformat()}
        )

    # List clients (used by find_or_create_client to look up an existing
    # Harvest client by name before creating a project).
    if req.method == "GET" and path == "/v2/clients":
        return json_response(
            200,
            {
                "clients": [
                    {"id": c["id"], "name": c["name"], "is_active": True}
                    for c in store.harvest_clients.values()
                ]
            },
        )

    # Create client (called when find_or_create_client doesn't find one
    # by name above).
    if req.method == "POST" and path == "/v2/clients":
        body = req.body or {}
        new_id = int(time.time() * 1000)
        store.harvest_clients[str(new_id)] = {"id": new_id, "name": body.get("name", "")}
        return json_response(201, {"id": new_id, "name": body.get("name", "")})

    # Create project
    if req.method == "POST" and path == "/v2/projects":
        body = req.body or {}
        new_id = f"harvest_proj_{int(time.time() * 1000)}"
        store.harvest_projects[new_id] = {
            "id": new_id,
            "name": body.get("name"),
            "client_id": body.get("client_id"),
            "budget_hours": body.get("budget_hours"),
        }
        return json_response(201, {"id": new_id, **body})

    # Archive
    m = re.match(r"^/v2/projects/([^/]+)$", path)
    if req.method == "PATCH" and m:
        if m.group(1) not in store.harvest_projects:
            return json_response(404, {"error": "project not found"})
        return json_response(200, {"id": m.group(1), "archived": True})

    # Log time
    if req.method == "POST" and path == "/v2/time_entries":
        body = req.body or {}
        new_id = f"harvest_te_{int(time.time() * 1000)}"
        store.time_entries[new_id] = MockTimeEntry(
            id=new_id,
            user_id=body.get("user_id", ""),
            project_id=body.get("project_id", ""),
            date=body.get("date", ""),
            hours=body.get("hours", 0),
            notes=body.get("notes"),
        )
        return json_response(201, {"id": new_id, **body})

    # List time
    if req.method == "GET" and path == "/v2/time_entries":
        return json_response(
            200,
            {
                "time_entries": [
                    {
                        "id": e.id,
                        "user_id": e.user_id,
                        "project_id": e.project_id,
                        "date": e.date,
                        "hours": e.hours,
                        "notes": e.notes,
                    }
                    for e in store.time_entries.values()
                ]
            },
        )

    return json_response(404, {"error": f"harvest: unmocked {req.method} {path}"})
