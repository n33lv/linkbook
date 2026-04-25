import type { FastifyPluginAsync } from 'fastify';
import { schema } from '@linkbook/db';

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/integrations', async () => {
    const db = app.db;
    const connections = db.select().from(schema.integration_connections).all();
    return { connections, mocks: app.cfg.USE_INTEGRATION_MOCKS };
  });

  // Dev-only: sync probe for the Harvest→QBO check (§4.1).
  app.post('/integrations/harvest_qbo/probe', async () => {
    if (!app.cfg.USE_INTEGRATION_MOCKS) {
      return { ok: false, reason: 'real-mode probe not implemented yet' };
    }
    // In mock mode, the probe always succeeds in <2s.
    return { ok: true, propagated_in_seconds: 2 };
  });
};
