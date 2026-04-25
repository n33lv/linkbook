import { sqliteTable, text, integer, check, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { EventType, EventState } from '@linkbook/types';
import { uuidPk, timestamp, jsonCol } from './_helpers.js';

// §1.1 — normalized event envelope.
// Single row with payload as JSON; per-type discrimination at the type
// boundary, not the storage boundary.

export const events = sqliteTable(
  'events',
  {
    id: uuidPk(),

    source: text('source').notNull(),
    type: text('type').$type<EventType>().notNull(),
    subject_ref: text('subject_ref').notNull(),
    occurred_at: timestamp('occurred_at').notNull(),
    ingested_at: timestamp('ingested_at').notNull().$defaultFn(() => new Date()),

    priority_score: integer('priority_score').notNull(),
    state: text('state').$type<EventState>().notNull().default('unread'),

    suggested_actions: jsonCol<string[]>('suggested_actions')
      .notNull()
      .default(sql`'[]'`),
    payload: jsonCol<Record<string, unknown>>('payload').notNull(),

    thread_id: text('thread_id'),
    snoozed_until: timestamp('snoozed_until'),

    dedupe_key: text('dedupe_key').notNull(),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    state_check: check(
      'events_state_check',
      sql`${t.state} IN ('unread', 'read', 'done', 'snoozed', 'dismissed', 'waiting')`,
    ),
    score_check: check(
      'events_score_check',
      sql`${t.priority_score} BETWEEN 0 AND 100`,
    ),

    dedupe_idx: uniqueIndex('events_dedupe_idx').on(t.type, t.subject_ref, t.dedupe_key),
    inbox_idx: index('events_inbox_idx').on(t.state, t.priority_score, t.occurred_at),
    subject_idx: index('events_subject_idx').on(t.subject_ref, t.occurred_at),
  }),
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
