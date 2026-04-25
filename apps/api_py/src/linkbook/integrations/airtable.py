"""Airtable client."""

from __future__ import annotations

from typing import Any

from ..config import AppConfig
from ..db.models import IntegrationConnection
from .http import HttpRequest, get_transport, http_err

BASE = "https://api.airtable.com/v0"


class AirtableClient:
    def __init__(self, _cfg: AppConfig, conn: IntegrationConnection) -> None:
        self._headers = (
            {"authorization": f"Bearer {conn.access_token}"} if conn.access_token else {}
        )
        self._t = get_transport()

    async def create_records(
        self, base_id: str, table_id: str, records: list[dict[str, Any]]
    ) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/{base_id}/{table_id}",
                headers=self._headers,
                body={"records": records},
            )
        )
        if res.status >= 400:
            raise http_err("airtable createRecords", res.status, res.body)
        return res.body

    async def update_record(
        self,
        base_id: str,
        table_id: str,
        record_id: str,
        fields: dict[str, Any],
    ) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="PATCH",
                url=f"{BASE}/{base_id}/{table_id}/{record_id}",
                headers=self._headers,
                body={"fields": fields},
            )
        )
        if res.status >= 400:
            raise http_err("airtable updateRecord", res.status, res.body)
        return res.body

    async def list_records(self, base_id: str, table_id: str) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="GET",
                url=f"{BASE}/{base_id}/{table_id}",
                headers=self._headers,
            )
        )
        if res.status >= 400:
            raise http_err("airtable listRecords", res.status, res.body)
        return res.body


def create_airtable_client(cfg: AppConfig, conn: IntegrationConnection) -> AirtableClient:
    return AirtableClient(cfg, conn)
