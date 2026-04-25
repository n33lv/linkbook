import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import type { EventType, EventState } from '@linkbook/types';
import type { AppCtx } from '../lib/principal-context.js';

export type InsertEventInput = {
  source: string;
  type: EventType;
  subject_ref: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
  priority_score: number;
  suggested_actions: string[];
  dedupe_key: string;
  thread_id?: string | null;
};

export async function insertEventIdempotent(
  ctx: AppCtx,
  input: InsertEventInput,
): Promise<{ inserted: boolean; row: typeof schema.events.$inferSelect }> {
  // dedupe by (type, subject_ref, dedupe_key)
  const existing = ctx.db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.type, input.type),
        eq(schema.events.subject_ref, input.subject_ref),
        eq(schema.events.dedupe_key, input.dedupe_key),
      ),
    )
    .all();
  if (existing[0]) return { inserted: false, row: existing[0] };

  const row = ctx.db
    .insert(schema.events)
    .values({
      source: input.source,
      type: input.type,
      subject_ref: input.subject_ref,
      occurred_at: input.occurred_at,
      payload: input.payload,
      priority_score: input.priority_score,
      suggested_actions: input.suggested_actions,
      dedupe_key: input.dedupe_key,
      thread_id: input.thread_id ?? null,
      state: 'unread',
    })
    .returning()
    .get();
  return { inserted: true, row };
}

export async function setEventState(
  ctx: AppCtx,
  event_id: string,
  state: EventState,
  reason?: string,
): Promise<void> {
  ctx.db
    .update(schema.events)
    .set({ state, updated_at: new Date() })
    .where(eq(schema.events.id, event_id))
    .run();
  ctx.db
    .insert(schema.audit_events)
    .values({
      actor: 'system',
      originating_event_id: event_id,
      kind: 'event.state_changed',
      subject_ref: 'event:' + event_id,
      transition: { to: state, reason: reason ?? null },
    })
    .run();
}

export async function autoResolveEventsForSubject(
  ctx: AppCtx,
  subject_ref: string,
  reason: string,
): Promise<number> {
  // §2.3 — auto-resolve: if the source state changes (e.g. invoice paid)
  // and an unread/read event for that subject_ref no longer applies,
  // mark it `done` automatically. This is internal bookkeeping, not a
  // write to the source system.
  const rows = ctx.db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.subject_ref, subject_ref),
        sql`${schema.events.state} IN ('unread','read','waiting')`,
      ),
    )
    .all();
  for (const r of rows) {
    await setEventState(ctx, r.id, 'done', reason);
    ctx.db
      .insert(schema.audit_events)
      .values({
        actor: 'system',
        originating_event_id: r.id,
        kind: 'event.auto_resolved',
        subject_ref: r.subject_ref,
        note: reason,
      })
      .run();
  }
  return rows.length;
}
