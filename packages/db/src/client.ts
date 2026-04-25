import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.js';

export type Db = ReturnType<typeof createDb>;

// SQLite doesn't have JSONB, no real timestamp type, no native UUIDs.
// Drizzle's SQLite driver gives us text mode 'json' for JSON columns
// and integer mode 'timestamp_ms' for dates. UUIDs are application-side.
//
// Single-tenant single-user fits SQLite well — concurrent writes serialize,
// which is exactly what we want for the audit log invariants.
export function createDb(url: string) {
  // Drizzle's URL convention: 'file:./path' or just a path.
  const filename = url.startsWith('file:') ? url.slice('file:'.length) : url;
  const sqlite = new Database(filename);
  // WAL mode: durable, fast for our read-heavy workload, doesn't block readers
  // during writes. Foreign-keys: off by default in SQLite, on by spec for us.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  return drizzle(sqlite, { schema });
}
