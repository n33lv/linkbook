import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidPk, timestamp, jsonCol } from './_helpers.js';

// §4.4 — Airtable mapping wizard output, plus generic per-source mappings.

export const mappings = sqliteTable(
  'mappings',
  {
    id: uuidPk(),

    source: text('source').notNull(),
    scope: text('scope').notNull(),
    external_account_id: text('external_account_id').notNull(),

    config: jsonCol<Record<string, unknown>>('config').notNull(),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    scoped: uniqueIndex('mappings_scoped_idx').on(t.source, t.scope, t.external_account_id),
  }),
);

export type Mapping = typeof mappings.$inferSelect;
export type NewMapping = typeof mappings.$inferInsert;
