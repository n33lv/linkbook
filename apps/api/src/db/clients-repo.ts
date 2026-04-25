// Helpers for the clients table that the rest of the app needs.

import { eq, sql } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import type { AppCtx } from '../lib/principal-context.js';

export async function findClientBySource(
  ctx: AppCtx,
  source: string,
  source_id: string,
): Promise<typeof schema.clients.$inferSelect | undefined> {
  // SQLite JSON: source_ids is `text json`. We use json_extract for lookups.
  const rows = ctx.db
    .select()
    .from(schema.clients)
    .where(sql`json_extract(${schema.clients.source_ids}, ${'$.' + source}) = ${source_id}`)
    .all();
  return rows[0];
}

export async function findClientById(
  ctx: AppCtx,
  id: string,
): Promise<typeof schema.clients.$inferSelect | undefined> {
  const rows = ctx.db.select().from(schema.clients).where(eq(schema.clients.id, id)).all();
  return rows[0];
}

export async function upsertClientBySource(
  ctx: AppCtx,
  source: string,
  source_id: string,
  name: string,
): Promise<typeof schema.clients.$inferSelect> {
  const existing = await findClientBySource(ctx, source, source_id);
  if (existing) return existing;
  // Try to merge by name as a heuristic — onboarding should resolve conflicts
  // explicitly (§5.1), but in dev seed mode we accept name-match as identity.
  const byName = ctx.db.select().from(schema.clients).where(eq(schema.clients.name, name)).all();
  if (byName[0]) {
    const merged = { ...byName[0].source_ids, [source]: source_id };
    ctx.db.update(schema.clients).set({ source_ids: merged }).where(eq(schema.clients.id, byName[0].id)).run();
    return { ...byName[0], source_ids: merged };
  }
  const inserted = ctx.db
    .insert(schema.clients)
    .values({
      name,
      source_ids: { [source]: source_id },
      email_domains: [],
    })
    .returning()
    .get();
  return inserted;
}
