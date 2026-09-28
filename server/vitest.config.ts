import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: {
      NODE_ENV: 'test',
      // DATABASE_URL is deliberately NOT set here — tests/perFileDb.ts assigns a
      // per-worker database before Prisma is imported. A value here would look
      // authoritative and be silently overridden.
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

    // Builds the schema template every worker copies.
    globalSetup: './tests/globalSetup.ts',
    // Points this worker at its own copy, before src/db.ts constructs Prisma.
    setupFiles: ['./tests/perFileDb.ts'],

    hookTimeout: 30000,
    testTimeout: 30000,

    // Two separate isolation problems, two separate fixes — conflating them is
    // why this took three attempts.
    //
    // 1. SHARED DATABASE. Every file calls wipe() in beforeAll, so with one
    //    test.db whichever file ran second destroyed the first's fixtures. The
    //    suite failed with a different set of 404s and 500s on every run while
    //    each file passed alone. Fixed by per-file databases (setupFiles), not
    //    by scheduling — the shared resource was the file, not the order.
    //
    // 2. SHARED PROCESS. Sequential execution still means one process, so
    //    module-level state leaks: the cached LLM provider, the in-process TTS
    //    cache, vi.mock of config. A file that swapped the speech provider
    //    handed the next file a poisoned cache. Fixed by isolated forks.
    //
    // A suite that reports a different answer each run is worse than no suite,
    // because its green gets quoted as evidence that something is safe.
    pool: 'forks',
    isolate: true,
  },
});
