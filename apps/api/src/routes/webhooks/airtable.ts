import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ingestEvent } from '../../ingestion.js';

const Body = z.object({
  event: z.object({
    type: z.enum(['record.updated', 'project.status_stale']),
    payload: z.record(z.unknown()),
  }),
});

export const airtableWebhook: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/airtable', async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_payload' });
    const { event } = body.data;
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };

    if (event.type === 'project.status_stale') {
      const p = event.payload as { project_id: string; airtable_record_id: string; days_silent: number };
      await ingestEvent(ctx, {
        source: 'airtable',
        type: 'project.status_stale',
        subject_ref: `project:${p.project_id}`,
        occurred_at: new Date(),
        payload: p,
        dedupe_key: `stale:${p.days_silent}`,
      });
    }
    return { ok: true };
  });
};
