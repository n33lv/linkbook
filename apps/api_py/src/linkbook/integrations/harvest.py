"""Harvest client."""

from __future__ import annotations

from typing import Any

from ..config import AppConfig
from ..db.models import IntegrationConnection
from .http import HttpRequest, get_transport, http_err

BASE = "https://api.harvestapp.com/v2"


class HarvestClient:
    def __init__(self, _cfg: AppConfig, conn: IntegrationConnection) -> None:
        self._headers = {
            **({"authorization": f"Bearer {conn.access_token}"} if conn.access_token else {}),
            "harvest-account-id": conn.external_account_id,
        }
        self._t = get_transport()

    async def send_invoice(self, invoice_id: str) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/invoices/{invoice_id}/messages",
                headers=self._headers,
                body={"event_type": "send"},
            )
        )
        if res.status >= 400:
            raise http_err("harvest sendInvoice", res.status, res.body)
        return res.body

    async def create_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        res = await self._t.request(
            HttpRequest(method="POST", url=f"{BASE}/projects", headers=self._headers, body=payload)
        )
        if res.status >= 400:
            raise http_err("harvest createProject", res.status, res.body)
        return res.body  # type: ignore[no-any-return]

    async def archive_project(self, project_id: str) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="PATCH",
                url=f"{BASE}/projects/{project_id}",
                headers=self._headers,
                body={"is_active": False},
            )
        )
        if res.status >= 400:
            raise http_err("harvest archiveProject", res.status, res.body)
        return res.body

    async def log_time_entry(self, payload: dict[str, Any]) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/time_entries",
                headers=self._headers,
                body=payload,
            )
        )
        if res.status >= 400:
            raise http_err("harvest logTimeEntry", res.status, res.body)
        return res.body

    async def list_time_entries(self) -> Any:
        res = await self._t.request(
            HttpRequest(method="GET", url=f"{BASE}/time_entries", headers=self._headers)
        )
        if res.status >= 400:
            raise http_err("harvest listTimeEntries", res.status, res.body)
        return res.body


def create_harvest_client(cfg: AppConfig, conn: IntegrationConnection) -> HarvestClient:
    return HarvestClient(cfg, conn)
