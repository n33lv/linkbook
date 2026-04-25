// Build an empty SQLite DB and apply migrations to it. One per test file.

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '@linkbook/db/schema';

const here = dirname(fileURLToPath(import.meta.url));
// from apps/api/test/_fixtures/db.ts → packages/db/drizzle
const migrationsFolder = resolve(here, '..', '..', '..', '..', 'packages', 'db', 'drizzle');

export function makeDb(): { db: ReturnType<typeof drizzle<typeof schema>>; close: () => void; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'linkbook-test-'));
  const path = join(dir, 'test.db');
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return {
    db,
    path: `file:${path}`,
    close: () => sqlite.close(),
  };
}

export const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
