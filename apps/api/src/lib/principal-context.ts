// Cross-cutting context passed to ingestion / agent / execute pipeline.

import type { Db } from '@linkbook/db';
import type { AppConfig } from '../config.js';

// We accept a minimal logger shape so both pino's `Logger` and Fastify's
// `FastifyBaseLogger` (which lacks `msgPrefix`) satisfy it.
export type AppLogger = {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
};

export type AppCtx = {
  db: Db;
  cfg: AppConfig;
  log: AppLogger;
};
