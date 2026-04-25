import type { Event } from '@linkbook/types';
import { actionCatalog } from '@linkbook/types';
import { schema } from '@linkbook/db';
import type { AppCtx } from '../lib/principal-context.js';
import { getAgentspanClient, proposeWithFallback } from './runtime.js';
import { computeIdempotencyKey, findDuplicateInWindow } from '../idempotency.js';

const VERSION = 'v1.0';

export async function runTimeSentinel(event: Event, ctx: AppCtx): Promise<void> {
  if (event.type !== 'time.missing_yesterday') return;

  const client = getAgentspanClient(ctx.cfg);
  const result = await proposeWithFallback(
    client,
    { agent: 'time_sentinel', agent_version: VERSION, event, context: {} },
    ctx.log,
  );
  if (!result.ok) return;

  const params = {
    message: `You logged ${event.payload.hours_logged}h on ${event.payload.date}. Mind finishing your timesheet before Friday?`,
  };
  const idem = computeIdempotencyKey('time.self_nudge', event.subject_ref, params);
  const dup = await findDuplicateInWindow(ctx, idem);
  if (dup) {
    ctx.log.info({ idem, prior: dup.id }, 'time sentinel: duplicate within 24h, skipping');
    return;
  }

  ctx.db
    .insert(schema.actions)
    .values({
      type: 'time.self_nudge',
      params,
      mode: 'proposed',
      drafted_by: `agent:time_sentinel@${VERSION}`,
      status: 'drafted',
      reversal_class: actionCatalog['time.self_nudge'].reversal_class,
      idempotency_key: idem,
      agent_confidence: String(result.proposal.confidence),
      agent_rationale: result.proposal.rationale,
      preview: params.message,
      originating_event_id: event.event_id,
      subject_ref: event.subject_ref,
    })
    .run();
}
