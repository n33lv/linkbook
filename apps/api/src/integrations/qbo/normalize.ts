// §4.1 — schema normalization. QBO Customer → Linkbook Client,
// Invoice → Invoice, Payment → Payment.
//
// Sandbox companies, multi-currency, and class tracking are flagged as
// unsupported in onboarding (§4.1) — the user is warned. Bookkeeper-locked
// fields (account mappings) are read-only.
//
// Currency comes in as an ISO code on QBO transactions. Multi-currency
// realms are flagged but we still record the original currency for
// audit clarity.

// TODO(integration:qbo:normalize):
//   * normalizeCustomer(qboCustomer): ClientUpsert
//   * normalizeInvoice(qboInvoice): InvoiceUpsert
//   * normalizePayment(qboPayment): PaymentUpsert + candidate_invoice_ids
//   These return upsert payloads keyed by (source='qbo', source_id=...).
export {};
