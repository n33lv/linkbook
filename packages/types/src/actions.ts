import { z } from 'zod';

// §2.2 — closed action catalog. Every type lists its semantic_payload allowlist
// (the fields hashed into the idempotency key — see §2.4).

export const actionTypeSchema = z.enum([
  // Invoicing & payments
  'invoice.send',
  'invoice.remind',
  'invoice.mark_paid_manual',
  'payment.apply',
  // Contracts
  'contract.send_reminder',
  'contract.create_from_template',
  // Projects
  'project.kickoff',
  'project.mark_complete',
  'project.update_status',
  // Time
  'time.self_nudge',
  'time.log_entry',
  // Client comms
  'email.send_draft',
  // Internal-only (state changes; not "writes" in the §2 sense)
  'task.create',
  'event.snooze',
  'event.dismiss',
  'event.mark_done',
]);
export type ActionType = z.infer<typeof actionTypeSchema>;

// §2.3 — the operator-facing mode. There is no `auto` in v1.
export const actionModeSchema = z.enum(['manual', 'proposed']);
export type ActionMode = z.infer<typeof actionModeSchema>;

// §2.1 — the full state machine. Note `queued_30s` for soft-undo (§2.5).
export const actionStatusSchema = z.enum([
  'drafted',
  'approved',
  'queued_30s',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
  'undone',
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

// §2.5 — every action declares its reversal class at definition time.
export const reversalClassSchema = z.enum([
  'true_undo',
  'compensating',
  'no_undo',
]);
export type ReversalClass = z.infer<typeof reversalClassSchema>;

// drafted_by — who proposed this. `user` for human-initiated, `agent:<name>@<v>`
// for HITL approvals from a proposal. Format enforced via regex.
export const draftedBySchema = z
  .string()
  .regex(/^(user|agent:[a-z_]+@v\d+(\.\d+)*)$/);

// ---------- per-type param shapes ----------

const invoiceSendParams = z.object({
  harvest_invoice_id: z.string(),
});

const invoiceRemindParams = z.object({
  invoice_id: z.string(),
  recipient: z.string().email(),
  cc: z.array(z.string().email()).default([]),
  tone: z.enum(['polite', 'firm', 'final']),
  // body wording is cosmetic per §2.4 — kept as a free string, NOT in the
  // idempotency hash. The semantic key is (recipient, invoice_id, tone).
  subject: z.string(),
  body: z.string(),
});

const invoiceMarkPaidParams = z.object({
  invoice_id: z.string(),
  paid_at: z.coerce.date(),
  amount_cents: z.number().int(),
});

const paymentApplyParams = z.object({
  payment_id: z.string(),
  invoice_id: z.string(),
  amount_cents: z.number().int(),
});

const contractRemindParams = z.object({
  signature_request_id: z.string(),
  recipient: z.string().email(),
  body: z.string(), // cosmetic
});

const contractCreateParams = z.object({
  template_id: z.string(),
  recipient: z.string().email(),
  fields: z.record(z.string()),
});

const projectKickoffParams = z.object({
  contract_id: z.string(),
  client_id: z.string().uuid(),
  project_name: z.string(),
  budget_hours: z.number().int().positive(),
  drive_template: z.string().nullable(),
});

const projectMarkCompleteParams = z.object({
  project_id: z.string().uuid(),
});

const projectUpdateStatusParams = z.object({
  project_id: z.string().uuid(),
  airtable_record_id: z.string(),
  new_status: z.string(),
});

const timeSelfNudgeParams = z.object({
  message: z.string(),
});

const timeLogEntryParams = z.object({
  harvest_project_id: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.number().positive(),
  notes: z.string().nullable(),
});

const emailSendDraftParams = z.object({
  thread_id: z.string().nullable(), // existing thread or new
  recipient: z.string().email(),
  cc: z.array(z.string().email()).default([]),
  subject: z.string(),
  body: z.string(),
});

const taskCreateParams = z.object({
  title: z.string(),
  due_at: z.coerce.date().nullable(),
  subject_ref: z.string().nullable(),
});

const eventStateParams = z.object({
  event_id: z.string().uuid(),
  // for snooze
  wake_at: z.coerce.date().optional(),
});

// ---------- discriminated Action ----------

const actionBaseSchema = z.object({
  action_id: z.string().uuid(),
  drafted_by: draftedBySchema,
  mode: actionModeSchema,
  status: actionStatusSchema,
  // §2.4: deterministic, hash(type, subject_ref, semantic_payload)
  idempotency_key: z.string(),
  reversal_class: reversalClassSchema,
  // free-form preview rendered in the UI (the email body, the diff, etc.)
  preview: z.string(),
  // Each leg of a composite action gets its own idempotency_key (§2.4);
  // legs[] is empty for non-composite actions.
  legs: z
    .array(
      z.object({
        leg_id: z.string().uuid(),
        order: z.number().int().min(0),
        target: z.string(), // e.g. "harvest:create_project"
        idempotency_key: z.string(),
        status: actionStatusSchema,
        executed_at: z.coerce.date().nullable(),
      }),
    )
    .default([]),
  originating_event_id: z.string().uuid().nullable(),
  created_at: z.coerce.date(),
  executed_at: z.coerce.date().nullable(),
  undo_token: z.string().nullable(),
});

export const actionSchema = z.discriminatedUnion('type', [
  actionBaseSchema.extend({ type: z.literal('invoice.send'), params: invoiceSendParams }),
  actionBaseSchema.extend({ type: z.literal('invoice.remind'), params: invoiceRemindParams }),
  actionBaseSchema.extend({ type: z.literal('invoice.mark_paid_manual'), params: invoiceMarkPaidParams }),
  actionBaseSchema.extend({ type: z.literal('payment.apply'), params: paymentApplyParams }),
  actionBaseSchema.extend({ type: z.literal('contract.send_reminder'), params: contractRemindParams }),
  actionBaseSchema.extend({ type: z.literal('contract.create_from_template'), params: contractCreateParams }),
  actionBaseSchema.extend({ type: z.literal('project.kickoff'), params: projectKickoffParams }),
  actionBaseSchema.extend({ type: z.literal('project.mark_complete'), params: projectMarkCompleteParams }),
  actionBaseSchema.extend({ type: z.literal('project.update_status'), params: projectUpdateStatusParams }),
  actionBaseSchema.extend({ type: z.literal('time.self_nudge'), params: timeSelfNudgeParams }),
  actionBaseSchema.extend({ type: z.literal('time.log_entry'), params: timeLogEntryParams }),
  actionBaseSchema.extend({ type: z.literal('email.send_draft'), params: emailSendDraftParams }),
  actionBaseSchema.extend({ type: z.literal('task.create'), params: taskCreateParams }),
  actionBaseSchema.extend({ type: z.literal('event.snooze'), params: eventStateParams }),
  actionBaseSchema.extend({ type: z.literal('event.dismiss'), params: eventStateParams }),
  actionBaseSchema.extend({ type: z.literal('event.mark_done'), params: eventStateParams }),
]);

export type Action = z.infer<typeof actionSchema>;

// ---------- catalog metadata ----------
// One source of truth for: which class of undo, what subject_ref kind it
// targets, and which fields are semantic (hashed) vs cosmetic (ignored)
// for idempotency. Per §2.4 — kept here so the hash function and the UI
// can read the same allowlist.

export type ActionCatalogEntry = {
  type: ActionType;
  reversal_class: ReversalClass;
  // Default mode the action ships in. User can flip Manual ↔ Proposed in
  // settings (§2.3). No Auto.
  default_mode: ActionMode;
  // Field names from `params` that count as semantic for the idempotency
  // key. Everything else is cosmetic and ignored. Empty array = nothing
  // semantic beyond (type, subject_ref) — all params are cosmetic. (Not
  // currently used; included for completeness.)
  semantic_fields: readonly string[];
};

export const actionCatalog: Readonly<Record<ActionType, ActionCatalogEntry>> = {
  'invoice.send': {
    type: 'invoice.send',
    reversal_class: 'no_undo',
    default_mode: 'manual',
    semantic_fields: ['harvest_invoice_id'],
  },
  'invoice.remind': {
    type: 'invoice.remind',
    reversal_class: 'compensating', // "send correction email"
    default_mode: 'proposed',
    semantic_fields: ['recipient', 'invoice_id', 'tone'],
  },
  'invoice.mark_paid_manual': {
    type: 'invoice.mark_paid_manual',
    reversal_class: 'compensating',
    default_mode: 'manual',
    semantic_fields: ['invoice_id', 'amount_cents'],
  },
  'payment.apply': {
    type: 'payment.apply',
    reversal_class: 'compensating', // QBO supports unapply
    default_mode: 'proposed',
    semantic_fields: ['payment_id', 'invoice_id', 'amount_cents'],
  },
  'contract.send_reminder': {
    type: 'contract.send_reminder',
    reversal_class: 'no_undo',
    default_mode: 'proposed',
    semantic_fields: ['signature_request_id', 'recipient'],
  },
  'contract.create_from_template': {
    type: 'contract.create_from_template',
    reversal_class: 'no_undo',
    default_mode: 'manual',
    semantic_fields: ['template_id', 'recipient'],
  },
  'project.kickoff': {
    type: 'project.kickoff',
    reversal_class: 'true_undo',
    default_mode: 'proposed',
    semantic_fields: ['contract_id', 'client_id'],
  },
  'project.mark_complete': {
    type: 'project.mark_complete',
    reversal_class: 'true_undo',
    default_mode: 'manual',
    semantic_fields: ['project_id'],
  },
  'project.update_status': {
    type: 'project.update_status',
    reversal_class: 'true_undo',
    default_mode: 'proposed',
    semantic_fields: ['project_id', 'new_status'],
  },
  'time.self_nudge': {
    type: 'time.self_nudge',
    reversal_class: 'no_undo',
    default_mode: 'proposed',
    semantic_fields: [], // body wording is cosmetic
  },
  'time.log_entry': {
    type: 'time.log_entry',
    reversal_class: 'true_undo',
    default_mode: 'manual',
    semantic_fields: ['harvest_project_id', 'date', 'hours'],
  },
  'email.send_draft': {
    type: 'email.send_draft',
    reversal_class: 'no_undo', // after 30s window; soft-undo handled in queue
    default_mode: 'proposed',
    semantic_fields: ['recipient', 'thread_id'],
  },
  'task.create': {
    type: 'task.create',
    reversal_class: 'true_undo',
    default_mode: 'manual',
    semantic_fields: ['title', 'subject_ref'],
  },
  'event.snooze': {
    type: 'event.snooze',
    reversal_class: 'true_undo',
    default_mode: 'manual',
    semantic_fields: ['event_id'],
  },
  'event.dismiss': {
    type: 'event.dismiss',
    reversal_class: 'true_undo',
    default_mode: 'manual',
    semantic_fields: ['event_id'],
  },
  'event.mark_done': {
    type: 'event.mark_done',
    reversal_class: 'true_undo',
    default_mode: 'manual',
    semantic_fields: ['event_id'],
  },
} as const;
