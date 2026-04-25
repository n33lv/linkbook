import type { ActionRow } from '@linkbook/db/schema';
import type { AppCtx } from '../lib/principal-context.js';
import { findActionById, listLegs, setActionStatus, setLegStatus, writeAudit } from '../db/actions-repo.js';
import { getConnectionForSource } from '../db/connections-repo.js';
import { autoResolveEventsForSubject } from '../db/events-repo.js';
import { createQboClient } from '../integrations/qbo/client.js';
import { createHarvestClient } from '../integrations/harvest/client.js';
import { createDropboxsignClient } from '../integrations/dropboxsign/client.js';
import { createAirtableClient } from '../integrations/airtable/client.js';
import { createGmailClient } from '../integrations/gmail/client.js';

// §2.4 / §5.3 — execute an approved action.
// Phases:
//   1. Re-fetch subject state (hallucination guard).
//   2. Dispatch per type.
//   3. Persist audit_event.
//   4. Update status; auto-resolve originating event if appropriate.

export type ExecuteResult =
  | { ok: true; status: 'succeeded'; undo_token: string | null }
  | { ok: true; status: 'cancelled'; reason: string }
  | { ok: false; error: string; http_status: number | null };

// Caller has already flipped status → 'executing' (the queue path does this
// via CAS to win the race against undo). Skip the redundant flip in
// executeAction so we don't clobber a concurrent terminal state.
export type ExecuteOptions = { alreadyExecuting?: boolean };

const MAX_BODY_LEN = 4_000;

// §2.6 — every dispatch returns the request payload + integration response
// so the audit log can record both. Captured on success and failure.
type DispatchTrace = {
  request: unknown;
  response: unknown;
  http_status: number | null;
};

// §2.3 — actions that change source-system state, such that any pending
// event for the same subject_ref is no longer relevant.
const SOURCE_MUTATING = new Set([
  'payment.apply',
  'invoice.mark_paid_manual',
  'project.update_status',
  'project.kickoff',
  'project.mark_complete',
]);

