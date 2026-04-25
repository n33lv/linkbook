import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    testTimeout: 15_000,
  },
  // Native modules need Node's resolver; CJS deps too. Disable vite's
  // server-side transform by externalising broadly. Tests import the
  // built dist for our packages so this is safe.
  ssr: {
    external: true,
  },
});
