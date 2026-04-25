import { sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { uuidPk, timestamp, jsonCol } from './_helpers.js';

// §4.5 — gmail persistence boundary.

export const gmail_threads = sqliteTable(
  'gmail_threads',
  {
    id: uuidPk(),
    gmail_thread_id: text('gmail_thread_id').notNull(),
    scope: text('scope').notNull().default('in_scope'),
    client_ids: jsonCol<string[]>('client_ids')
      .notNull()
      .default(sql`'[]'`),
    last_message_at: timestamp('last_message_at'),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    gmail_thread_idx: uniqueIndex('gmail_threads_thread_idx').on(t.gmail_thread_id),
    last_msg_idx: index('gmail_threads_last_msg_idx').on(t.last_message_at),
  }),
);

export const gmail_message_headers = sqliteTable(
  'gmail_message_headers',
  {
    id: uuidPk(),
    gmail_thread_id: text('gmail_thread_id').notNull(),
    gmail_message_id: text('gmail_message_id').notNull(),

    from: text('from'),
    to: jsonCol<string[]>('to').notNull().default(sql`'[]'`),
    cc: jsonCol<string[]>('cc').notNull().default(sql`'[]'`),
    subject: text('subject'),
    sent_at: timestamp('sent_at'),
    label_ids: jsonCol<string[]>('label_ids').notNull().default(sql`'[]'`),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    msg_idx: uniqueIndex('gmail_msg_idx').on(t.gmail_message_id),
    thread_idx: index('gmail_msg_thread_idx').on(t.gmail_thread_id, t.sent_at),
  }),
);

export const gmail_body_cache = sqliteTable(
  'gmail_body_cache',
  {
    id: uuidPk(),
    gmail_message_id: text('gmail_message_id').notNull(),

    body_encrypted: text('body_encrypted').notNull(),
    fetched_at: timestamp('fetched_at').notNull().$defaultFn(() => new Date()),
    evict_at: timestamp('evict_at').notNull(),
  },
  (t) => ({
    msg_idx: uniqueIndex('gmail_body_msg_idx').on(t.gmail_message_id),
    evict_idx: index('gmail_body_evict_idx').on(t.evict_at),
  }),
);

export type GmailThread = typeof gmail_threads.$inferSelect;
export type GmailMessageHeader = typeof gmail_message_headers.$inferSelect;
export type GmailBodyCacheRow = typeof gmail_body_cache.$inferSelect;
