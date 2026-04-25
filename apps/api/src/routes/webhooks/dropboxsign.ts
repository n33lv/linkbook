import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ingestEvent } from '../../ingestion.js';
import { upsertClientBySource } from '../../db/clients-repo.js';
import { getMockStore } from '../../integrations/_mocks/index.js';

// Mock-friendly Dropbox Sign webhook receiver.
// Real provider sends form-data with a signed JSON envelope; for v1 dev
// we accept clean JSON.

const Body = z.object({
  event: z.object({
    type: z.enum(['signature_request_sent', 'signature_request_signed', 'signature_request_declined']),
    signature_request_id: z.string(),
    title: z.string(),
    recipient: z.string().email(),
    client_name: z.string().optional(),
  }),
});

export const dropboxsignWebhook: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/dropboxsign', async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_payload', issues: body.error.issues });
    const { event } = body.data;

    const ctx = { db: app.db, cfg: app.cfg, log: app.log };

    // Reflect into the integration mock store so downstream code can read.
    const store = getMockStore();
    if (event.type === 'signature_request_sent') {
      store.contracts.set(event.signature_request_id, {
        id: event.signature_request_id,
        title: event.title,
        recipient: event.recipient,
        status: 'sent',
        sent_at: new Date().toISOString(),
        signed_at: null,
      });
    } else {
      const c = store.contracts.get(event.signature_request_id);
      if (c) {
        c.status = event.type === 'signature_request_signed' ? 'signed' : 'declined';
        if (event.type === 'signature_request_signed') c.signed_at = new Date().toISOString();
      }
    }

    // Best-effort client identification by counterparty name.
    let client_id: string | null = null;
    if (event.client_name) {
      const c = await upsertClientBySource(ctx, 'dropboxsign', event.signature_request_id, event.client_name);
      client_id = c.id;
    }

    if (event.type === 'signature_request_signed') {
      await ingestEvent(ctx, {
        source: 'dropboxsign',
        type: 'contract.signed',
        subject_ref: `contract:${event.signature_request_id}`,
        occurred_at: new Date(),
        payload: {
          signature_request_id: event.signature_request_id,
          title: event.title,
          client_id,
          sent_at: new Date(),
          signed_at: new Date(),
        },
        dedupe_key: 'signed',
      });
    } else if (event.type === 'signature_request_sent') {
      // we'll surface contract.sent_unsigned_5d later via a sweep; for
      // now just log it so audits see provenance.
    } else if (event.type === 'signature_request_declined') {
      await ingestEvent(ctx, {
        source: 'dropboxsign',
        type: 'contract.declined',
        subject_ref: `contract:${event.signature_request_id}`,
        occurred_at: new Date(),
        payload: {
          signature_request_id: event.signature_request_id,
          title: event.title,
          client_id,
          sent_at: new Date(),
        },
        dedupe_key: 'declined',
      });
    }

    return { ok: true };
  });
};
