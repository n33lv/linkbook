import type { Event } from '@linkbook/types';
import { actionCatalog, RECONCILER_CONFIDENCE_THRESHOLD } from '@linkbook/types';
import { schema } from '@linkbook/db';
import type { AppCtx } from '../lib/principal-context.js';
import { getAgentspanClient, proposeWithFallback } from './runtime.js';
import { computeIdempotencyKey, findDuplicateInWindow } from '../idempotency.js';

const VERSION = 'v1.0';

// §5.3 — Reconciler: triggers on payment.received_unapplied. Below 0.85
// confidence the proposal is suppressed; the user resolves manually.

export async function runReconciler(event: Event, ctx: AppCtx): Promise<void> {
  if (event.type !== 'payment.received_unapplied') return;

  const client = getAgentspanClient(ctx.cfg);
  const result = await proposeWithFallback(
    client,
    {
      agent: 'reconciler',
      agent_version: VERSION,
      event,
      context: { candidate_invoice_ids: event.payload.candidate_invoice_ids },
    },
    ctx.log,
  );
  if (!result.ok) return;
  if (result.proposal.confidence < RECONCILER_CONFIDENCE_THRESHOLD) {
    ctx.log.info(
      {
        confidence: result.proposal.confidence,
        threshold: RECONCILER_CONFIDENCE_THRESHOLD,
      },
      'reconciler below threshold — leaving as manual event',
    );
    return;
  }

  // We only auto-propose when there is EXACTLY one candidate. Multiple
  // candidates always go to the user — applying to the wrong invoice is
  // the failure mode that breaks accountant trust (§4.1, §5.3).
  if (event.payload.candidate_invoice_ids.length !== 1) {
    ctx.log.info(
      { candidates: event.payload.candidate_invoice_ids.length },
      'reconciler: not exactly one candidate — leaving manual',
    );
    return;
  }
  const target_invoice_id = event.payload.candidate_invoice_ids[0];
  if (!target_invoice_id) return;

  const params = {
    payment_id: event.payload.qbo_payment_id,
    invoice_id: target_invoice_id,
    amount_cents: event.payload.amount_cents,
  };
  const idem = computeIdempotencyKey('payment.apply', event.subject_ref, params);
  const dup = await findDuplicateInWindow(ctx, idem);
  if (dup) {
    ctx.log.info({ idem, prior: dup.id }, 'reconciler: duplicate within 24h, skipping');
    return;
  }

  ctx.db
    .insert(schema.actions)
    .values({
      type: 'payment.apply',
      params,
      mode: 'proposed',
      drafted_by: `agent:reconciler@${VERSION}`,
      status: 'drafted',
      reversal_class: actionCatalog['payment.apply'].reversal_class,
      idempotency_key: idem,
      agent_confidence: String(result.proposal.confidence),
      agent_rationale: result.proposal.rationale,
      preview: `Apply $${(params.amount_cents / 100).toFixed(2)} to ${target_invoice_id}`,
      originating_event_id: event.event_id,
      subject_ref: event.subject_ref,
    })
    .run();

  // §2.6 audit row mirroring cash-chaser / concierge.
  ctx.db
    .insert(schema.audit_events)
    .values({
      actor: `agent:reconciler@${VERSION}`,
      originating_event_id: event.event_id,
      kind: 'agent.proposed',
      idempotency_key: idem,
      subject_ref: event.subject_ref,
      note: result.proposal.rationale,
    })
    .run();
}
