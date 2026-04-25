import { randomUUID } from 'node:crypto';
import { text, integer } from 'drizzle-orm/sqlite-core';

// SQLite has no native UUID type; we generate in app and store as text.
// Default uses a JS function so each row gets a fresh UUID at insert time.
export const uuidPk = () =>
  text('id').primaryKey().$defaultFn(() => randomUUID());

// SQLite has no native timestamp; store as integer ms (UTC).
// `.$defaultFn(() => new Date())` so callers get a Date in/out.
export const timestamp = (name: string) =>
  integer(name, { mode: 'timestamp_ms' });

// JSON-mode text column with typed shape for select/insert.
// Drizzle parses/stringifies for us.
export const jsonCol = <T>(name: string) =>
  text(name, { mode: 'json' }).$type<T>();
