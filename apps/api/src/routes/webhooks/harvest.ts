import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ingestEvent } from '../../ingestion.js';

const Body = z.object({
  event: z.object({
    type: z.enum(['invoice.draft_ready', 'time_entry.created', 'project.budget_threshold']),
    payload: z.record(z.unknown()),
  }),
});

export const harvestWebhook: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/harvest', async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_payload' });
    const { event } = body.data;
    const ctx = { db: app.db, cfg: app.cfg, log: app.log };

    if (event.type === 'invoice.draft_ready') {
      const p = event.payload as { harvest_invoice_id: string; client_id: string; amount_cents: number };
      await ingestEvent(ctx, {
        source: 'harvest',
        type: 'invoice.draft_ready_to_send',
        subject_ref: `invoice:${p.harvest_invoice_id}`,
        occurred_at: new Date(),
        payload: {
          harvest_invoice_id: p.harvest_invoice_id,
          client_id: p.client_id,
          amount_cents: p.amount_cents,
          drafted_at: new Date(),
        },
        dedupe_key: 'ready',
      });
    } else if (event.type === 'project.budget_threshold') {
      const p = event.payload as {
        project_id: string;
        harvest_project_id: string;
        hours_used: number;
        hours_budgeted: number;
        threshold: 80 | 100 | 120;
      };
      const t = p.threshold;
      const type = t === 80 ? 'time.budget_threshold_80' : t === 100 ? 'time.budget_threshold_100' : 'time.budget_threshold_120';
      await ingestEvent(ctx, {
        source: 'harvest',
        type,
        subject_ref: `project:${p.project_id}`,
        occurred_at: new Date(),
        payload: {
          project_id: p.project_id,
          harvest_project_id: p.harvest_project_id,
          hours_used: p.hours_used,
          hours_budgeted: p.hours_budgeted,
          pct: p.hours_budgeted === 0 ? 0 : p.hours_used / p.hours_budgeted,
        },
        dedupe_key: `t${t}`,
      });
    }
    return { ok: true };
  });
};
