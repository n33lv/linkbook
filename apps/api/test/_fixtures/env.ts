// Apply the minimum env needed for loadConfig() to pass. Tests override
// DATABASE_URL per case to point at a fresh tempfile or :memory:.

export function applyTestEnv(extra: Record<string, string> = {}): void {
  const baseline: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '3001',
    LOG_LEVEL: 'fatal',
    DEV_PRINCIPAL_EMAIL: 'neel@flightdesign.co',
    DEV_PRINCIPAL_NAME: 'Neel',
    STUDIO_NAME: 'Flight Design Co.',
    STUDIO_FISCAL_YEAR_START: '01-01',
    STUDIO_BILLABLE_TARGET_PCT: '70',
    STUDIO_LOADED_COST_RATE: '85',
    USE_INTEGRATION_MOCKS: 'true',
    LLM_DAILY_KILL_SWITCH_USD: '20',
    QBO_ENVIRONMENT: 'sandbox',
    DATABASE_URL: 'file::memory:?cache=shared',
  };
  for (const [k, v] of Object.entries({ ...baseline, ...extra })) {
    process.env[k] = v;
  }
}
