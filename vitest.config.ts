import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // One MongoDB replica set for the run; each test file uses its own database.
    globalSetup: ['test/setup/global-setup.ts'],
    testTimeout: 30_000,
    // The first run downloads the MongoDB binary.
    hookTimeout: 180_000,
  },
});
