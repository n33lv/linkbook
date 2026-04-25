"""QBO client. Real or mock-targeted depending on the installed transport.

§4.1 — poll-based via CDC; getInvoice for the hallucination guard;
applyPayment + updateInvoice for write paths. Hard rules: never write to
journal entries, never touch closed-period transactions.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, TypedDict

from ..config import AppConfig
from ..db.models import IntegrationConnection
from .http import HttpRequest, get_transport, http_err

SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com"
PROD_BASE = "https://quickbooks.api.intuit.com"


class GetInvoiceResult(TypedDict):
    status: str  # 'sent'|'paid'|'voided'|'draft'


class QboClient:
    def __init__(self, cfg: AppConfig, conn: IntegrationConnection) -> None:
        base = PROD_BASE if cfg.QBO_ENVIRONMENT == "production" else SANDBOX_BASE
        self._base = f"{base}/v3/company/{conn.external_account_id}"
        self._auth: dict[str, str] = (
            {"authorization": f"Bearer {conn.access_token}"} if conn.access_token else {}
        )
        self._t = get_transport()

    async def cdc(self, entities: list[str], changed_since: datetime) -> Any:
        qs = (
            f"entities={','.join(entities)}&changedSince={changed_since.isoformat()}"
        )
        res = await self._t.request(
            HttpRequest(
                method="GET",
                url=f"{self._base}/cdc?{qs}",
                headers={"accept": "application/json", **self._auth},
            )
        )
        if res.status >= 400:
            raise http_err("qbo cdc", res.status, res.body)
        return res.body

    async def get_invoice(self, invoice_id: str) -> GetInvoiceResult | None:
        res = await self._t.request(
            HttpRequest(
                method="GET",
                url=f"{self._base}/invoice/{invoice_id}",
                headers={"accept": "application/json", **self._auth},
            )
        )
        if res.status == 404:
            return None
        if res.status >= 400:
            raise http_err("qbo getInvoice", res.status, res.body)
        body = res.body or {}
        inv = body.get("Invoice") if isinstance(body, dict) else None
        if not inv:
            return None
        return {"status": inv.get("status")}

    async def apply_payment(
        self, payload: dict[str, Any]
    ) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{self._base}/payment",
                headers=self._auth,
                body=payload,
            )
        )
        if res.status >= 400:
            raise http_err("qbo applyPayment", res.status, res.body)
        return res.body

    async def update_invoice(self, payload: dict[str, Any]) -> Any:
        res = await self._t.request(
            HttpRequest(
                method="POST",
                url=f"{self._base}/invoice",
                headers=self._auth,
                body=payload,
            )
        )
        if res.status >= 400:
            raise http_err("qbo updateInvoice", res.status, res.body)
        return res.body


def create_qbo_client(cfg: AppConfig, conn: IntegrationConnection) -> QboClient:
    return QboClient(cfg, conn)
