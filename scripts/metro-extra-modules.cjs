/**
 * FILE: scripts/metro-extra-modules.cjs
 *
 * PURPOSE
 *   Shared Metro `extraNodeModules` map for the root and apps/mobile configs.
 *
 * WHY
 *   `disableHierarchicalLookup` stops Metro walking into nested folders such
 *   as node_modules/expo/node_modules. Expo still imports those packages
 *   (`expo-asset` from Expo.fx.tsx).
 *
 *   Pin React/RN and SDK 57 modules to the single root copies used by Expo
 *   Go's Fabric renderer.
 *
 * INPUTS  : workspaceRoot (repository root)
 * OUTPUTS : { [packageName]: absoluteDir }
 * CONSUMED BY : metro.config.cjs, apps/mobile/metro.config.js
 */
const fs = require('fs');
const path = require('path');

function versionOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      .version;
  } catch {
    return null;
  }
}

function pick(workspaceRoot, name, majorPrefix) {
  const candidates = [
    path.join(workspaceRoot, 'apps/mobile/node_modules', name),
    path.join(workspaceRoot, 'node_modules/expo/node_modules', name),
    path.join(workspaceRoot, 'node_modules', name),
  ];
  const existing = candidates.filter((dir) => versionOf(dir));
  const matching = existing.find((dir) =>
    String(versionOf(dir)).startsWith(majorPrefix),
  );
  return matching ?? existing[0];
}

function extraNodeModules(workspaceRoot) {
  const extra = {
    react: path.join(workspaceRoot, 'node_modules/react'),
    'react-native': path.join(workspaceRoot, 'node_modules/react-native'),
  };
  const sdk57 = [
    ['expo', '57.'],
    ['expo-asset', '57.'],
    ['expo-file-system', '57.'],
    ['expo-font', '57.'],
    ['expo-keep-awake', '57.'],
    // keepAwakeGuard and expo itself import this. With hierarchical lookup
    // off it is otherwise stuck under node_modules/expo/node_modules.
    ['expo-modules-core', '57.'],
  ];
  for (const [name, major] of sdk57) {
    const dir = pick(workspaceRoot, name, major);
    if (dir) extra[name] = dir;
  }
  return extra;
}

module.exports = { extraNodeModules };
