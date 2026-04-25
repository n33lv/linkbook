import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import { z } from 'zod';
import { findActionById } from '../db/actions-repo.js';
import { isQueueable, enqueueSendDelay } from '../actions/queue.js';
import { executeAction } from '../actions/execute.js';
import { undoAction } from '../actions/undo.js';

export const actionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/actions', async (req, _reply) => {
    const q = z
      .object({
        status: z.enum(['open', 'failed', 'done', 'all']).default('open'),
      })
      .parse(req.query);
    const db = app.db;
    const where =
      q.status === 'open'
        ? sql`${schema.actions.status} IN ('drafted','queued_30s','approved','executing')`
        : q.status === 'failed'
          ? eq(schema.actions.status, 'failed')
          : q.status === 'done'
            ? sql`${schema.actions.status} IN ('succeeded','undone','cancelled')`
            : sql`1=1`;
    const actions = db
      .select()
      .from(schema.actions)
      .where(where)
      .orderBy(desc(schema.actions.created_at))
      .all();

    const stats = computeQueueStats(db);
    return { actions, stats };
  });

  app.get('/actions/:action_id', async (req, reply) => {
    const { action_id } = z.object({ action_id: z.string().uuid() }).parse(req.params);
    const db = app.db;
    const action = db.select().from(schema.actions).where(eq(schema.actions.id, action_id)).all()[0];
    if (!action) return reply.code(404).send({ error: 'not_found' });
    const legs = db
      .select()
      .from(schema.action_legs)
      .where(eq(schema.action_legs.action_id, action_id))
      .all();
    const audit = db
      .select()
      .from(schema.audit_events)
      .where(eq(schema.audit_events.subject_ref, action.subject_ref))
      .orderBy(desc(schema.audit_events.created_at))
      .all();
    return { action, legs, audit };
  });

  app.post('/actions/:action_id/approve', async (req, reply) => {
    const { action_id } = z.object({ action_id: z.string().uuid() }).parse(req.params);
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };
    const action = await findActionById(ctx, action_id);
    if (!action) return reply.code(404).send({ error: 'not_found' });
    if (action.status !== 'drafted') {
      return reply.code(409).send({ error: 'not_drafted', status: action.status });
    }

    if (isQueueable(action.type)) {
      await enqueueSendDelay(ctx, action_id);
      return { ok: true, status: 'queued_30s' };
    }
    const result = await executeAction(ctx, action);
    if (!result.ok) {
      return reply.code(502).send({ error: 'execute_failed', detail: result.error });
    }
    if (result.status === 'cancelled') {
      // §5.3 hallucination guard: subject state changed, action no longer applies.
      return { ok: true, status: 'cancelled', reason: result.reason };
    }
    return { ok: true, status: 'succeeded', undo_token: result.undo_token };
  });

  app.post('/actions/:action_id/edit', async (req, reply) => {
    const { action_id } = z.object({ action_id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        params: z.record(z.unknown()),
      })
      .parse(req.body);
    const db = app.db;
    const action = db.select().from(schema.actions).where(eq(schema.actions.id, action_id)).all()[0];
    if (!action) return reply.code(404).send({ error: 'not_found' });
    if (action.status !== 'drafted') {
      return reply.code(409).send({ error: 'not_drafted' });
    }
    // Recompute idempotency_key — semantic edits change the key, cosmetic
    // edits do not. computeIdempotencyKey re-reads the catalog allowlist.
    const { computeIdempotencyKey } = await import('../idempotency.js');
    const newKey = computeIdempotencyKey(action.type, action.subject_ref, body.params);
    db.update(schema.actions)
      .set({ params: body.params, idempotency_key: newKey, updated_at: new Date() })
      .where(eq(schema.actions.id, action_id))
      .run();
    return { ok: true, idempotency_key: newKey };
  });

  app.post('/actions/:action_id/reject', async (req, reply) => {
    const { action_id } = z.object({ action_id: z.string().uuid() }).parse(req.params);
    const db = app.db;
    // CAS-guarded transition drafted → cancelled. Two concurrent rejects:
    // first wins; second gets 409.
    const upd = db
      .update(schema.actions)
      .set({ status: 'cancelled', updated_at: new Date() })
      .where(and(eq(schema.actions.id, action_id), eq(schema.actions.status, 'drafted')))
      .run();
    if ((upd.changes ?? 0) === 0) {
      const cur = db.select().from(schema.actions).where(eq(schema.actions.id, action_id)).all()[0];
      if (!cur) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'not_drafted', status: cur.status });
    }
    const action = db.select().from(schema.actions).where(eq(schema.actions.id, action_id)).all()[0]!;
    db.insert(schema.audit_events)
      .values({
        actor: 'user',
        action_id,
        originating_event_id: action.originating_event_id,
        kind: 'action.rejected',
        idempotency_key: action.idempotency_key,
        subject_ref: action.subject_ref,
      })
      .run();
    return { ok: true };
  });

  // §2.4 — partial-failure recovery: composite actions that failed mid-flight
  // resume from the failed leg (per-leg idempotency keys make this safe).
  app.post('/actions/:action_id/retry', async (req, reply) => {
    const { action_id } = z.object({ action_id: z.string().uuid() }).parse(req.params);
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };
    const action = await findActionById(ctx, action_id);
    if (!action) return reply.code(404).send({ error: 'not_found' });
    if (action.status !== 'failed') {
      return reply.code(409).send({ error: 'not_failed', status: action.status });
    }
    const { executeAction } = await import('../actions/execute.js');
    const result = await executeAction(ctx, action);
    if (!result.ok) {
      return reply.code(502).send({ error: 'retry_failed', detail: result.error });
    }
    if (result.status === 'cancelled') return { ok: true, status: 'cancelled', reason: result.reason };
    return { ok: true, status: 'succeeded', undo_token: result.undo_token };
  });

  app.post('/actions/:action_id/undo', async (req, reply) => {
    const { action_id } = z.object({ action_id: z.string().uuid() }).parse(req.params);
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };
    const result = await undoAction(ctx, action_id);
    return result.ok ? result : reply.code(409).send(result);
  });
};

function computeQueueStats(db: import('@linkbook/db').Db) {
  const open = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.actions)
    .where(and(sql`${schema.actions.status} IN ('drafted','queued_30s','approved','executing')`))
    .all()[0];
  const failed = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.actions)
    .where(eq(schema.actions.status, 'failed'))
    .all()[0];
  const done = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.actions)
    .where(sql`${schema.actions.status} IN ('succeeded','undone','cancelled')`)
    .all()[0];
  const inflight = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.actions)
    .where(sql`${schema.actions.status} IN ('queued_30s','executing')`)
    .all()[0];
  return {
    open: Number(open?.n ?? 0),
    in_flight: Number(inflight?.n ?? 0),
    failed_today: Number(failed?.n ?? 0),
    done_today: Number(done?.n ?? 0),
  };
}
