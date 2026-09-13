/**
 * MODULE: apps/mobile/eslint.config.js
 *
 * PURPOSE
 *   ESLint 9 flat config. `eslint-config-expo` already knows about Expo
 *   Router, React Native, and the TypeScript parser; we only add ignores.
 *
 * INPUTS  : none
 * OUTPUTS : the config array ESLint loads
 * CONSUMED BY : `npm run lint` in this package
 */

const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'node_modules/*'],
  },
  {
    rules: {
      // Workspace package is resolved by Metro via package.json exports, which
      // the ESLint import plugin does not walk the same way.
      'import/no-unresolved': ['error', { ignore: ['^@peapod/'] }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Vitest hoists vi.mock calls; importing the module under test after
      // those declarations makes the dependency boundary explicit.
      'import/first': 'off',
    },
  },
]);
