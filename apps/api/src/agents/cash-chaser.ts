import type { Event } from '@linkbook/types';
import { actionCatalog } from '@linkbook/types';
import { schema } from '@linkbook/db';
import type { AppCtx } from '../lib/principal-context.js';
import { getAgentspanClient, proposeWithFallback } from './runtime.js';
import { computeIdempotencyKey, findDuplicateInWindow } from '../idempotency.js';

// §5.3 — Cash Chaser fires on overdue/aging invoice events.

const VERSION = 'v1.0';

export async function runCashChaser(event: Event, ctx: AppCtx): Promise<void> {
  if (
    event.type !== 'invoice.overdue' &&
    event.type !== 'invoice.aging_30' &&
    event.type !== 'invoice.aging_60' &&
    event.type !== 'invoice.aging_90'
  ) {
    return;
  }

  const client = getAgentspanClient(ctx.cfg);
  const result = await proposeWithFallback(
    client,
    { agent: 'cash_chaser', agent_version: VERSION, event, context: {} },
    ctx.log,
  );

  if (!result.ok) {
    await emitNeedsApproval(ctx, event, 'cash_chaser');
    return;
  }

  // Tone scaling per spec: polite at <30d overdue, firm at 30-60, final at 60+.
  const days = event.payload.days_overdue;
  const tone = days >= 60 ? 'final' : days >= 30 ? 'firm' : 'polite';
  const recipient = await guessClientEmail(ctx, event.payload.client_id);
  if (!recipient) {
    ctx.log.warn({ subject: event.subject_ref }, 'cash chaser: no recipient email; skipping');
    return;
  }

  const subject = `Invoice ${event.payload.invoice_id} — ${
    tone === 'polite' ? 'a friendly reminder' : tone === 'firm' ? 'second notice' : 'urgent reminder'
  }`;
  const body = renderReminderBody(tone, event, ctx.cfg.DEV_PRINCIPAL_NAME);

  const params = {
    invoice_id: event.payload.invoice_id,
    recipient,
    cc: [],
    tone,
    subject,
    body,
  };
  const idem = computeIdempotencyKey('invoice.remind', event.subject_ref, params);
  // §2.4 — reject duplicates within 24h.
  const dup = await findDuplicateInWindow(ctx, idem);
  if (dup) {
    ctx.log.info({ idem, prior: dup.id }, 'cash chaser: duplicate within 24h, skipping');
    return;
  }

  ctx.db
    .insert(schema.actions)
    .values({
      type: 'invoice.remind',
      params,
      mode: 'proposed',
      drafted_by: `agent:cash_chaser@${VERSION}`,
      status: 'drafted',
      reversal_class: actionCatalog['invoice.remind'].reversal_class,
      idempotency_key: idem,
      agent_confidence: String(result.proposal.confidence),
      agent_rationale: result.proposal.rationale,
      preview: body,
      originating_event_id: event.event_id,
      subject_ref: event.subject_ref,
    })
    .run();

  ctx.db
    .insert(schema.audit_events)
    .values({
      actor: `agent:cash_chaser@${VERSION}`,
      originating_event_id: event.event_id,
      kind: 'agent.proposed',
      idempotency_key: idem,
      subject_ref: event.subject_ref,
      note: result.proposal.rationale,
    })
    .run();
}

async function guessClientEmail(_ctx: AppCtx, _client_id: string): Promise<string | null> {
  // TODO(integrations:gmail): real-deal lookup via gmail_threads recent
  // sender. For v1 demo we synthesize a domain from the client name.
  // Mocked path: caller will populate gmail_threads with realistic emails.
  return 'client@example.com';
}

function renderReminderBody(
  tone: 'polite' | 'firm' | 'final',
  e: Event & { type: 'invoice.overdue' | 'invoice.aging_30' | 'invoice.aging_60' | 'invoice.aging_90' },
  signOff: string,
): string {
  const days = e.payload.days_overdue;
  const amt = (e.payload.amount_cents / 100).toFixed(2);
  if (tone === 'polite') {
    return `Hi,\n\nQuick note that invoice ${e.payload.invoice_id} ($${amt}) is now ${days} days past due. Could you take a look when you get a moment?\n\nThanks,\n${signOff}`;
  }
  if (tone === 'firm') {
    return `Hi,\n\nWe sent invoice ${e.payload.invoice_id} ($${amt}) and a follow-up without a response. The invoice is now ${days} days past due. Could you let me know whether this is in process, or if there's a question on our end? Happy to jump on a call.\n\nThanks,\n${signOff}`;
  }
  return `Hi,\n\nInvoice ${e.payload.invoice_id} ($${amt}) is now ${days} days past due. We need to resolve this — please reply today or let me know a date you can pay by.\n\n${signOff}`;
}

async function emitNeedsApproval(ctx: AppCtx, event: Event, agent: string): Promise<void> {
  const { ingestEvent } = await import('../ingestion.js');
  await ingestEvent(ctx, {
    source: 'linkbook',
    type: 'agent.needs_approval',
    subject_ref: event.subject_ref,
    occurred_at: new Date(),
    payload: { agent_name: agent, action_id: '00000000-0000-0000-0000-000000000000' },
    dedupe_key: `${agent}:${event.subject_ref}`,
  });
}
