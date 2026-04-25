// Funnel for every source. Webhooks + CDC + cron jobs all build a NewEvent
// shape and call ingestEvent(). Centralizes:
//   * priority scoring (§1.3)
//   * action recommendation (§5.3 Triage)
//   * dedupe + insert
//   * agent fan-out (§5.3 — observe/propose, never auto-execute)

import type { Source, EventType, Event } from '@linkbook/types';
import { eventSchema } from '@linkbook/types';
import type { AppCtx } from './lib/principal-context.js';
import { computePriorityScore, rankInputsFromEvent } from './ranking.js';
import { recommendedActionsFor } from './agents/triage.js';
import { insertEventIdempotent } from './db/events-repo.js';
import { findClientById } from './db/clients-repo.js';
import { runCashChaser } from './agents/cash-chaser.js';
import { runProjectConcierge } from './agents/project-concierge.js';
import { runTimeSentinel } from './agents/time-sentinel.js';
import { runReconciler } from './agents/reconciler.js';

export type IngestInput = {
  source: Source;
  type: EventType;
  subject_ref: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
  // dedupe key — typically derived per-source (e.g. for aging events,
  // the bucket name; for invoice.paid, the paid_at date).
  dedupe_key: string;
};

export type IngestOutput = {
  inserted: boolean;
  event_id: string;
  priority_score: number;
};

export async function ingestEvent(ctx: AppCtx, input: IngestInput): Promise<IngestOutput> {
  // 1. Build the typed Event shell so we can rank using the discriminated union.
  // We construct what's effectively a NewEvent + sentinel id; ranking only
  // reads the payload + type.
  const ranked = rankWithDefaults(ctx, {
    source: input.source,
    type: input.type,
    subject_ref: input.subject_ref,
    occurred_at: input.occurred_at,
    ingested_at: new Date(),
    priority_score: 0,
    state: 'unread',
    suggested_actions: [],
    dedupe_key: input.dedupe_key,
    thread_id: null,
    event_id: '00000000-0000-0000-0000-000000000000',
    payload: input.payload,
  } as unknown as Event);

  const suggested = [...recommendedActionsFor(input.type)];

  const { inserted, row } = await insertEventIdempotent(ctx, {
    source: input.source,
    type: input.type,
    subject_ref: input.subject_ref,
    occurred_at: input.occurred_at,
    payload: input.payload,
    priority_score: ranked,
    suggested_actions: suggested,
    dedupe_key: input.dedupe_key,
  });

  if (!inserted) {
    ctx.log.debug({ type: input.type, subject_ref: input.subject_ref }, 'event deduped');
    return { inserted: false, event_id: row.id, priority_score: row.priority_score };
  }

  ctx.log.info(
    { type: input.type, subject_ref: input.subject_ref, score: ranked },
    'event ingested',
  );

  // 2. Agent fan-out. Each agent gates on event type internally; we
  // call all candidates and let them decide.
  // Build the typed Event for the agent contract.
  const fullEvent = buildEventForAgent({
    id: row.id,
    source: input.source,
    type: input.type,
    subject_ref: input.subject_ref,
    occurred_at: input.occurred_at,
    ingested_at: row.ingested_at,
    priority_score: ranked,
    payload: input.payload,
    state: 'unread',
    suggested_actions: suggested,
    dedupe_key: input.dedupe_key,
    thread_id: row.thread_id,
  });

  // Best-effort, non-fatal: agents shouldn't break ingestion.
  await Promise.allSettled([
    runCashChaser(fullEvent, ctx).catch((e) => ctx.log.warn({ err: e }, 'cash chaser failed')),
    runProjectConcierge(fullEvent, ctx).catch((e) =>
      ctx.log.warn({ err: e }, 'project concierge failed'),
    ),
    runTimeSentinel(fullEvent, ctx).catch((e) =>
      ctx.log.warn({ err: e }, 'time sentinel failed'),
    ),
    runReconciler(fullEvent, ctx).catch((e) => ctx.log.warn({ err: e }, 'reconciler failed')),
  ]);

  return { inserted: true, event_id: row.id, priority_score: ranked };
}

function rankWithDefaults(_ctx: AppCtx, e: Event): number {
  // Try to find client tier by joining the payload's client_id (if any)
  // back to clients. We do this synchronously below in the agent path;
  // for ranking we accept null-tier when we don't know yet.
  const inputs = rankInputsFromEvent(e, {
    client_tier: null,
    is_blocking_other_work: false,
    days_unread_in_inbox: 0,
    snooze_decay: 0,
  });
  // Use the same config snapshot the rest of the app uses; ingestion
  // happens in-request so we have ctx.cfg available — pass it through.
  return computePriorityScore(inputs, _ctx.cfg).total;
}

// Re-rank with full client context after insert (called from caller when
// they know the client_id). Used by webhook normalizers that have it.
export async function rerankWithClient(
  ctx: AppCtx,
  event_id: string,
  client_id: string | null,
  evt: Event,
): Promise<number> {
  let tier: 1 | 2 | 3 | null = null;
  if (client_id) {
    const c = await findClientById(ctx, client_id);
    tier = (c?.tier as 1 | 2 | 3 | null) ?? null;
  }
  const inputs = rankInputsFromEvent(evt, {
    client_tier: tier,
    is_blocking_other_work: false,
    days_unread_in_inbox: 0,
    snooze_decay: 0,
  });
  const score = computePriorityScore(inputs, ctx.cfg).total;
  // persist
  const { schema } = await import('@linkbook/db');
  const { eq } = await import('drizzle-orm');
  ctx.db.update(schema.events).set({ priority_score: score }).where(eq(schema.events.id, event_id)).run();
  return score;
}

function buildEventForAgent(input: {
  id: string;
  source: Source;
  type: EventType;
  subject_ref: string;
  occurred_at: Date;
  ingested_at: Date;
  priority_score: number;
  payload: Record<string, unknown>;
  state: 'unread';
  suggested_actions: string[];
  dedupe_key: string;
  thread_id: string | null;
}): Event {
  // Validate against the discriminated union so agents get a typed payload.
  const parsed = eventSchema.parse({
    event_id: input.id,
    source: input.source,
    type: input.type,
    subject_ref: input.subject_ref,
    occurred_at: input.occurred_at,
    ingested_at: input.ingested_at,
    priority_score: input.priority_score,
    state: input.state,
    suggested_actions: input.suggested_actions,
    dedupe_key: input.dedupe_key,
    thread_id: input.thread_id,
    payload: input.payload,
  });
  return parsed;
}
