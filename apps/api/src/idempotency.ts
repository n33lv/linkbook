import { createHash } from 'node:crypto';
import {
  actionCatalog,
  type Action,
  type ActionType,
} from '@linkbook/types';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import type { AppCtx } from './lib/principal-context.js';

// §2.4 — deterministic key, hash(type, subject_ref, semantic_payload).
// Per action type, only the fields named in actionCatalog[type].semantic_fields
// participate in the hash.

export function computeIdempotencyKey(
  type: ActionType,
  subject_ref: string,
  params: Record<string, unknown>,
): string {
  const entry = actionCatalog[type];
  const semantic: Record<string, unknown> = {};
  for (const field of entry.semantic_fields) {
    semantic[field] = params[field];
  }
  const canonical = stableStringify({ type, subject_ref, semantic });
  // Full SHA-256 hex (64 chars). The previous 32-char slice doubled up
  // collision risk for no real benefit.
  return createHash('sha256').update(canonical).digest('hex');
}

export function withIdempotencyKey(action: Omit<Action, 'idempotency_key'>): Action {
  const key = computeIdempotencyKey(
    action.type,
    'subject_ref' in action ? (action as { subject_ref: string }).subject_ref : '',
    (action as { params: Record<string, unknown> }).params,
  );
  return { ...action, idempotency_key: key } as Action;
}

// §2.4 — server rejects duplicate keys within 24h with the prior result.
// Returns the existing action row if one is present in the window, else null.
export async function findDuplicateInWindow(
  ctx: AppCtx,
  idempotency_key: string,
  windowMs = 24 * 60 * 60 * 1000,
): Promise<typeof schema.actions.$inferSelect | null> {
  const since = new Date(Date.now() - windowMs);
  const rows = ctx.db
    .select()
    .from(schema.actions)
    .where(
      and(
        eq(schema.actions.idempotency_key, idempotency_key),
        sql`${schema.actions.created_at} >= ${since.getTime()}`,
        // A cancelled/failed/undone action shouldn't block a fresh proposal —
        // user already rejected it (cancelled) or the system needs to retry
        // (failed/undone).
        sql`${schema.actions.status} NOT IN ('cancelled','failed','undone')`,
      ),
    )
    .all();
  return rows[0] ?? null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}
