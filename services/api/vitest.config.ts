/**
 * Vitest config for the API's parity tests.
 *
 * Tests live in `test/` which is excluded from the service tsconfig (that
 * one is for `tsc` emitting `dist/`). Vitest transpiles them on its own.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
  },
});
