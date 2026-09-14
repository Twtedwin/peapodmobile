/**
 * FILE: scripts/silence-expo-env-logs.mjs
 *
 * PURPOSE
 *   `@expo/env` prints `env: load .env` and `env: export KEY...` with
 *   console.log (stdout). Expo CLI does that before emitting JSON when
 *   you run `expo config --json`, so EAS's parser exits with code 1.
 *
 *   This rewrites logLoadedEnv so `--json` is treated as silent. The
 *   banners still appear on `expo start`. Idempotent; safe to run from
 *   postinstall on EAS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let envIndex;
try {
  envIndex = require.resolve('@expo/env/build/index.js');
} catch {
  process.exit(0);
}

const needle =
  'if (options.force || options.silent || !envInfo.loaded.length) return envInfo;';
const replacement =
  'if (options.force || options.silent || process.argv.includes("--json") || !envInfo.loaded.length) return envInfo;';

const source = fs.readFileSync(envIndex, 'utf8');
if (source.includes('process.argv.includes("--json")')) {
  process.exit(0);
}
if (!source.includes(needle)) {
  console.warn(
    `silence-expo-env-logs: expected marker missing in ${path.relative(process.cwd(), envIndex)}; skip`,
  );
  process.exit(0);
}

fs.writeFileSync(envIndex, source.replace(needle, replacement));
