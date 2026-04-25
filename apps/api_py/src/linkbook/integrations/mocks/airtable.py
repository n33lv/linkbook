"""Airtable mock — mirrors apps/api/src/integrations/_mocks/airtable.ts."""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from random import randint

from ..http import HttpRequest, HttpResponse
from .store import get_mock_store
from .transport import consume_failure_for, json_response


async def handle(req: HttpRequest, path: str) -> HttpResponse:
    fail = consume_failure_for(f"airtable:{req.method} {path}")
    if fail is not None:
        return fail

    store = get_mock_store()
    m = re.match(r"^/v0/([^/]+)/([^/]+)(?:/([^/]+))?$", path)
    if not m:
        return json_response(404, {"error": "unmocked airtable path"})
    rec_id = m.group(3)

    if req.method == "POST" and not rec_id:
        body = req.body or {}
        records = body.get("records", [])
        created = []
        for rec in records:
            new_id = f"rec_{int(time.time() * 1000)}_{randint(0, 999)}"
            store.airtable_records[new_id] = rec.get("fields", {})
            created.append(
                {"id": new_id, "fields": rec.get("fields", {}), "createdTime": datetime.now(timezone.utc).isoformat()}
            )
        return json_response(200, {"records": created})

    if req.method == "PATCH" and rec_id:
        body = req.body or {}
        existing = store.airtable_records.get(rec_id, {})
        store.airtable_records[rec_id] = {**existing, **body.get("fields", {})}
        return json_response(200, {"id": rec_id, "fields": store.airtable_records[rec_id]})

    if req.method == "GET" and not rec_id:
        return json_response(
            200,
            {
                "records": [
                    {"id": rid, "fields": fields, "createdTime": datetime.now(timezone.utc).isoformat()}
                    for rid, fields in store.airtable_records.items()
                ]
            },
        )

    return json_response(404, {"error": f"airtable: unmocked {req.method} {path}"})
