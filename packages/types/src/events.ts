import { z } from 'zod';
import { sourceSchema } from './sources.js';

// §1.2 — closed event taxonomy. Anything not in this list is logged but not
// surfaced. Adding a type means adding it here AND in the Inbox UI.

export const eventTypeSchema = z.enum([
  // Money in
  'invoice.overdue',
  'invoice.aging_30',
  'invoice.aging_60',
  'invoice.aging_90',
  'invoice.paid',
  'invoice.draft_ready_to_send',
  'payment.received_unapplied',
  // Money out
  'bill.due_in_3_days',
  'expense.uncategorized',
  // Time
  'time.missing_yesterday',
  'time.budget_threshold_80',
  'time.budget_threshold_100',
  'time.budget_threshold_120',
  'time.uninvoiced_over_threshold',
  // Contracts
  'contract.sent_unsigned_5d',
  'contract.signed',
  'contract.declined',
  // Project
  'project.status_stale',
  'project.milestone_due_soon',
  'project.milestone_overdue',
  // Client comms
  'email.client_reply_awaiting_response_3d',
  // System
  'integration.disconnected',
  'integration.harvest_qbo_sync_lag',
  'action.failed',
  'agent.needs_approval',
]);

export type EventType = z.infer<typeof eventTypeSchema>;

// `subject_ref` always reads "kind:id". The kind list mirrors the entities
// the event types operate on. Stored as a single TEXT column at the DB layer
// for cheap threading (§1.5 — thread by subject_ref).
export const subjectKindSchema = z.enum([
  'invoice',
  'payment',
  'bill',
  'expense',
  'contract',
  'project',
  'client',
  'time_entry',
  'thread', // gmail thread
  'integration',
  'action',
]);
export type SubjectKind = z.infer<typeof subjectKindSchema>;

export const subjectRefSchema = z
  .string()
  .regex(/^[a-z_]+:[A-Za-z0-9_\-:]+$/, 'subject_ref must be "kind:id"');

// Lifecycle — §1.4. `waiting` is a proposed action pending external confirmation.
export const eventStateSchema = z.enum([
  'unread',
  'read',
  'done',
  'snoozed',
  'dismissed',
  'waiting',
]);
export type EventState = z.infer<typeof eventStateSchema>;

// The normalized envelope from §1.1. `payload` carries the per-type body —
// kept as a discriminated union below to give callers exhaustive narrowing.
export const eventEnvelopeBaseSchema = z.object({
  event_id: z.string().uuid(),
  source: sourceSchema,
  type: eventTypeSchema,
  subject_ref: subjectRefSchema,
  occurred_at: z.coerce.date(),
  ingested_at: z.coerce.date(),
  priority_score: z.number().int().min(0).max(100),
  state: eventStateSchema,
  // suggested_actions is a list of action types from §2.2; the actual drafted
  // Actions live in the actions table. Kept as strings here to avoid a
  // circular import with actions.ts.
  suggested_actions: z.array(z.string()),
  dedupe_key: z.string(),
  thread_id: z.string().uuid().nullable(),
});

// ---------- per-type payload shapes ----------
// Each shape is the minimal data the UI / agents need *without* re-fetching
// the source system. We re-fetch on action execute (§5.3 hallucination guard).

const invoiceAgingPayload = z.object({
  invoice_id: z.string(),
  client_id: z.string().uuid(),
  amount_cents: z.number().int(),
  currency: z.string().length(3),
  issued_at: z.coerce.date(),
  due_at: z.coerce.date(),
  days_overdue: z.number().int().min(0),
});

const invoicePaidPayload = z.object({
  invoice_id: z.string(),
  client_id: z.string().uuid(),
  amount_cents: z.number().int(),
  currency: z.string().length(3),
  paid_at: z.coerce.date(),
});

const invoiceDraftPayload = z.object({
  harvest_invoice_id: z.string(),
  client_id: z.string().uuid(),
  amount_cents: z.number().int(),
  drafted_at: z.coerce.date(),
});

const paymentUnappliedPayload = z.object({
  qbo_payment_id: z.string(),
  customer_name_raw: z.string(),
  amount_cents: z.number().int(),
  received_at: z.coerce.date(),
  // candidate matches surface in the Inbox row + Reconciler proposal
  candidate_invoice_ids: z.array(z.string()),
});

