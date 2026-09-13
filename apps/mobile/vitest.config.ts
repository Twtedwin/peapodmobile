/**
 * Unit-test configuration for network behavior that must work before React
 * Native renders: successful JSON, HTTP failures, and request timeouts.
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    env: {
      EXPO_PUBLIC_API_URL: 'http://api.test:8080',
    },
    include: ['test/**/*.test.ts'],
    clearMocks: true,
  },
});
