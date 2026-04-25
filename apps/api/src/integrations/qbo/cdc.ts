// §4.1 — Change Data Capture poll. Builds derived events from invoice
// state shifts (overdue / aging / paid / unapplied payment).

import type { AppCtx } from '../../lib/principal-context.js';
import { getConnectionForSource } from '../../db/connections-repo.js';
import { upsertClientBySource } from '../../db/clients-repo.js';
import { upsertInvoice, findInvoiceByQbo } from '../../db/invoices-repo.js';
import { ingestEvent } from '../../ingestion.js';
import { autoResolveEventsForSubject } from '../../db/events-repo.js';
import { createQboClient } from './client.js';

export type CdcResult = {
  invoices_seen: number;
  events_emitted: number;
  last_synced_at: Date;
};

export async function runQboCdcPass(ctx: AppCtx, since?: Date): Promise<CdcResult> {
  const conn = await getConnectionForSource(ctx, 'qbo');
  if (!conn) throw new Error('qbo not connected');
  const client = createQboClient(ctx.cfg, conn);
  const lastSync = since ?? conn.last_sync_at ?? new Date(Date.now() - 7 * 86_400_000);
  const cdc = (await client.cdc(['Invoice', 'Payment'], lastSync)) as {
    CDCResponse: Array<{ QueryResponse: Array<Record<string, unknown>> }>;
  };

  let invoicesSeen = 0;
  let eventsEmitted = 0;

  // Walk the CDC response; QBO embeds Invoice + Payment arrays.
  const invoices: Array<Record<string, unknown>> = [];
  const payments: Array<Record<string, unknown>> = [];
  for (const seg of cdc.CDCResponse ?? []) {
    for (const qr of seg.QueryResponse ?? []) {
      const invs = (qr['Invoice'] as Array<Record<string, unknown>>) ?? [];
      const pays = (qr['Payment'] as Array<Record<string, unknown>>) ?? [];
      invoices.push(...invs);
      payments.push(...pays);
    }
  }

  for (const i of invoices) {
    invoicesSeen++;
    eventsEmitted += await processInvoice(ctx, i);
  }
  for (const p of payments) {
    eventsEmitted += await processPayment(ctx, p);
  }

  const now = new Date();
  return { invoices_seen: invoicesSeen, events_emitted: eventsEmitted, last_synced_at: now };
}

async function processInvoice(ctx: AppCtx, qboInv: Record<string, unknown>): Promise<number> {
  const id = String(qboInv['Id']);
  const docNumber = String(qboInv['DocNumber'] ?? id);
  const customer = qboInv['CustomerRef'] as { value: string; name: string };
  const amount_cents = Math.round(Number(qboInv['TotalAmt'] ?? 0) * 100);
  const issued_at = qboInv['TxnDate'] ? new Date(qboInv['TxnDate'] as string) : null;
  const due_at = qboInv['DueDate'] ? new Date(qboInv['DueDate'] as string) : null;
  const status = String(qboInv['status'] ?? 'sent') as 'draft' | 'sent' | 'paid' | 'voided';

  const c = await upsertClientBySource(ctx, 'qbo', customer.value, customer.name);
  const before = await findInvoiceByQbo(ctx, id);

  await upsertInvoice(ctx, {
    qbo_invoice_id: id,
    client_id: c.id,
    number: docNumber,
    amount_cents,
    issued_at: issued_at ?? null,
    due_at: due_at ?? null,
    paid_at: qboInv['Balance'] === 0 ? new Date() : null,
    status: status === 'paid' ? 'paid' : status === 'voided' ? 'voided' : 'sent',
  });

  let emitted = 0;

  // §1.2 invoice.paid auto-resolves outstanding events for this subject_ref.
  if (status === 'paid' && before?.status !== 'paid') {
    await autoResolveEventsForSubject(ctx, `invoice:${id}`, 'invoice paid in QBO');
    await ingestEvent(ctx, {
      source: 'qbo',
      type: 'invoice.paid',
      subject_ref: `invoice:${id}`,
      occurred_at: new Date(),
      payload: {
        invoice_id: id,
        client_id: c.id,
        amount_cents,
        currency: 'USD',
        paid_at: new Date(),
      },
      dedupe_key: 'paid',
    });
    emitted++;
    return emitted;
  }

  // Aging derivation. We emit on bucket transitions; idempotent on
  // (type, subject_ref, dedupe_key). dedupe_key = bucket name.
  if (due_at && status === 'sent') {
    const days = Math.floor((Date.now() - due_at.getTime()) / 86_400_000);
    if (days >= 1) {
      const bucket =
        days >= 90 ? 'aging_90' : days >= 60 ? 'aging_60' : days >= 30 ? 'aging_30' : 'overdue';
      const type =
        bucket === 'aging_90'
          ? 'invoice.aging_90'
          : bucket === 'aging_60'
            ? 'invoice.aging_60'
            : bucket === 'aging_30'
              ? 'invoice.aging_30'
              : 'invoice.overdue';
      await ingestEvent(ctx, {
        source: 'qbo',
        type,
        subject_ref: `invoice:${id}`,
        occurred_at: new Date(),
        payload: {
          invoice_id: id,
          client_id: c.id,
          amount_cents,
          currency: 'USD',
          issued_at: issued_at ?? new Date(),
          due_at: due_at,
          days_overdue: days,
        },
        dedupe_key: bucket,
      });
      emitted++;
    }
  }

  return emitted;
}

async function processPayment(ctx: AppCtx, qboPay: Record<string, unknown>): Promise<number> {
  const id = String(qboPay['Id']);
  const customer = qboPay['CustomerRef'] as { name: string } | undefined;
  const linked =
    ((qboPay['Line'] as Array<{ LinkedTxn?: Array<{ TxnId: string; TxnType: string }> }>) ?? [])
      .flatMap((l) => l.LinkedTxn ?? [])
      .filter((lt) => lt.TxnType === 'Invoice');

  if (linked.length > 0) return 0; // already applied; no event

  // Try to find candidate invoices for this customer name.
  const candidates: string[] = [];
  if (customer?.name) {
    // best-effort: find the QBO customer in our clients table by source_id
    // and pull their open invoices. If the customer isn't matched yet,
    // this will simply have no candidates and surface as a manual case.
    const { schema } = await import('@linkbook/db');
    const { sql } = await import('drizzle-orm');
    const matched = ctx.db
      .select()
      .from(schema.clients)
      .where(sql`json_extract(${schema.clients.source_ids}, '$.qbo') IS NOT NULL`)
      .all()
      .find((c) => c.name === customer.name);
    if (matched) {
      const open = ctx.db
        .select()
        .from(schema.invoices)
        .where(sql`${schema.invoices.client_id} = ${matched.id} AND ${schema.invoices.status} != 'paid'`)
        .all();
      for (const inv of open) if (inv.qbo_invoice_id) candidates.push(inv.qbo_invoice_id);
    }
  }

  await ingestEvent(ctx, {
    source: 'qbo',
    type: 'payment.received_unapplied',
    subject_ref: `payment:${id}`,
    occurred_at: new Date(),
    payload: {
      qbo_payment_id: id,
      customer_name_raw: customer?.name ?? '',
      amount_cents: Math.round(Number(qboPay['TotalAmt'] ?? 0) * 100),
      received_at: new Date(),
      candidate_invoice_ids: candidates,
    },
    dedupe_key: 'unapplied',
  });
  return 1;
}
