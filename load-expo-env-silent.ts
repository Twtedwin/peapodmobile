/**
 * FILE: load-expo-env-silent.ts
 *
 * PURPOSE
 *   Hydrate process.env from the repository `.env` without printing
 *   `env: load` / `env: export` to stdout. Expo CLI's `@expo/env` loader
 *   uses console.log for those lines, which breaks `npx expo config --json`
 *   and the EAS parser.
 *
 *   Imported first from the root app.config.ts so the dynamic config sees
 *   EXPO_PUBLIC_* values even when Expo evaluates the file before its own
 *   dotenv pass. `{ silent: true }` is the official @expo/env quiet flag
 *   (same as disabling dotenv debug/verbose).
 */
import { loadProjectEnv } from '@expo/env';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

loadProjectEnv(dirname(fileURLToPath(import.meta.url)), { silent: true });
