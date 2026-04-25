import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { createDb } from '@linkbook/db';
import { loadConfig } from './config.js';
import { inboxRoutes } from './routes/inbox.js';
import { actionRoutes } from './routes/actions.js';
import { eventRoutes } from './routes/events.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { integrationRoutes } from './routes/integrations.js';
import { devRoutes } from './routes/dev.js';
import { harvestWebhook } from './routes/webhooks/harvest.js';
import { dropboxsignWebhook } from './routes/webhooks/dropboxsign.js';
import { airtableWebhook } from './routes/webhooks/airtable.js';
import { gmailWebhook } from './routes/webhooks/gmail.js';
import { installMockTransport } from './integrations/_mocks/index.js';

export async function buildApp(overrides?: { dbPath?: string }) {
  const cfg = loadConfig();
  if (overrides?.dbPath) {
    (cfg as { DATABASE_URL: string }).DATABASE_URL = overrides.dbPath;
  }

  const app = Fastify({
    logger:
      cfg.NODE_ENV === 'development'
        ? {
            level: cfg.LOG_LEVEL,
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : { level: cfg.LOG_LEVEL },
  });

  const db = createDb(cfg.DATABASE_URL);

  app.decorate('db', db);
  app.decorate('cfg', cfg);

  // §5.8 rule 2 — every route reads identity through this hook. Today
  // it returns the dev principal; later it'll read a real session.
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    const { currentPrincipal } = await import('./principal.js');
    req.principal = currentPrincipal(req, cfg);
  });

  if (cfg.USE_INTEGRATION_MOCKS) {
    installMockTransport();
    app.log.info('integration mocks installed (USE_INTEGRATION_MOCKS=true)');
  }

  // §2.5 — restart recovery: drain any queued_30s rows whose timer elapsed
  // while the server was down; re-arm timers for the rest.
  const { recoverQueueOnBoot } = await import('./actions/queue.js');
  await recoverQueueOnBoot({ db, cfg, log: app.log });

  await app.register(sensible);
  await app.register(cors, {
    // Dev: only allow the local Vite dev server. Prod: same-origin only
    // (closed by default until we have multi-domain story).
    origin:
      cfg.NODE_ENV === 'development'
        ? ['http://localhost:5173', 'http://127.0.0.1:5173']
        : false,
    credentials: true,
  });

  // Centralised error handler — Zod validation errors return 400 with
  // a structured `issues` field; everything else gets a 500 + request_id
  // and the stack trace stays in logs (never reaches the client).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({
        error: 'invalid_request',
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      });
      return;
    }
    // Fastify's own validation errors (FST_ERR_VALIDATION etc.) carry
    // statusCode + message; pass them through.
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      reply.code(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message ?? 'bad request' });
      return;
    }
    const request_id = randomUUID();
    req.log.error({ err, request_id }, 'unhandled route error');
    reply.code(500).send({ error: 'internal', request_id });
  });

  app.get('/healthz', async () => ({ ok: true }));

  await app.register(inboxRoutes);
  await app.register(actionRoutes);
  await app.register(eventRoutes);
  await app.register(dashboardRoutes);
  await app.register(integrationRoutes);
  await app.register(devRoutes);

  await app.register(harvestWebhook);
  await app.register(dropboxsignWebhook);
  await app.register(airtableWebhook);
  await app.register(gmailWebhook);

  return app;
}

declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyInstance {
    db: ReturnType<typeof createDb>;
    cfg: ReturnType<typeof loadConfig>;
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyRequest {
    principal: import('./principal.js').Principal | null;
  }
}

// boot when invoked directly
const isMain = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isMain) {
  const app = await buildApp();
  try {
    await app.listen({ port: app.cfg.PORT, host: '0.0.0.0' });
    app.log.info(`Linkbook API listening on :${app.cfg.PORT}`);
    app.log.info(
      `Studio: ${app.cfg.STUDIO_NAME} (single-user dev mode as ${app.cfg.DEV_PRINCIPAL_EMAIL})`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown — drain Fastify, clear in-process queue timers,
  // close the SQLite handle. Without this, queued_30s timers never get a
  // chance to register their state (already DB-persisted, so recovery on
  // next boot will re-arm them).
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      const { _clearAllTimers } = await import('./actions/queue.js');
      _clearAllTimers();
      await app.close();
      // close the better-sqlite3 handle if available
      const client = (app.db as unknown as { $client?: { close?: () => void } }).$client;
      try { client?.close?.(); } catch {/**/}
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Don't crash the process on unhandled errors — log them instead.
  // (Fastify's setErrorHandler covers HTTP-path errors; this is for
  // anything else, e.g. agent runtimes.)
  process.on('unhandledRejection', (err) => {
    app.log.error({ err }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaught exception');
  });
}
