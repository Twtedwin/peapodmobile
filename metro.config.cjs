/**
 * FILE: metro.config.cjs (repository root)
 *
 * PURPOSE
 *   Metro config used when Expo is started from the monorepo root.
 *   `.cjs` because the root package.json is `"type": "module"`; a `.js`
 *   Metro file would be treated as ESM and `require` would throw.
 *
 *   Project root is this directory so it matches Expo CLI. Routes live
 *   under apps/mobile/app (see root app.config.ts expo-router plugin).
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const { extraNodeModules } = require('./scripts/metro-extra-modules.cjs');

const projectRoot = __dirname;
const mobileRoot = path.resolve(projectRoot, 'apps/mobile');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [projectRoot];

// SDK 57's Metro config expects hierarchical lookup. Package versions are
// aligned across both manifests, while extraNodeModules keeps the renderer
// pinned to the hoisted React/React Native pair.
config.resolver.disableHierarchicalLookup = false;
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(mobileRoot, 'node_modules'),
];
config.resolver.extraNodeModules = extraNodeModules(projectRoot);

config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['react-native', 'require', 'import'];

const defaultResolveRequest = config.resolver.resolveRequest;
const pinFromRoot = {
  originModulePath: path.join(projectRoot, 'package.json'),
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const ctx =
    moduleName === 'react' ||
    moduleName === 'react-native' ||
    moduleName.startsWith('react/') ||
    moduleName.startsWith('react-native/')
      ? { ...context, ...pinFromRoot }
      : context;
  const resolve = defaultResolveRequest
    ? (name) => defaultResolveRequest(ctx, name, platform)
    : (name) => ctx.resolveRequest(ctx, name, platform);

  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const withoutJs = moduleName.slice(0, -3);
    for (const candidate of [`${withoutJs}.ts`, `${withoutJs}.tsx`, moduleName]) {
      try {
        return resolve(candidate);
      } catch {
        // try the next extension
      }
    }
  }

  return resolve(moduleName);
};

module.exports = config;
