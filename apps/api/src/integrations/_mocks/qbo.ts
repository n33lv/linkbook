import type { HttpRequest, HttpResponse } from '../_http/client.js';
import { jsonResponse, consumeFailureFor } from './transport.js';
import { getMockStore } from './store.js';

// Mock QBO endpoints we use:
//   GET  /v3/company/{realm}/cdc?entities=Invoice,Payment&changedSince=...
//   POST /v3/company/{realm}/payment        — apply a payment
//   POST /v3/company/{realm}/invoice        — update (mark paid manual / void)
// Real QBO also does OAuth — we skip the OAuth dance entirely; mock just
// honors a Bearer token presence and returns success.

export async function handleQbo(req: HttpRequest, path: string): Promise<HttpResponse> {
  const fail = consumeFailureFor(`qbo:${req.method} ${path}`);
  if (fail) return fail;

  const store = getMockStore();

  // GET single invoice (used by hallucination guard)
  const invoiceMatch = path.match(/\/v3\/company\/[^/]+\/invoice\/([^/?]+)$/);
  if (req.method === 'GET' && invoiceMatch) {
    const id = invoiceMatch[1] ?? '';
    const inv = store.invoices.get(id);
    if (!inv) {
      // try by doc_number too
      for (const i of store.invoices.values()) if (i.doc_number === id) return jsonResponse(200, { Invoice: toQboInvoice(i) });
      return jsonResponse(404, { error: 'invoice not found' });
    }
    return jsonResponse(200, { Invoice: toQboInvoice(inv) });
  }

  // CDC
  if (req.method === 'GET' && path.includes('/cdc')) {
    const invoices = Array.from(store.invoices.values()).filter(
      (i) => i.source === 'qbo' || i.source === 'harvest', // both visible to QBO post-sync
    );
    const payments = Array.from(store.payments.values());
    return jsonResponse(200, {
      CDCResponse: [
        {
          QueryResponse: [
            { Invoice: invoices.map(toQboInvoice) },
            { Payment: payments.map(toQboPayment) },
          ],
        },
      ],
    });
  }

  // Apply payment
  if (req.method === 'POST' && path.endsWith('/payment')) {
    const body = req.body as { payment_id: string; invoice_id: string; amount_cents: number };
    const payment = store.payments.get(body.payment_id);
    if (!payment) return jsonResponse(404, { error: 'payment not found' });
    payment.applied_to_invoice_id = body.invoice_id;
    const invoice = store.invoices.get(body.invoice_id);
    if (invoice) {
      invoice.status = 'paid';
      invoice.paid_at = new Date().toISOString();
    }
    return jsonResponse(200, { Payment: toQboPayment(payment) });
  }

  // Update invoice (mark paid manual / void)
  if (req.method === 'POST' && path.endsWith('/invoice')) {
    const body = req.body as { invoice_id: string; mark: 'paid' | 'voided' };
    const invoice = store.invoices.get(body.invoice_id);
    if (!invoice) return jsonResponse(404, { error: 'invoice not found' });
    invoice.status = body.mark;
    if (body.mark === 'paid') invoice.paid_at = new Date().toISOString();
    return jsonResponse(200, { Invoice: toQboInvoice(invoice) });
  }

  return jsonResponse(404, { error: `qbo: unmocked ${req.method} ${path}` });
}

function toQboInvoice(i: ReturnType<typeof Array.prototype.values> extends never ? never : import('./store.js').MockInvoice): unknown {
  return {
    Id: i.id,
    DocNumber: i.doc_number,
    CustomerRef: { value: i.customer_id, name: i.customer_name },
    TotalAmt: i.amount_cents / 100,
    TxnDate: i.issued_at,
    DueDate: i.due_at,
    Balance: i.status === 'paid' ? 0 : i.amount_cents / 100,
    status: i.status,
  };
}

function toQboPayment(p: import('./store.js').MockPayment): unknown {
  return {
    Id: p.id,
    CustomerRef: { name: p.customer_name_raw },
    TotalAmt: p.amount_cents / 100,
    TxnDate: p.received_at,
    Line: p.applied_to_invoice_id
      ? [{ LinkedTxn: [{ TxnId: p.applied_to_invoice_id, TxnType: 'Invoice' }] }]
      : [],
  };
}
