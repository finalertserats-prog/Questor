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

    // Files run one at a time AND each in its own process.
    //
    // `fileParallelism: false` alone was not enough and produced a suite that
    // could not be trusted: every file passed in isolation while the full run
    // failed, with a DIFFERENT set of failures each time. Sequential-but-shared
    // still means one process, so module-level state leaks across files — the
    // cached LLM provider, the in-process TTS cache, and `vi.mock` of config
    // all persist. A file that swaps the speech provider then hands the next
    // file a poisoned cache.
    //
    // A test suite that reports a different answer each run is worse than no
    // suite, because its green is quoted as evidence. Forks cost a few seconds
    // and buy a result that means something.
    // Sequential because every file shares one SQLite test database and calls
    // wipe() in beforeAll — running them at once would have them deleting each
    // other's fixtures. Isolated forks because sequential alone still shares a
    // process.
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
  },
});
