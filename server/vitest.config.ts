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
      // Pinned so the suite asserts the documented zero-key defaults rather
      // than whatever the developer happens to have enabled in server/.env.
      // Without this, switching a real deployment to paid speech providers
      // turns a green suite red on a machine that changed no code — and worse,
      // a test that reaches a paid provider bills a real account.
      STT_PROVIDER: 'webspeech',
      TTS_PROVIDER: 'webspeech',
    },
    globalSetup: './tests/globalSetup.ts',
    hookTimeout: 30000,
    testTimeout: 30000,
    fileParallelism: false,
  },
});
