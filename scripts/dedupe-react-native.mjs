/**
 * FILE: scripts/dedupe-react-native.mjs
 *
 * PURPOSE
 *   npm workspaces will nest a second `react` / `react-native` under
 *   apps/mobile/node_modules whenever the hoisted version does not match
 *   the workspace's request. Metro then loads two copies and Expo Go's
 *   Fabric renderer has no view config for AndroidProgressBar.
 *
 *   After every install, delete those nested copies so only the root
 *   packages remain. Metro also pins resolution to the root (see
 *   metro.config.cjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nested = [
  path.join(root, 'apps/mobile/node_modules/react'),
  path.join(root, 'apps/mobile/node_modules/react-dom'),
  path.join(root, 'apps/mobile/node_modules/react-native'),
];

for (const dir of nested) {
  if (!fs.existsSync(dir)) continue;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`dedupe-react-native: removed ${path.relative(root, dir)}`);
}
