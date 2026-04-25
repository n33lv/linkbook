import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidPk, timestamp } from './_helpers.js';
import { clients } from './clients.js';

// §5.1 — HARD RULE: Linkbook never owns a project entity.
// Read-through join cache of Harvest project + Airtable record.

export const projects = sqliteTable(
  'projects',
  {
    id: uuidPk(),

    client_id: text('client_id')
      .notNull()
      .references(() => clients.id),
    name: text('name').notNull(),

    harvest_project_id: text('harvest_project_id'),
    airtable_record_id: text('airtable_record_id'),

    status: text('status'),
    owner: text('owner'),
    budget_hours: integer('budget_hours'),
    hours_used: integer('hours_used'),
    last_status_update_at: timestamp('last_status_update_at'),

    last_synced_at: timestamp('last_synced_at').notNull().$defaultFn(() => new Date()),
    harvest_etag: text('harvest_etag'),
    airtable_etag: text('airtable_etag'),

    created_at: timestamp('created_at').notNull().$defaultFn(() => new Date()),
    updated_at: timestamp('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    harvest_idx: uniqueIndex('projects_harvest_idx').on(t.harvest_project_id),
    airtable_idx: uniqueIndex('projects_airtable_idx').on(t.airtable_record_id),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
