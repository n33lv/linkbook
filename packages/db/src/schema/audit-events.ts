import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { uuidPk, timestamp, jsonCol } from './_helpers.js';
import { actions } from './actions.js';
import { events } from './events.js';

// §2.6 — append-only. 13mo retention.

export const audit_events = sqliteTable(
  'audit_events',
  {
    id: uuidPk(),

    actor: text('actor').notNull(), // 'user' | 'agent:<name>@v<version>' | 'system'

    action_id: text('action_id').references(() => actions.id),
    originating_event_id: text('originating_event_id').references(() => events.id),

    kind: text('kind').notNull(),

    idempotency_key: text('idempotency_key'),
    subject_ref: text('subject_ref').notNull(),

    request: jsonCol<Record<string, unknown>>('request'),
    response: jsonCol<Record<string, unknown>>('response'),
    http_status: text('http_status'),

    transition: jsonCol<Record<string, unknown>>('transition'),

    note: text('note'),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    by_subject: index('audit_by_subject').on(t.subject_ref, t.created_at),
    by_action: index('audit_by_action').on(t.action_id, t.created_at),
    by_kind: index('audit_by_kind').on(t.kind, t.created_at),
  }),
);

export type AuditEventRow = typeof audit_events.$inferSelect;
export type NewAuditEventRow = typeof audit_events.$inferInsert;
