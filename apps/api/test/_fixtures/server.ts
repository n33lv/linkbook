// Boot the API as a child process for integration/e2e tests. Each test
// file gets a fresh SQLite tempfile + a fresh port. The build artifact
// (dist/server.js) must exist; CI calls `pnpm build` before tests.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');

export type TestServer = {
  base: string;
  proc: ChildProcess;
  dbPath: string;
  stop: () => Promise<void>;
};

let nextPort = 4100;

export type StartOptions = {
  /** Override the 30s send-delay for tests that exercise the queue fire path. */
  send_delay_ms?: number;
};

export async function startServer(opts: StartOptions = {}): Promise<TestServer> {
  const port = nextPort++;
  const dir = mkdtempSync(join(tmpdir(), 'lb-e2e-'));
  const dbPath = join(dir, 'test.db');
  const dbUrl = `file:${dbPath}`;

  // Apply migrations first via the dist migrate.js
  const migrateRes = await runOnce('node', [join(repoRoot, 'packages', 'db', 'dist', 'migrate.js')], {
    DATABASE_URL: dbUrl,
  });
  if (migrateRes.code !== 0) throw new Error(`migrate failed: ${migrateRes.stderr}`);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PORT: String(port),
    DATABASE_URL: dbUrl,
    USE_INTEGRATION_MOCKS: 'true',
    DEV_PRINCIPAL_EMAIL: 'neel@flightdesign.co',
    DEV_PRINCIPAL_NAME: 'Neel',
    STUDIO_NAME: 'Flight Design Co.',
    STUDIO_FISCAL_YEAR_START: '01-01',
    STUDIO_BILLABLE_TARGET_PCT: '70',
    STUDIO_LOADED_COST_RATE: '85',
    LLM_DAILY_KILL_SWITCH_USD: '20',
    QBO_ENVIRONMENT: 'sandbox',
  };
  if (opts.send_delay_ms !== undefined) env['SEND_DELAY_MS'] = String(opts.send_delay_ms);

  const proc = spawn('node', [join(apiRoot, 'dist', 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const base = `http://127.0.0.1:${port}`;

  // wait for /healthz
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    proc,
    dbPath,
    stop: () =>
      new Promise<void>((res) => {
        proc.once('exit', () => res());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          res();
        }, 1500);
      }),
  };
}

function runOnce(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolveP({ code: code ?? 0, stdout, stderr }));
  });
}

export async function api<T>(server: TestServer, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> ?? {}) };
  let body = init?.body;
  if (init?.json !== undefined) {
    body = JSON.stringify(init.json);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${server.base}${path}`, {
    ...init,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const post = <T>(server: TestServer, path: string, body?: unknown) =>
  api<T>(server, path, body !== undefined ? { method: 'POST', json: body } : { method: 'POST' });

// Boot a fresh server against an existing DB file (skips migrations).
export async function startServerOnExistingDb(
  dbPath: string,
  opts: StartOptions = {},
): Promise<TestServer> {
  const port = nextPort++;
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PORT: String(port),
    DATABASE_URL: `file:${dbPath}`,
    USE_INTEGRATION_MOCKS: 'true',
    DEV_PRINCIPAL_EMAIL: 'neel@flightdesign.co',
    DEV_PRINCIPAL_NAME: 'Neel',
    STUDIO_NAME: 'Flight Design Co.',
    STUDIO_FISCAL_YEAR_START: '01-01',
    STUDIO_BILLABLE_TARGET_PCT: '70',
    STUDIO_LOADED_COST_RATE: '85',
    LLM_DAILY_KILL_SWITCH_USD: '20',
    QBO_ENVIRONMENT: 'sandbox',
  };
  if (opts.send_delay_ms !== undefined) env['SEND_DELAY_MS'] = String(opts.send_delay_ms);
  const proc = spawn('node', [join(apiRoot, 'dist', 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {/* not yet */}
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    proc,
    dbPath,
    stop: () =>
      new Promise<void>((res) => {
        proc.once('exit', () => res());
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); res(); }, 1500);
      }),
  };
}
