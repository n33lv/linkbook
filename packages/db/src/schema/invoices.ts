import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { uuidPk, timestamp } from './_helpers.js';
import { clients } from './clients.js';

// §5.1 — projections of QBO and/or Harvest. Linkbook never creates invoices.
// §4.1 — natural key would be qbo_invoice_id, but Harvest drafts may exist
// before QBO propagation; both nullable, watchdog reconciles.

export const invoices = sqliteTable(
  'invoices',
  {
    id: uuidPk(),

    client_id: text('client_id')
      .notNull()
      .references(() => clients.id),

    qbo_invoice_id: text('qbo_invoice_id'),
    harvest_invoice_id: text('harvest_invoice_id'),

    number: text('number').notNull(),
    amount_cents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),

    issued_at: timestamp('issued_at'),
    due_at: timestamp('due_at'),
    paid_at: timestamp('paid_at'),

    // 'draft' | 'sent' | 'overdue' | 'paid' | 'voided'
    status: text('status').notNull().default('draft'),

    last_synced_at: timestamp('last_synced_at').notNull().$defaultFn(() => new Date()),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    qbo_idx: uniqueIndex('invoices_qbo_idx').on(t.qbo_invoice_id),
    harvest_idx: uniqueIndex('invoices_harvest_idx').on(t.harvest_invoice_id),
    client_due_idx: index('invoices_client_due_idx').on(t.client_id, t.due_at),
    status_idx: index('invoices_status_idx').on(t.status),
  }),
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
