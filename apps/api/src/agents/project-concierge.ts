import type { Event } from '@linkbook/types';
import { actionCatalog } from '@linkbook/types';
import { schema } from '@linkbook/db';
import type { AppCtx } from '../lib/principal-context.js';
import { getAgentspanClient, proposeWithFallback } from './runtime.js';
import { createHash } from 'node:crypto';
import { computeIdempotencyKey, findDuplicateInWindow } from '../idempotency.js';

// §5.3 — Project Concierge: contract.signed → propose 4-leg kickoff.
// Composite: harvest project + airtable record + drive folder + welcome email.

const VERSION = 'v1.0';

export async function runProjectConcierge(event: Event, ctx: AppCtx): Promise<void> {
  if (event.type !== 'contract.signed') return;

  const client = getAgentspanClient(ctx.cfg);
  const result = await proposeWithFallback(
    client,
    { agent: 'project_concierge', agent_version: VERSION, event, context: {} },
    ctx.log,
  );
  if (!result.ok) return;

  const project_name = `${event.payload.title} — kickoff`;
  const params = {
    contract_id: event.payload.signature_request_id,
    client_id: event.payload.client_id ?? '00000000-0000-0000-0000-000000000000',
    project_name,
    budget_hours: 240, // TODO(context): pull from contract metadata
    drive_template: 'retainer-brand-identity',
  };
  const idem = computeIdempotencyKey('project.kickoff', event.subject_ref, params);
  const dup = await findDuplicateInWindow(ctx, idem);
  if (dup) {
    ctx.log.info({ idem, prior: dup.id }, 'concierge: duplicate within 24h, skipping');
    return;
  }

  const action = ctx.db
    .insert(schema.actions)
    .values({
      type: 'project.kickoff',
      params,
      mode: 'proposed',
      drafted_by: `agent:project_concierge@${VERSION}`,
      status: 'drafted',
      reversal_class: actionCatalog['project.kickoff'].reversal_class,
      idempotency_key: idem,
      agent_confidence: String(result.proposal.confidence),
      agent_rationale: result.proposal.rationale,
      preview: `4-leg kickoff for ${project_name}`,
      originating_event_id: event.event_id,
      subject_ref: event.subject_ref,
    })
    .returning()
    .get();

  // §2.4 — each leg has its own idempotency key.
  const legs = [
    {
      target: 'harvest:create_project',
      params: { name: project_name, client_id: params.client_id, budget_hours: params.budget_hours },
    },
    {
      target: 'airtable:insert_record',
      params: { table: 'projects', fields: { name: project_name, status: 'Kickoff' } },
    },
    {
      target: 'drive:create_folder',
      params: { path: `/clients/${params.client_id}/${project_name}` },
    },
    {
      target: 'gmail:draft_welcome',
      params: { thread_id: null, recipient: 'client@example.com', subject: `Welcome — ${project_name}`, body: 'Looking forward to the kickoff.' },
    },
  ];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    // Per-leg key: legs aren't governed by the §2.4 24h dedupe window;
    // they only need to be unique per (action_id, leg). Hash the action
    // id + target + params so two kickoffs for the same subject don't
    // collide under the unique index on action_legs.idempotency_key.
    const legKey = createHash('sha256')
      .update(`${action.id}|${leg.target}|${JSON.stringify(leg.params)}`)
      .digest('hex');
    ctx.db
      .insert(schema.action_legs)
      .values({
        action_id: action.id,
        order: i,
        target: leg.target,
        params: leg.params,
        idempotency_key: legKey,
      })
      .run();
  }

  ctx.db
    .insert(schema.audit_events)
    .values({
      actor: `agent:project_concierge@${VERSION}`,
      originating_event_id: event.event_id,
      kind: 'agent.proposed',
      idempotency_key: idem,
      subject_ref: event.subject_ref,
      note: result.proposal.rationale,
    })
    .run();
}
