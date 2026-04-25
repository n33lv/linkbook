import type { ReversalClass } from '@linkbook/types';
import type { AppCtx } from '../lib/principal-context.js';
import { findActionById, setActionStatus, writeAudit } from '../db/actions-repo.js';
import { cancelSendDelay } from './queue.js';
import { getConnectionForSource } from '../db/connections-repo.js';
import { createQboClient } from '../integrations/qbo/client.js';
import { createAirtableClient } from '../integrations/airtable/client.js';

// §2.5 — three reversal classes:
//   - true_undo: delete the write (Airtable status, task, time entry).
//   - compensating: a follow-up action that semantically reverses
//     (send correction email; QBO unapply payment).
//   - no_undo: button greyed; double-confirm at create time.
//
// Plus the "queued_30s → cancel timer" cancel path which precedes any class.

export type UndoResult =
  | { ok: true; method: 'cancel_queued' | 'true_undo' | 'compensating' }
  | { ok: false; reason: 'no_undo' | 'past_window' | 'not_found' | 'integration_error'; detail: string };

export async function undoAction(ctx: AppCtx, action_id: string): Promise<UndoResult> {
  const a = await findActionById(ctx, action_id);
  if (!a) return { ok: false, reason: 'not_found', detail: 'action not found' };

  // 1. queued_30s → cancel the timer.
  if (a.status === 'queued_30s') {
    const cancelled = await cancelSendDelay(ctx, action_id);
    if (cancelled) return { ok: true, method: 'cancel_queued' };
  }

  if (a.status !== 'succeeded') {
    return { ok: false, reason: 'past_window', detail: `cannot undo from status ${a.status}` };
  }

  // §2.5 — 24h compensating-undo window for everything reversible.
  if (a.executed_at) {
    const ageMs = Date.now() - a.executed_at.getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      return { ok: false, reason: 'past_window', detail: 'beyond 24h undo window' };
    }
  }

  const cls = a.reversal_class as ReversalClass;
  if (cls === 'no_undo') {
    return { ok: false, reason: 'no_undo', detail: 'action declared no_undo at create time' };
  }

  if (cls === 'true_undo') {
    try {
      await applyTrueUndo(ctx, a);
      await setActionStatus(ctx, action_id, 'undone');
      await writeAudit(ctx, {
        actor: 'user',
        action_id,
        kind: 'action.undone',
        idempotency_key: a.idempotency_key,
        subject_ref: a.subject_ref,
        note: 'true_undo',
      });
      return { ok: true, method: 'true_undo' };
    } catch (err) {
      const e = err as { message?: string };
      return { ok: false, reason: 'integration_error', detail: e.message ?? String(err) };
    }
  }

  if (cls === 'compensating') {
    try {
      await applyCompensating(ctx, a);
      await setActionStatus(ctx, action_id, 'undone');
      await writeAudit(ctx, {
        actor: 'user',
        action_id,
        kind: 'action.undone',
        idempotency_key: a.idempotency_key,
        subject_ref: a.subject_ref,
        note: 'compensating action enqueued',
      });
      return { ok: true, method: 'compensating' };
    } catch (err) {
      const e = err as { message?: string };
      return { ok: false, reason: 'integration_error', detail: e.message ?? String(err) };
    }
  }

  return { ok: false, reason: 'integration_error', detail: 'unknown reversal class' };
}

async function applyTrueUndo(
  ctx: AppCtx,
  a: NonNullable<Awaited<ReturnType<typeof findActionById>>>,
): Promise<void> {
  if (a.type === 'project.update_status') {
    // Restore prior status — for the v1 mock we just write 'Undone'.
    const conn = await getConnectionForSource(ctx, 'airtable');
    if (!conn) throw new Error('airtable not connected');
    const client = createAirtableClient(ctx.cfg, conn);
    const meta = (conn.metadata as { base_id?: string; projects_table_id?: string }) ?? {};
    const baseId = meta.base_id ?? 'app_demo';
    const tableId = meta.projects_table_id ?? 'tbl_projects';
    const params = a.params as { airtable_record_id: string };
    await client.updateRecord(baseId, tableId, params.airtable_record_id, { Status: 'Undone' });
    return;
  }
  if (a.type === 'task.create' || a.type === 'time.log_entry') {
    // Best-effort: mocks don't support delete here. We mark it on the audit log.
    return;
  }
  throw new Error(`true_undo not implemented for ${a.type}`);
}

async function applyCompensating(
  ctx: AppCtx,
  a: NonNullable<Awaited<ReturnType<typeof findActionById>>>,
): Promise<void> {
  if (a.type === 'payment.apply') {
    const conn = await getConnectionForSource(ctx, 'qbo');
    if (!conn) throw new Error('qbo not connected');
    const client = createQboClient(ctx.cfg, conn);
    const params = a.params as { payment_id: string; invoice_id: string };
    // QBO supports unapply via update; in mock we just mark the invoice unpaid.
    await client.updateInvoice({ invoice_id: params.invoice_id, mark: 'voided' });
    return;
  }
  if (a.type === 'invoice.remind') {
    // Compensating: a "correction email" template would be drafted.
    // For v1 we just record an audit entry; UI can drive the manual flow.
    return;
  }
  throw new Error(`compensating not implemented for ${a.type}`);
}
