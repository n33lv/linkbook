import { and, eq, sql, asc } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import type { ActionStatus } from '@linkbook/types';
import type { AppCtx } from '../lib/principal-context.js';

export async function findActionById(
  ctx: AppCtx,
  id: string,
): Promise<typeof schema.actions.$inferSelect | undefined> {
  const rows = ctx.db.select().from(schema.actions).where(eq(schema.actions.id, id)).all();
  return rows[0];
}

export async function findRecentByIdempotencyKey(
  ctx: AppCtx,
  idempotency_key: string,
  withinMs = 24 * 60 * 60 * 1000,
): Promise<typeof schema.actions.$inferSelect | undefined> {
  const since = new Date(Date.now() - withinMs);
  const rows = ctx.db
    .select()
    .from(schema.actions)
    .where(
      and(
        eq(schema.actions.idempotency_key, idempotency_key),
        sql`${schema.actions.created_at} >= ${since.getTime()}`,
      ),
    )
    .all();
  return rows[0];
}

export async function setActionStatus(
  ctx: AppCtx,
  id: string,
  status: ActionStatus,
  patch?: Partial<typeof schema.actions.$inferInsert>,
): Promise<void> {
  ctx.db
    .update(schema.actions)
    .set({ ...patch, status, updated_at: new Date() })
    .where(eq(schema.actions.id, id))
    .run();
}

export async function listLegs(
  ctx: AppCtx,
  action_id: string,
): Promise<Array<typeof schema.action_legs.$inferSelect>> {
  return ctx.db
    .select()
    .from(schema.action_legs)
    .where(eq(schema.action_legs.action_id, action_id))
    .orderBy(asc(schema.action_legs.order))
    .all();
}

export async function setLegStatus(
  ctx: AppCtx,
  leg_id: string,
  status: ActionStatus,
  patch?: { error?: string; executed_at?: Date },
): Promise<void> {
  ctx.db
    .update(schema.action_legs)
    .set({ status, ...patch })
    .where(eq(schema.action_legs.id, leg_id))
    .run();
}

export async function writeAudit(
  ctx: AppCtx,
  payload: Omit<typeof schema.audit_events.$inferInsert, 'id' | 'created_at'>,
): Promise<void> {
  ctx.db.insert(schema.audit_events).values(payload).run();
}