// Recursive redaction: secret-shaped keys at any depth get masked.
// Bounded depth + string length to keep audit rows finite.
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated:depth]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'string')
    return value.length > MAX_BODY_LEN ? value.slice(0, MAX_BODY_LEN) + '…' : value;
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/auth|secret|token|password|key|cookie|bearer/i.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export async function executeAction(
  ctx: AppCtx,
  action: ActionRow,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  ctx.log.info({ action_id: action.id, type: action.type }, 'executing action');

  // 1. Re-fetch subject state where applicable. (§5.3 hallucination guard.)
  // For invoice.remind: re-fetch the invoice via the QBO integration
  // (real or mock). If status changed to paid, cancel + auto-resolve.
  if (action.type === 'invoice.remind') {
    const params = action.params as { invoice_id: string };
    const stillOverdue = await reverifyInvoiceStillOverdue(ctx, params.invoice_id);
    if (!stillOverdue.ok) {
      await setActionStatus(ctx, action.id, 'cancelled');
      await writeAudit(ctx, {
        actor: 'system',
        action_id: action.id,
        originating_event_id: action.originating_event_id,
        kind: 'action.cancelled',
        idempotency_key: action.idempotency_key,
        subject_ref: action.subject_ref,
        note: `hallucination guard: ${stillOverdue.reason}`,
      });
      await autoResolveEventsForSubject(ctx, action.subject_ref, stillOverdue.reason);
      return { ok: true, status: 'cancelled', reason: stillOverdue.reason };
    }
  }

  // 2. Dispatch per type.
  if (!options.alreadyExecuting) {
    await setActionStatus(ctx, action.id, 'executing', { executed_at: new Date() });
    await writeAudit(ctx, {
      actor: 'system',
      action_id: action.id,
      originating_event_id: action.originating_event_id,
      kind: 'action.executing',
      idempotency_key: action.idempotency_key,
      subject_ref: action.subject_ref,
    });
  }

  try {
    let undoToken: string | null = null;
    let trace: DispatchTrace = { request: null, response: null, http_status: null };
    switch (action.type) {
      case 'invoice.remind':
        trace = await dispatchInvoiceRemind(ctx, action);
        undoToken = `compensating:${action.id}`;
        break;
      case 'invoice.send':
        trace = await dispatchInvoiceSend(ctx, action);
        break;
      case 'invoice.mark_paid_manual':
        trace = await dispatchInvoiceMarkPaid(ctx, action);
        undoToken = `compensating:${action.id}`;
        break;
      case 'payment.apply':
        trace = await dispatchPaymentApply(ctx, action);
        undoToken = `compensating:${action.id}`;
        break;
      case 'contract.send_reminder':
        trace = await dispatchContractReminder(ctx, action);
        break;
      case 'contract.create_from_template':
        trace = await dispatchContractCreate(ctx, action);
        break;
      case 'project.kickoff':
        await dispatchKickoff(ctx, action);
        undoToken = `true_undo:${action.id}`;
        break;
      case 'project.update_status':
        trace = await dispatchProjectUpdate(ctx, action);
        undoToken = `true_undo:${action.id}`;
        break;
      case 'time.self_nudge':
        trace = await dispatchSelfNudge(ctx, action);
        break;
      case 'time.log_entry':
        trace = await dispatchLogTime(ctx, action);
        undoToken = `true_undo:${action.id}`;
        break;
      case 'email.send_draft':
        trace = await dispatchEmailSend(ctx, action);
        break;
      case 'task.create':
      case 'event.snooze':
      case 'event.dismiss':
      case 'event.mark_done':
      case 'project.mark_complete':
        // Internal-only or out of scope for v1 dispatch; treat as success.
        break;
      default: {
        const _exhaustive: never = action.type as never;
        void _exhaustive;
        throw new Error(`unhandled action type ${action.type}`);
      }
    }

    await setActionStatus(ctx, action.id, 'succeeded', { undo_token: undoToken });
    await writeAudit(ctx, {
      actor: 'system',
      action_id: action.id,
      originating_event_id: action.originating_event_id,
      kind: 'action.succeeded',
      idempotency_key: action.idempotency_key,
      subject_ref: action.subject_ref,
      // §2.6 — request/response captured on success too.
      request: trace.request as Record<string, unknown> | null,
      response: redact(trace.response) as Record<string, unknown> | null,
      http_status: trace.http_status !== null ? String(trace.http_status) : null,
    });

    // §2.3 auto-resolve: ONLY when the action mutated the source system
    // such that the originating event is no longer applicable. Sending a
    // reminder doesn't change source state — the invoice is still overdue
    // until paid. Restrict to actions that mutate the underlying record.
    if (action.originating_event_id && SOURCE_MUTATING.has(action.type)) {
      await autoResolveEventsForSubject(ctx, action.subject_ref, `action ${action.type} succeeded`);
    }

    return { ok: true, status: 'succeeded', undo_token: undoToken };
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number; body?: unknown };
    const errMsg = e.message ?? String(err);
    const httpStatus = e.status ?? null;
    await setActionStatus(ctx, action.id, 'failed');
    await writeAudit(ctx, {
      actor: 'system',
      action_id: action.id,
      originating_event_id: action.originating_event_id,
      kind: 'action.failed',
      idempotency_key: action.idempotency_key,
      subject_ref: action.subject_ref,
      response: redact(e.body) as Record<string, unknown>,
      http_status: httpStatus !== null ? String(httpStatus) : null,
      note: errMsg,
    });
    // Emit an action.failed event so it surfaces in the Inbox (§2.4).
    const { ingestEvent } = await import('../ingestion.js');
    await ingestEvent(ctx, {
      source: 'linkbook',
      type: 'action.failed',
      subject_ref: 'action:' + action.id,
      occurred_at: new Date(),
      payload: { action_id: action.id, action_type: action.type, error: errMsg, http_status: httpStatus },
      dedupe_key: `${action.id}:fail`,
    });
    return { ok: false, error: errMsg, http_status: httpStatus };
  }
}

// --- per-type dispatchers (§2.6: each returns request + response trace) ---

async function dispatchInvoiceRemind(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'gmail');
  if (!conn) throw new Error('gmail integration not connected');
  const client = createGmailClient(ctx.cfg, conn);
  const params = action.params as { recipient: string; cc: string[]; subject: string; body: string };
  const req = { to: params.recipient, cc: params.cc, subject: params.subject, thread_id: null };
  const resp = await client.send({ ...req, body: params.body });
  return { request: req, response: resp, http_status: 200 };
}

async function dispatchInvoiceSend(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'harvest');
  if (!conn) throw new Error('harvest integration not connected');
  const client = createHarvestClient(ctx.cfg, conn);
  const params = action.params as { harvest_invoice_id: string };
  const resp = await client.sendInvoice(params.harvest_invoice_id);
  return { request: params, response: resp, http_status: 201 };
}

async function dispatchInvoiceMarkPaid(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'qbo');
  if (!conn) throw new Error('qbo integration not connected');
  const client = createQboClient(ctx.cfg, conn);
  const params = action.params as { invoice_id: string };
  const req = { invoice_id: params.invoice_id, mark: 'paid' as const };
  const resp = await client.updateInvoice(req);
  return { request: req, response: resp, http_status: 200 };
}

async function dispatchPaymentApply(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'qbo');
  if (!conn) throw new Error('qbo integration not connected');
  const client = createQboClient(ctx.cfg, conn);
  const params = action.params as { payment_id: string; invoice_id: string; amount_cents: number };
  const resp = await client.applyPayment(params);
  return { request: params, response: resp, http_status: 200 };
}

