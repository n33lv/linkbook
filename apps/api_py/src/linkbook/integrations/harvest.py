"""Harvest client."""

from __future__ import annotations

from typing import Any

from ..config import AppConfig
from ..db.models import IntegrationConnection
from .http import HttpRequest, get_transport, http_err

BASE = "https://api.harvestapp.com/v2"


class HarvestClient:
    def __init__(self, _cfg: AppConfig, conn: IntegrationConnection) -> None:
        # Harvest requires User-Agent on every request — they reject calls
        # without one with a 400. Their API contact email is informational
        # but recommended.
        self._headers = {
            **({"authorization": f"Bearer {conn.access_token}"} if conn.access_token else {}),
            "harvest-account-id": conn.external_account_id,
            "user-agent": "Linkbook (linkbook@flightdesign.co)",
            "accept": "application/json",
        }
        self._t = get_transport()

    async def list_projects(self) -> Any:
        """Read-only — returns active projects. Used as a smoke test."""
        res = await self._t.request(
            HttpRequest(method="GET", url=f"{BASE}/projects?is_active=true", headers=self._headers)
        )
        if res.status >= 400:
            raise http_err("harvest listProjects", res.status, res.body)
        return res.body

    async def list_clients(self) -> Any:
        """Read-only — returns active clients."""
        res = await self._t.request(
            HttpRequest(method="GET", url=f"{BASE}/clients?is_active=true", headers=self._headers)
        )
        if res.status >= 400:
            raise http_err("harvest listClients", res.status, res.body)
        return res.body

    async def create_client(self, name: str) -> dict[str, Any]:
        """Create a Harvest client. Used by find_or_create_client when the
        Linkbook client doesn't yet exist on the Harvest side."""
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/clients",
                headers=self._headers,
                body={"name": name, "is_active": True},
            )
        )
        if res.status >= 400:
            raise http_err("harvest createClient", res.status, res.body)
        return res.body  # type: ignore[no-any-return]

    async def find_or_create_client(self, name: str) -> str:
        """Look up an active Harvest client by name; create if missing.
        Returns the Harvest client_id as a string for use in subsequent
        project create calls."""
        listing = await self.list_clients()
        clients = listing.get("clients", []) if isinstance(listing, dict) else []
        for c in clients:
            if c.get("name", "").strip().lower() == name.strip().lower():
                return str(c["id"])
        created = await self.create_client(name)
        return str(created["id"])

    async def me(self) -> Any:
        """Read-only — returns the authenticated user. Cheapest health check."""
        res = await self._t.request(
            HttpRequest(method="GET", url=f"{BASE}/users/me", headers=self._headers)
        )
        if res.status >= 400:
            raise http_err("harvest me", res.status, res.body)
        return res.body

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
