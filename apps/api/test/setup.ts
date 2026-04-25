// Vitest global setup. Runs once per test process before each file.
//
// We deliberately do not preload .env here — tests load their own env
// per file (see _fixtures/test-env.ts). This keeps unit tests free of
// any process-global config.

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
