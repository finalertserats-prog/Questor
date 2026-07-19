import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not jsdom. The turn-taking logic is pure logic over the browser's
    // SpeechRecognition API, so a fake of that API is the whole environment it
    // needs — pulling in a DOM implementation would add a dependency and test
    // less directly.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
