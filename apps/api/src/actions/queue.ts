// §2.5 — 30s soft-undo for email/Slack actions.
// In-process v1: a setTimeout per queued action.
// Restart recovery: on boot, drain queued_30s rows whose timer has already
// elapsed and re-arm setTimeout for the rest. (Bridges the gap until the
// Conductor workflow lands.)
//
// Race-free: timer fire and undo both use a CAS update on the status
// column so only one can win.

import type { ActionType } from '@linkbook/types';
import type { AppCtx } from '../lib/principal-context.js';
import { findActionById, writeAudit } from '../db/actions-repo.js';
import { executeAction } from './execute.js';
import { schema } from '@linkbook/db';
import { and, eq, sql } from 'drizzle-orm';

const TIMERS = new Map<string, NodeJS.Timeout>();

const QUEUEABLE: readonly ActionType[] = ['invoice.remind', 'email.send_draft', 'time.self_nudge'];

export function isQueueable(type: ActionType): boolean {
  return QUEUEABLE.includes(type);
}

// Configurable via env so tests can run against a fast queue.
export function getSendDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['SEND_DELAY_MS'];
  if (!raw) return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

// Race-free CAS: returns the number of rows affected (0 or 1). better-sqlite3
// reliably returns { changes }, but we double-check with a post-update read
// in case a future driver swap changes that contract.
function casStatus(
  ctx: AppCtx,
  action_id: string,
  from: string,
  to: string,
  patch?: Partial<typeof schema.actions.$inferInsert>,
): number {
  const result = ctx.db
    .update(schema.actions)
    .set({ ...patch, status: to as never, updated_at: new Date() })
    .where(and(eq(schema.actions.id, action_id), eq(schema.actions.status, from as never)))
    .run();
  if (typeof result.changes === 'number') return result.changes;
  // fallback: confirm by reading
  const row = ctx.db.select().from(schema.actions).where(eq(schema.actions.id, action_id)).all()[0];
  return row && row.status === to ? 1 : 0;
}

export async function enqueueSendDelay(ctx: AppCtx, action_id: string): Promise<void> {
  const delay = getSendDelayMs();
  const queued_until = new Date(Date.now() + delay);
  // CAS from drafted → queued_30s; protects against double-approval.
  const changed = casStatus(ctx, action_id, 'drafted', 'queued_30s', { queued_until });
  if (changed === 0) {
    // already moved on
    const cur = await findActionById(ctx, action_id);
    if (cur && cur.status === 'queued_30s') {
      // already queued; just (re-)arm the timer
      armTimer(ctx, action_id, queued_until.getTime() - Date.now());
      return;
    }
    throw new Error('action not in drafted state');
  }
  const a = await findActionById(ctx, action_id);
  await writeAudit(ctx, {
    actor: 'system',
    action_id,
    kind: 'action.queued',
    idempotency_key: a?.idempotency_key ?? null,
    subject_ref: a?.subject_ref ?? '',
  });
  armTimer(ctx, action_id, delay);
}

function armTimer(ctx: AppCtx, action_id: string, ms: number): void {
  const t = setTimeout(() => {
    TIMERS.delete(action_id);
    // CAS from queued_30s → executing. If user already cancelled, we lose.
    const won = casStatus(ctx, action_id, 'queued_30s', 'executing', { executed_at: new Date() });
    if (won === 0) {
      ctx.log.info({ action_id }, 'queue: timer fired but action already cancelled');
      return;
    }
    findActionById(ctx, action_id)
      .then(async (a) => {
        if (!a) return;
        // §2.6 audit trail for the queued_30s → executing transition.
        await writeAudit(ctx, {
          actor: 'system',
          action_id,
          originating_event_id: a.originating_event_id,
          kind: 'action.executing',
          idempotency_key: a.idempotency_key,
          subject_ref: a.subject_ref,
          note: 'queue timer elapsed',
        });
        // alreadyExecuting=true so executeAction doesn't redundantly flip
        // status (which would clobber any concurrent terminal state).
        await executeAction(ctx, a, { alreadyExecuting: true });
      })
      .catch((e) => ctx.log.error({ err: e, action_id }, 'queue dispatch failed'));
  }, Math.max(0, ms));
  t.unref?.();
  TIMERS.set(action_id, t);
}

export async function cancelSendDelay(ctx: AppCtx, action_id: string): Promise<boolean> {
  // Cancel the in-process timer first (best-effort) then CAS the row.
  const t = TIMERS.get(action_id);
  if (t) {
    clearTimeout(t);
    TIMERS.delete(action_id);
  }
  const changed = casStatus(ctx, action_id, 'queued_30s', 'cancelled');
  if (changed === 0) return false;
  const a = await findActionById(ctx, action_id);
  await writeAudit(ctx, {
    actor: 'user',
    action_id,
    kind: 'action.cancelled',
    idempotency_key: a?.idempotency_key ?? null,
    subject_ref: a?.subject_ref ?? '',
    note: 'soft-undo (30s window)',
  });
  return true;
}

// Boot-time recovery — call from server.ts after migrations apply.
// Past-deadline rows fire with random jitter (0–500ms) to avoid a
// thundering herd against integrations after a long downtime; future
// rows arm at their remaining time.
export async function recoverQueueOnBoot(ctx: AppCtx): Promise<void> {
  const queued = ctx.db
    .select()
    .from(schema.actions)
    .where(eq(schema.actions.status, 'queued_30s'))
    .all();
  for (const a of queued) {
    const remaining = a.queued_until ? a.queued_until.getTime() - Date.now() : 0;
    const armAfter = remaining > 0 ? remaining : Math.floor(Math.random() * 500);
    armTimer(ctx, a.id, armAfter);
  }
  if (queued.length > 0) {
    ctx.log.info({ count: queued.length }, 'queue: recovered queued_30s actions on boot');
  }
}

export function _clearAllTimers(): void {
  for (const t of TIMERS.values()) clearTimeout(t);
  TIMERS.clear();
}

// kept for compatibility with old callers; readers use getSendDelayMs() now
export const SEND_DELAY_MS = 30_000;
