import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ingestEvent } from '../../ingestion.js';

// Real Gmail uses Pub/Sub push; in dev we accept a clean payload.

const Body = z.object({
  event: z.object({
    type: z.literal('client_reply_awaiting'),
    payload: z.object({
      gmail_thread_id: z.string(),
      client_id: z.string().uuid(),
      last_inbound_at: z.coerce.date(),
      subject: z.string(),
    }),
  }),
});

export const gmailWebhook: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/gmail', async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_payload' });
    const { event } = body.data;
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };
    await ingestEvent(ctx, {
      source: 'gmail',
      type: 'email.client_reply_awaiting_response_3d',
      subject_ref: `thread:${event.payload.gmail_thread_id}`,
      occurred_at: new Date(),
      payload: event.payload,
      dedupe_key: '3d',
    });
    return { ok: true };
  });
};
