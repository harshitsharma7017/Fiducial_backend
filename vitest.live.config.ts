import { defineConfig } from 'vitest/config';

// Opt-in tests that call real external services (npm run test:live:gemini). Not part of
// `npm test`: they cost money, need credentials, and send data outside the machine.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/**/*.live.ts'],
    testTimeout: 180_000,
  },
});
