import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import type { AppCtx } from '../lib/principal-context.js';

export async function findInvoiceByQbo(
  ctx: AppCtx,
  qbo_invoice_id: string,
): Promise<typeof schema.invoices.$inferSelect | undefined> {
  const rows = ctx.db.select().from(schema.invoices).where(eq(schema.invoices.qbo_invoice_id, qbo_invoice_id)).all();
  return rows[0];
}

export async function findInvoiceByHarvest(
  ctx: AppCtx,
  harvest_invoice_id: string,
): Promise<typeof schema.invoices.$inferSelect | undefined> {
  const rows = ctx.db.select().from(schema.invoices).where(eq(schema.invoices.harvest_invoice_id, harvest_invoice_id)).all();
  return rows[0];
}

export async function upsertInvoice(
  ctx: AppCtx,
  values: typeof schema.invoices.$inferInsert,
): Promise<typeof schema.invoices.$inferSelect> {
  // Match on qbo id first, then harvest id, else insert.
  if (values.qbo_invoice_id) {
    const existing = await findInvoiceByQbo(ctx, values.qbo_invoice_id);
    if (existing) {
      ctx.db
        .update(schema.invoices)
        .set({ ...values, updated_at: new Date(), last_synced_at: new Date() })
        .where(eq(schema.invoices.id, existing.id))
        .run();
      return { ...existing, ...values };
    }
  }
  if (values.harvest_invoice_id) {
    const existing = await findInvoiceByHarvest(ctx, values.harvest_invoice_id);
    if (existing) {
      ctx.db
        .update(schema.invoices)
        .set({ ...values, updated_at: new Date(), last_synced_at: new Date() })
        .where(eq(schema.invoices.id, existing.id))
        .run();
      return { ...existing, ...values };
    }
  }
  return ctx.db.insert(schema.invoices).values(values).returning().get();
}

export async function findOpenInvoicesForClient(
  ctx: AppCtx,
  client_id: string,
): Promise<Array<typeof schema.invoices.$inferSelect>> {
  return ctx.db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.client_id, client_id), sql`${schema.invoices.status} != 'paid'`))
    .all();
}