async function dispatchContractReminder(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'dropboxsign');
  if (!conn) throw new Error('dropbox sign not connected');
  const client = createDropboxsignClient(ctx.cfg, conn);
  const params = action.params as { signature_request_id: string };
  const resp = await client.sendReminder(params.signature_request_id);
  return { request: params, response: resp, http_status: 200 };
}

async function dispatchContractCreate(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'dropboxsign');
  if (!conn) throw new Error('dropbox sign not connected');
  const client = createDropboxsignClient(ctx.cfg, conn);
  const params = action.params as { template_id: string; recipient: string };
  const req = { ...params, title: 'New Agreement' };
  const resp = await client.sendFromTemplate(req);
  return { request: req, response: resp, http_status: 201 };
}

async function dispatchKickoff(ctx: AppCtx, action: ActionRow): Promise<void> {
  const legs = await listLegs(ctx, action.id);
  for (const leg of legs) {
    if (leg.status === 'succeeded') continue; // resume from failed leg (§2.4)

    // §2.5 — gmail legs of a composite must respect the 30s soft-undo
    // window. Mark the leg done and spawn a separate queueable
    // email.send_draft action.
    if (leg.target === 'gmail:draft_welcome') {
      await spawnEmailLegAsQueuedAction(ctx, action, leg);
      await setLegStatus(ctx, leg.id, 'succeeded', { executed_at: new Date() });
      continue;
    }

    await setLegStatus(ctx, leg.id, 'executing');
    try {
      const trace = await runLeg(ctx, leg.target, leg.params);
      await setLegStatus(ctx, leg.id, 'succeeded', { executed_at: new Date() });
      // Per-leg audit row (§2.6).
      await writeAudit(ctx, {
        actor: 'system',
        action_id: action.id,
        kind: 'leg.succeeded',
        idempotency_key: leg.idempotency_key,
        subject_ref: action.subject_ref,
        request: trace.request as Record<string, unknown> | null,
        response: redact(trace.response) as Record<string, unknown> | null,
        http_status: trace.http_status !== null ? String(trace.http_status) : null,
        note: leg.target,
      });
    } catch (err) {
      const e = err as { message?: string; status?: number; body?: unknown };
      await setLegStatus(ctx, leg.id, 'failed', { error: e.message ?? String(err) });
      await writeAudit(ctx, {
        actor: 'system',
        action_id: action.id,
        kind: 'leg.failed',
        idempotency_key: leg.idempotency_key,
        subject_ref: action.subject_ref,
        response: redact(e.body) as Record<string, unknown> | null,
        http_status: e.status !== undefined ? String(e.status) : null,
        note: `${leg.target}: ${e.message ?? err}`,
      });
      throw err;
    }
  }
}

async function spawnEmailLegAsQueuedAction(
  ctx: AppCtx,
  parent: ActionRow,
  leg: { target: string; params: Record<string, unknown>; idempotency_key: string },
): Promise<void> {
  const { schema } = await import('@linkbook/db');
  const p = leg.params as { recipient: string; subject: string; body: string; thread_id: string | null };
  const inserted = ctx.db
    .insert(schema.actions)
    .values({
      type: 'email.send_draft',
      params: {
        recipient: p.recipient,
        cc: [],
        subject: p.subject,
        body: p.body,
        thread_id: p.thread_id,
      },
      mode: 'proposed',
      drafted_by: parent.drafted_by,
      status: 'drafted',
      reversal_class: 'no_undo',
      idempotency_key: leg.idempotency_key,
      preview: p.body,
      originating_event_id: parent.originating_event_id,
      subject_ref: parent.subject_ref,
    })
    .returning()
    .get();
  const { enqueueSendDelay } = await import('./queue.js');
  await enqueueSendDelay(ctx, inserted.id);
}

async function getMockStoreLazy() {
  const { getMockStore } = await import('../integrations/_mocks/index.js');
  return getMockStore();
}

