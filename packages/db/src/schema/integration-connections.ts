import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, timestamp, jsonCol } from './_helpers.js';

// §5.2 + §5.8 rule 3 — opaque connection_id, never keyed by integration name.

export const integration_connections = sqliteTable(
  'integration_connections',
  {
    id: uuidPk(),

    source: text('source').notNull(),
    external_account_id: text('external_account_id').notNull(),
    display_name: text('display_name'),

    status: text('status').notNull().default('connected'),

    // TODO(security §5.2): KMS envelope. Plaintext in dev.
    access_token: text('access_token'),
    refresh_token: text('refresh_token'),
    token_expires_at: timestamp('token_expires_at'),

    metadata: jsonCol<Record<string, unknown>>('metadata')
      .notNull()
      .default(sql`'{}'`),

    last_sync_at: timestamp('last_sync_at'),
    last_error: text('last_error'),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    source_account_idx: uniqueIndex('connections_source_account_idx').on(
      t.source,
      t.external_account_id,
    ),
  }),
);

export type IntegrationConnection = typeof integration_connections.$inferSelect;
export type NewIntegrationConnection = typeof integration_connections.$inferInsert;