const billDuePayload = z.object({
  qbo_bill_id: z.string(),
  vendor: z.string(),
  amount_cents: z.number().int(),
  due_at: z.coerce.date(),
});

const expenseUncategorizedPayload = z.object({
  qbo_expense_id: z.string(),
  amount_cents: z.number().int(),
  occurred_at: z.coerce.date(),
});

const timeMissingPayload = z.object({
  harvest_user_id: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours_logged: z.number().min(0),
});

const timeBudgetPayload = z.object({
  project_id: z.string().uuid(),
  harvest_project_id: z.string(),
  hours_used: z.number().min(0),
  hours_budgeted: z.number().min(0),
  pct: z.number().min(0),
});

const timeUninvoicedPayload = z.object({
  client_id: z.string().uuid(),
  uninvoiced_amount_cents: z.number().int(),
});

const contractPayload = z.object({
  signature_request_id: z.string(),
  title: z.string(),
  client_id: z.string().uuid().nullable(),
  sent_at: z.coerce.date(),
});

const contractSignedPayload = contractPayload.extend({
  signed_at: z.coerce.date(),
});

const projectStalePayload = z.object({
  project_id: z.string().uuid(),
  airtable_record_id: z.string(),
  days_silent: z.number().int().min(0),
});

const projectMilestonePayload = z.object({
  project_id: z.string().uuid(),
  airtable_record_id: z.string(),
  milestone_name: z.string(),
  due_at: z.coerce.date(),
});

const emailReplyPayload = z.object({
  gmail_thread_id: z.string(),
  client_id: z.string().uuid(),
  last_inbound_at: z.coerce.date(),
  subject: z.string(),
});

const integrationDisconnectedPayload = z.object({
  source: sourceSchema,
  reason: z.string(),
});

const harvestQboLagPayload = z.object({
  harvest_invoice_id: z.string(),
  drafted_at: z.coerce.date(),
  hours_since_draft: z.number(),
});

const actionFailedPayload = z.object({
  action_id: z.string().uuid(),
  action_type: z.string(),
  error: z.string(),
  http_status: z.number().int().nullable(),
});

const agentApprovalPayload = z.object({
  agent_name: z.string(),
  action_id: z.string().uuid(),
});

// ---------- discriminated union: full Event ----------

export const eventSchema = z.discriminatedUnion('type', [
  eventEnvelopeBaseSchema.extend({ type: z.literal('invoice.overdue'), payload: invoiceAgingPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('invoice.aging_30'), payload: invoiceAgingPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('invoice.aging_60'), payload: invoiceAgingPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('invoice.aging_90'), payload: invoiceAgingPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('invoice.paid'), payload: invoicePaidPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('invoice.draft_ready_to_send'), payload: invoiceDraftPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('payment.received_unapplied'), payload: paymentUnappliedPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('bill.due_in_3_days'), payload: billDuePayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('expense.uncategorized'), payload: expenseUncategorizedPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('time.missing_yesterday'), payload: timeMissingPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('time.budget_threshold_80'), payload: timeBudgetPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('time.budget_threshold_100'), payload: timeBudgetPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('time.budget_threshold_120'), payload: timeBudgetPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('time.uninvoiced_over_threshold'), payload: timeUninvoicedPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('contract.sent_unsigned_5d'), payload: contractPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('contract.signed'), payload: contractSignedPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('contract.declined'), payload: contractPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('project.status_stale'), payload: projectStalePayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('project.milestone_due_soon'), payload: projectMilestonePayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('project.milestone_overdue'), payload: projectMilestonePayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('email.client_reply_awaiting_response_3d'), payload: emailReplyPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('integration.disconnected'), payload: integrationDisconnectedPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('integration.harvest_qbo_sync_lag'), payload: harvestQboLagPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('action.failed'), payload: actionFailedPayload }),
  eventEnvelopeBaseSchema.extend({ type: z.literal('agent.needs_approval'), payload: agentApprovalPayload }),
]);

export type Event = z.infer<typeof eventSchema>;

// Helper for inserting a fresh event (omits server-assigned fields).
export const newEventSchema = eventSchema.transform((e) => e); // placeholder; consumers build per-type
export type NewEvent = Omit<Event, 'event_id' | 'ingested_at' | 'state' | 'priority_score' | 'thread_id'> & {
  // Server fills these in; allow optional overrides for tests.
  event_id?: string;
  ingested_at?: Date;
  state?: EventState;
  priority_score?: number;
  thread_id?: string | null;
};
