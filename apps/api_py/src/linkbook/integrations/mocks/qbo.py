"""QBO mock endpoints — mirrors apps/api/src/integrations/_mocks/qbo.ts."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from ..http import HttpRequest, HttpResponse
from .store import MockInvoice, MockPayment, get_mock_store
from .transport import consume_failure_for, json_response


async def handle(req: HttpRequest, path: str) -> HttpResponse:
    fail = consume_failure_for(f"qbo:{req.method} {path}")
    if fail is not None:
        return fail

    store = get_mock_store()

    # GET single invoice (hallucination guard)
    m = re.match(r"^/v3/company/[^/]+/invoice/([^/?]+)$", path)
    if req.method == "GET" and m:
        inv_id = m.group(1)
        inv = store.invoices.get(inv_id)
        if inv is None:
            for cand in store.invoices.values():
                if cand.doc_number == inv_id:
                    return json_response(200, {"Invoice": _to_qbo_invoice(cand)})
            return json_response(404, {"error": "invoice not found"})
        return json_response(200, {"Invoice": _to_qbo_invoice(inv)})

    # CDC
    if req.method == "GET" and "/cdc" in path:
        invoices = [_to_qbo_invoice(i) for i in store.invoices.values()]
        payments = [_to_qbo_payment(p) for p in store.payments.values()]
        return json_response(
            200,
            {
                "CDCResponse": [
                    {
                        "QueryResponse": [
                            {"Invoice": invoices},
                            {"Payment": payments},
                        ]
                    }
                ]
            },
        )

    # Apply payment
    if req.method == "POST" and path.endswith("/payment"):
        body = req.body or {}
        payment = store.payments.get(body.get("payment_id"))
        if payment is None:
            return json_response(404, {"error": "payment not found"})
        payment.applied_to_invoice_id = body.get("invoice_id")
        invoice = store.invoices.get(body.get("invoice_id"))
        if invoice is not None:
            invoice.status = "paid"
            invoice.paid_at = datetime.now(timezone.utc).isoformat()
        return json_response(200, {"Payment": _to_qbo_payment(payment)})

    # Update invoice (mark paid / void)
    if req.method == "POST" and path.endswith("/invoice"):
        body = req.body or {}
        invoice = store.invoices.get(body.get("invoice_id"))
        if invoice is None:
            return json_response(404, {"error": "invoice not found"})
        invoice.status = body.get("mark", invoice.status)
        if body.get("mark") == "paid":
            invoice.paid_at = datetime.now(timezone.utc).isoformat()
        return json_response(200, {"Invoice": _to_qbo_invoice(invoice)})

    return json_response(404, {"error": f"qbo: unmocked {req.method} {path}"})


def _to_qbo_invoice(i: MockInvoice) -> dict[str, Any]:
    return {
        "Id": i.id,
        "DocNumber": i.doc_number,
        "CustomerRef": {"value": i.customer_id, "name": i.customer_name},
        "TotalAmt": i.amount_cents / 100,
        "TxnDate": i.issued_at,
        "DueDate": i.due_at,
        "Balance": 0 if i.status == "paid" else i.amount_cents / 100,
        "status": i.status,
    }


def _to_qbo_payment(p: MockPayment) -> dict[str, Any]:
    return {
        "Id": p.id,
        "CustomerRef": {"name": p.customer_name_raw},
        "TotalAmt": p.amount_cents / 100,
        "TxnDate": p.received_at,
        "Line": (
            [{"LinkedTxn": [{"TxnId": p.applied_to_invoice_id, "TxnType": "Invoice"}]}]
            if p.applied_to_invoice_id
            else []
        ),
    }
