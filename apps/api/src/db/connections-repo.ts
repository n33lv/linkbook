import { eq } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import type { Source } from '@linkbook/types';
import type { AppCtx } from '../lib/principal-context.js';

export async function getConnectionForSource(
  ctx: AppCtx,
  source: Source,
): Promise<typeof schema.integration_connections.$inferSelect | undefined> {
  const rows = ctx.db
    .select()
    .from(schema.integration_connections)
    .where(eq(schema.integration_connections.source, source))
    .all();
  return rows[0];
}
