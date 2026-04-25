import type { Config } from 'drizzle-kit';

export default {
  // drizzle-kit's CJS tsx loader can't resolve `.js` import specifiers in
  // .ts source. We run it against the built JS in dist/ instead — same
  // schema, just compiled. Run `pnpm --filter @linkbook/db build` first.
  schema: './dist/schema/index.js',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'file:./linkbook.db',
  },
  strict: true,
  verbose: true,
} satisfies Config;