async function runLeg(
  ctx: AppCtx,
  target: string,
  params: Record<string, unknown>,
): Promise<DispatchTrace> {
  if (target === 'harvest:create_project') {
    const conn = await getConnectionForSource(ctx, 'harvest');
    if (!conn) throw new Error('harvest not connected');
    const client = createHarvestClient(ctx.cfg, conn);
    const resp = await client.createProject(params as { name: string; client_id: string; budget_hours: number });
    return { request: params, response: resp, http_status: 201 };
  }
  if (target === 'airtable:insert_record') {
    const conn = await getConnectionForSource(ctx, 'airtable');
    if (!conn) throw new Error('airtable not connected');
    const client = createAirtableClient(ctx.cfg, conn);
    const meta = (conn.metadata as { base_id?: string; projects_table_id?: string }) ?? {};
    const baseId = meta.base_id ?? 'app_demo';
    const tableId = meta.projects_table_id ?? 'tbl_projects';
    const fields = (params as { fields: Record<string, unknown> }).fields;
    const resp = await client.createRecords(baseId, tableId, [{ fields }]);
    return { request: { baseId, tableId, fields }, response: resp, http_status: 200 };
  }
  if (target === 'drive:create_folder') {
    const store = await getMockStoreLazy();
    const path = (params as { path: string }).path;
    store.drive_folders.push({ path, created_at: new Date().toISOString() });
    return { request: { path }, response: { created: true }, http_status: 200 };
  }
  if (target === 'gmail:draft_welcome') {
    const conn = await getConnectionForSource(ctx, 'gmail');
    if (!conn) throw new Error('gmail not connected');
    const client = createGmailClient(ctx.cfg, conn);
    const p = params as { recipient: string; subject: string; body: string; thread_id: string | null };
    const resp = await client.send({ to: p.recipient, subject: p.subject, body: p.body, thread_id: p.thread_id });
    return { request: { to: p.recipient, subject: p.subject, thread_id: p.thread_id }, response: resp, http_status: 200 };
  }
  throw new Error(`unhandled leg target: ${target}`);
}

async function dispatchProjectUpdate(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'airtable');
  if (!conn) throw new Error('airtable not connected');
  const client = createAirtableClient(ctx.cfg, conn);
  const meta = (conn.metadata as { base_id?: string; projects_table_id?: string }) ?? {};
  const baseId = meta.base_id ?? 'app_demo';
  const tableId = meta.projects_table_id ?? 'tbl_projects';
  const params = action.params as { airtable_record_id: string; new_status: string };
  const resp = await client.updateRecord(baseId, tableId, params.airtable_record_id, { Status: params.new_status });
  return { request: { ...params, baseId, tableId }, response: resp, http_status: 200 };
}

async function dispatchSelfNudge(_ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const store = await getMockStoreLazy();
  const params = action.params as { message: string };
  store.sent_emails.push({
    to: 'slack:self',
    cc: [],
    subject: 'Linkbook · self-nudge',
    body: params.message,
    thread_id: null,
    at: new Date().toISOString(),
  });
  return { request: params, response: { delivered: 'slack-mock' }, http_status: 200 };
}

async function dispatchLogTime(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'harvest');
  if (!conn) throw new Error('harvest not connected');
  const client = createHarvestClient(ctx.cfg, conn);
  const params = action.params as {
    harvest_project_id: string;
    date: string;
    hours: number;
    notes: string | null;
  };
  const req = {
    user_id: 'me',
    project_id: params.harvest_project_id,
    date: params.date,
    hours: params.hours,
    notes: params.notes,
  };
  const resp = await client.logTimeEntry(req);
  return { request: req, response: resp, http_status: 201 };
}

async function dispatchEmailSend(ctx: AppCtx, action: ActionRow): Promise<DispatchTrace> {
  const conn = await getConnectionForSource(ctx, 'gmail');
  if (!conn) throw new Error('gmail not connected');
  const client = createGmailClient(ctx.cfg, conn);
  const params = action.params as {
    recipient: string;
    cc: string[];
    subject: string;
    body: string;
    thread_id: string | null;
  };
  const req = { to: params.recipient, cc: params.cc, subject: params.subject, thread_id: params.thread_id };
  const resp = await client.send({ ...req, body: params.body });
  return { request: req, response: resp, http_status: 200 };
}

// Resolve an action by id and execute. Used by the approval route.
export async function approveAndExecute(ctx: AppCtx, action_id: string): Promise<ExecuteResult> {
  const action = await findActionById(ctx, action_id);
  if (!action) return { ok: false, error: 'action not found', http_status: null };
  return executeAction(ctx, action);
}

// §5.3 — hallucination guard. Single-invoice GET against QBO instead of a
// full CDC sweep (a full CDC per reminder would burn the rate budget at
// scale, see §4.1's 60% headroom).
// On any error or missing invoice, we treat the call as "still overdue" —
// the action will run; the integration call will surface any real issue.
async function reverifyInvoiceStillOverdue(
  ctx: AppCtx,
  invoice_id: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const conn = await getConnectionForSource(ctx, 'qbo');
    if (!conn) return { ok: true }; // QBO not connected, fall through
    const client = createQboClient(ctx.cfg, conn);
    const inv = await client.getInvoice(invoice_id);
    if (!inv) return { ok: true };
    if (inv.status === 'paid') return { ok: false, reason: 'invoice paid externally' };
    if (inv.status === 'voided') return { ok: false, reason: 'invoice voided' };
  } catch (err) {
    ctx.log.warn({ err, invoice_id }, 'reverifyInvoiceStillOverdue: QBO call failed; proceeding');
  }
  return { ok: true };
}
