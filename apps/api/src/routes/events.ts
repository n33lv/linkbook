import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import { z } from 'zod';

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events', async (req) => {
    const q = z
      .object({ subject_ref: z.string().optional() })
      .parse(req.query);
    const db = app.db;
    if (q.subject_ref) {
      const rows = db
        .select()
        .from(schema.events)
        .where(eq(schema.events.subject_ref, q.subject_ref))
        .orderBy(desc(schema.events.occurred_at))
        .all();
      return { events: rows };
    }
    return { events: db.select().from(schema.events).orderBy(desc(schema.events.occurred_at)).all() };
  });
};
