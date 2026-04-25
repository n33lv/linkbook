// Apply Drizzle migrations to the configured DATABASE_URL.

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const url = process.env['DATABASE_URL'] ?? 'file:./linkbook.db';
const filename = url.startsWith('file:') ? url.slice('file:'.length) : url;

const sqlite = new Database(filename);
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);

// Resolve drizzle/ relative to this file so we don't depend on cwd.
// __dirname-equivalent for ESM:
const here = dirname(fileURLToPath(import.meta.url));
// from packages/db/dist/migrate.js → ../drizzle
const folder = resolve(here, '..', 'drizzle');

migrate(db, { migrationsFolder: folder });
console.log(`migrations applied → ${filename}`);
sqlite.close();
