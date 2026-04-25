"""Dropbox Sign client."""

from __future__ import annotations

from typing import Any

from ..config import AppConfig
from ..db.models import IntegrationConnection
from .http import HttpRequest, get_transport, http_err

BASE = "https://api.dropboxsign.com/v3"


class DropboxsignClient:
    def __init__(self, _cfg: AppConfig, conn: IntegrationConnection) -> None:
        self._headers = (
            {"authorization": f"Bearer {conn.access_token}"} if conn.access_token else {}
        )
        self._t = get_transport()

    async def send_reminder(self, signature_request_id: str) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/signature_request/remind/{signature_request_id}",
                headers=self._headers,
            )
        )
        if res.status >= 400:
            raise http_err("dropboxsign sendReminder", res.status, res.body)
        return res.body

    async def send_from_template(self, payload: dict[str, Any]) -> dict[str, Any]:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/signature_request/send_with_template",
                headers=self._headers,
                body=payload,
            )
        )
        if res.status >= 400:
            raise http_err("dropboxsign send_with_template", res.status, res.body)
        return res.body  # type: ignore[no-any-return]

    async def cancel(self, signature_request_id: str) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/signature_request/cancel/{signature_request_id}",
                headers=self._headers,
            )
        )
        if res.status >= 400:
            raise http_err("dropboxsign cancel", res.status, res.body)
        return res.body


def create_dropboxsign_client(cfg: AppConfig, conn: IntegrationConnection) -> DropboxsignClient:
    return DropboxsignClient(cfg, conn)
