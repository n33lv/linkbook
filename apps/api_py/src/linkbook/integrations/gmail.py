"""Gmail client."""

from __future__ import annotations

from typing import Any, TypedDict

from ..config import AppConfig
from ..db.models import IntegrationConnection
from .http import HttpRequest, get_transport, http_err

BASE = "https://gmail.googleapis.com/gmail/v1"


class GmailSendResp(TypedDict):
    id: str
    threadId: str


class GmailClient:
    def __init__(self, _cfg: AppConfig, conn: IntegrationConnection) -> None:
        self._headers = (
            {"authorization": f"Bearer {conn.access_token}"} if conn.access_token else {}
        )
        self._t = get_transport()

    async def send(self, payload: dict[str, Any]) -> GmailSendResp:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/users/me/messages/send",
                headers=self._headers,
                body=payload,
            )
        )
        if res.status >= 400:
            raise http_err("gmail send", res.status, res.body)
        return res.body  # type: ignore[no-any-return]

    async def apply_labels(self, thread_id: str, add_label_ids: list[str]) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{BASE}/users/me/threads/{thread_id}/modify",
                headers=self._headers,
                body={"addLabelIds": add_label_ids, "removeLabelIds": []},
            )
        )
        if res.status >= 400:
            raise http_err("gmail applyLabels", res.status, res.body)
        return res.body

    async def fetch_thread(self, thread_id: str) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="GET",
                url=f"{BASE}/users/me/threads/{thread_id}",
                headers=self._headers,
            )
        )
        if res.status >= 400:
            raise http_err("gmail fetchThread", res.status, res.body)
        return res.body


def create_gmail_client(cfg: AppConfig, conn: IntegrationConnection) -> GmailClient:
    return GmailClient(cfg, conn)
