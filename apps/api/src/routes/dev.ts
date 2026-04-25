import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ingestEvent } from '../ingestion.js';
import { eventTypeSchema, sourceSchema } from '@linkbook/types';
import { schema } from '@linkbook/db';
import { eq } from 'drizzle-orm';

// Dev/test routes. NOT mounted in production.

export const devRoutes: FastifyPluginAsync = async (app) => {
  app.post('/dev/ingest', async (req, reply) => {
    const Body = z.object({
      source: sourceSchema,
      type: eventTypeSchema,
      subject_ref: z.string(),
      occurred_at: z.coerce.date().default(() => new Date()),
      payload: z.record(z.unknown()),
      dedupe_key: z.string().default('default'),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_payload', issues: parsed.error.issues });
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };
    return ingestEvent(ctx, parsed.data);
  });

  // Test helper: provision the 5 default integration_connections so action
  // dispatchers can find a connected source. Idempotent.
  app.post('/dev/seed/connections', async () => {
    const sources = ['qbo', 'harvest', 'dropboxsign', 'airtable', 'gmail'] as const;
    for (const src of sources) {
      const existing = app.db
        .select()
        .from(schema.integration_connections)
        .where(eq(schema.integration_connections.source, src))
        .all();
      if (existing.length > 0) continue;
      app.db.insert(schema.integration_connections).values({
        source: src,
        external_account_id: src === 'qbo' ? 'realm_dev' : `${src}_acct`,
        display_name: src.toUpperCase(),
        status: 'connected',
        access_token: 'dev_token',
        metadata:
          src === 'airtable' ? { base_id: 'app_demo', projects_table_id: 'tbl_projects' } : {},
      }).run();
    }
    return { ok: true };
  });

  // Manually trigger a QBO CDC pull (no scheduler in v1).
  app.post('/dev/qbo/cdc', async () => {
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };
    const { runQboCdcPass } = await import('../integrations/qbo/cdc.js');
    return runQboCdcPass(ctx);
  });

  // Inspect mock store (test introspection).
  app.get('/dev/mocks', async () => {
    const { getMockStore } = await import('../integrations/_mocks/index.js');
    const s = getMockStore();
    return {
      sent_emails: s.sent_emails,
      contract_reminders: s.contract_reminders,
      airtable_records: Array.from(s.airtable_records.entries()),
      harvest_projects: Array.from(s.harvest_projects.values()),
      drive_folders: s.drive_folders,
      invoices: Array.from(s.invoices.values()),
      payments: Array.from(s.payments.values()),
    };
  });

  // Reset mock store (between e2e tests).
  app.post('/dev/mocks/reset', async () => {
    const { resetMockStore } = await import('../integrations/_mocks/index.js');
    resetMockStore();
    return { ok: true };
  });

  // Test-only: rewind a queued_30s action's queued_until into the past so
  // the next boot's recovery sweep has work to do. Used by tests that
  // simulate downtime; not mounted in prod (the dev plugin isn't).
  app.post('/dev/queue/rewind', async (req, reply) => {
    const Body = z.object({
      action_id: z.string().uuid(),
      past_seconds: z.number().int().positive().default(5),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'bad_payload', issues: parsed.error.issues });
    app.db
      .update(schema.actions)
      .set({
        queued_until: new Date(Date.now() - parsed.data.past_seconds * 1000),
        updated_at: new Date(),
      })
      .where(eq(schema.actions.id, parsed.data.action_id))
      .run();
    return { ok: true };
  });

  // Inject a failure into the next call to a given key.
  // body: { key: "harvest:POST /v2/projects", status: 500 }
  app.post('/dev/mocks/fail-next', async (req) => {
    const Body = z.object({ key: z.string(), status: z.number().int(), body: z.unknown().optional() });
    const parsed = Body.parse(req.body);
    const { getMockStore } = await import('../integrations/_mocks/index.js');
    getMockStore().failures.next(parsed.key, { status: parsed.status, body: parsed.body });
    return { ok: true };
  });
};
