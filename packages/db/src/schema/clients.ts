import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, timestamp, jsonCol } from './_helpers.js';

// §5.1 — Linkbook-side merge of QBO Customer + Harvest Client + Airtable
// Client + email domains. Identity reconciliation in onboarding.

export const clients = sqliteTable(
  'clients',
  {
    id: uuidPk(),

    name: text('name').notNull(),
    // {qbo: "<customer_id>", harvest: "<client_id>", airtable: "<record_id>"}
    source_ids: jsonCol<Record<string, string>>('source_ids')
      .notNull()
      .default(sql`'{}'`),
    email_domains: jsonCol<string[]>('email_domains')
      .notNull()
      .default(sql`'[]'`),

    tier: integer('tier'), // 1..3 or null
    cost_rate_cents: integer('cost_rate_cents'),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    name_idx: uniqueIndex('clients_name_idx').on(t.name),
  }),
);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
