import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not jsdom. The turn-taking logic is pure logic over the browser's
    // SpeechRecognition API, so a fake of that API is the whole environment it
    // needs — pulling in a DOM implementation would add a dependency and test
    // less directly.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The recognizer tests reset the module registry and re-import the speech
    // module in every case. Idle, the whole file runs in well under a second;
    // with a build, another test run and an install sharing the machine, that
    // re-import alone has crossed vitest's 5 s default and failed a test that
    // had not started asserting. The budget below is headroom for that, not
    // permission for slow tests: nothing here should take more than a second.
    testTimeout: 20_000,
  },
});
