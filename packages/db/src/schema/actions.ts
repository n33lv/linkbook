import { sqliteTable, text, integer, check, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type {
  ActionType,
  ActionMode,
  ActionStatus,
  ReversalClass,
} from '@linkbook/types';
import { uuidPk, timestamp, jsonCol } from './_helpers.js';
import { events } from './events.js';

// §2.1 — actions row.

export const actions = sqliteTable(
  'actions',
  {
    id: uuidPk(),

    type: text('type').$type<ActionType>().notNull(),
    params: jsonCol<Record<string, unknown>>('params').notNull(),

    mode: text('mode').$type<ActionMode>().notNull(),
    drafted_by: text('drafted_by').notNull(),

    status: text('status').$type<ActionStatus>().notNull().default('drafted'),
    reversal_class: text('reversal_class').$type<ReversalClass>().notNull(),

    idempotency_key: text('idempotency_key').notNull(),

    // §5.3: agent confidence persisted for audit; null when drafted_by='user'.
    // Stored as text to dodge floating-point drift.
    agent_confidence: text('agent_confidence'),
    agent_rationale: text('agent_rationale'),

    preview: text('preview').notNull().default(''),

    originating_event_id: text('originating_event_id').references(() => events.id),
    subject_ref: text('subject_ref').notNull(),

    executed_at: timestamp('executed_at'),
    undo_token: text('undo_token'),
    queued_until: timestamp('queued_until'),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    idem_idx: index('actions_idem_idx').on(t.idempotency_key, t.created_at),

    status_check: check(
      'actions_status_check',
      sql`${t.status} IN ('drafted', 'approved', 'queued_30s', 'executing', 'succeeded', 'failed', 'cancelled', 'undone')`,
    ),
    mode_check: check(
      'actions_mode_check',
      sql`${t.mode} IN ('manual', 'proposed')`,
    ),
    reversal_check: check(
      'actions_reversal_check',
      sql`${t.reversal_class} IN ('true_undo', 'compensating', 'no_undo')`,
    ),

    queue_idx: index('actions_queue_idx').on(t.status, t.queued_until),
    subject_idx: index('actions_subject_idx').on(t.subject_ref, t.created_at),
  }),
);

export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;

// Composite-action legs (§2.1, §2.4).
export const action_legs = sqliteTable(
  'action_legs',
  {
    id: uuidPk(),
    action_id: text('action_id')
      .notNull()
      .references(() => actions.id, { onDelete: 'cascade' }),
    order: integer('order').notNull(),
    target: text('target').notNull(),

    idempotency_key: text('idempotency_key').notNull(),
    params: jsonCol<Record<string, unknown>>('params').notNull(),
    status: text('status').$type<ActionStatus>().notNull().default('drafted'),
    error: text('error'),
    executed_at: timestamp('executed_at'),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    by_action: index('action_legs_by_action').on(t.action_id, t.order),
    leg_idem_idx: uniqueIndex('action_legs_idem_idx').on(t.idempotency_key),
  }),
);

export type ActionLegRow = typeof action_legs.$inferSelect;
export type NewActionLegRow = typeof action_legs.$inferInsert;
