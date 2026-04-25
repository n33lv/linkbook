import 'dotenv/config';
import { z } from 'zod';

// Validate env at boot. Anything missing should fail fast with a readable
// message — much better than `undefined.startsWith` at 3am.

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // sqlite path (file:./...) or absolute file path. Real URL validation
  // is too strict — sqlite uses a "file:" prefix that's not strictly URL-shaped.
  DATABASE_URL: z.string().min(1),

  // Toggle integration mocks (v1 dev). Off → real third-party APIs.
  USE_INTEGRATION_MOCKS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // single-user dev shim (§5.5)
  DEV_PRINCIPAL_EMAIL: z.string().email(),
  DEV_PRINCIPAL_NAME: z.string().min(1),

  // studio config (§3.5)
  STUDIO_NAME: z.string().min(1),
  STUDIO_FISCAL_YEAR_START: z.string().regex(/^\d{2}-\d{2}$/),
  STUDIO_BILLABLE_TARGET_PCT: z.coerce.number().min(0).max(100),
  STUDIO_LOADED_COST_RATE: z.coerce.number().nonnegative(),

  // Agents (§5.3)
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENTSPAN_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  AGENTSPAN_API_KEY: z.string().optional(),

  LLM_DAILY_KILL_SWITCH_USD: z.coerce.number().positive().default(20),

  // Ranking weights (§1.3) — overrides allowed; defaults match the
  // doc's starting values.
  RANK_W_MONEY: z.coerce.number().nonnegative().default(0.40),
  RANK_W_URGENCY: z.coerce.number().nonnegative().default(0.25),
  RANK_W_CLIENT_TIER: z.coerce.number().nonnegative().default(0.15),
  RANK_W_BLOCKING: z.coerce.number().nonnegative().default(0.10),
  RANK_W_NEGLECT: z.coerce.number().nonnegative().default(0.10),
  RANK_W_SNOOZED: z.coerce.number().nonnegative().default(0.50),

  // Integrations — all optional in dev. Each integration's startup checks
  // its own subset and refuses to connect if missing.
  QBO_CLIENT_ID: z.string().optional(),
  QBO_CLIENT_SECRET: z.string().optional(),
  QBO_REDIRECT_URI: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  QBO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),

  HARVEST_CLIENT_ID: z.string().optional(),
  HARVEST_CLIENT_SECRET: z.string().optional(),
  HARVEST_REDIRECT_URI: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),

  DROPBOXSIGN_CLIENT_ID: z.string().optional(),
  DROPBOXSIGN_CLIENT_SECRET: z.string().optional(),
  DROPBOXSIGN_API_KEY: z.string().optional(),

  AIRTABLE_CLIENT_ID: z.string().optional(),
  AIRTABLE_CLIENT_SECRET: z.string().optional(),
  AIRTABLE_REDIRECT_URI: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  GOOGLE_PUBSUB_TOPIC: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`Invalid environment:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}
