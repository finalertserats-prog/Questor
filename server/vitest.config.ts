import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./data/test.db',
      AUTH_SECRET: 'test-secret-test-secret-test-secret-32',
      LLM_PROVIDER: 'heuristic',
    },
    globalSetup: './tests/globalSetup.ts',
    hookTimeout: 30000,
    testTimeout: 30000,
    fileParallelism: false,
  },
});
