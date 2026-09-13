/**
 * FILE: apps/mobile/metro.config.js
 *
 * PURPOSE
 *   Teach Metro (React Native's bundler) that this app lives inside a monorepo
 *   and depends on a sibling workspace package that ships TypeScript source.
 *
 * INPUTS  : none (read by Metro at bundler startup)
 * OUTPUTS : a Metro configuration object
 * CONSUMED BY : `expo start`, `eas build`, and anything else that bundles the app
 *
 * ============================================================================
 * WHY A DEFAULT METRO CONFIG DOES NOT WORK HERE
 * ============================================================================
 *   Metro was designed for a single-package app. Three of its defaults break in
 *   a workspace layout, and each produces a different confusing error:
 *
 *   1. It only WATCHES the project directory. `packages/shared` lives outside
 *      it, so edits to the contract would not trigger a reload - the app would
 *      silently keep serving stale code until the bundler was restarted.
 *
 *   2. It resolves node_modules by walking UP from each file. npm workspaces
 *      hoist most dependencies to the repository root, so that walk mostly
 *      works by accident, and fails in exactly the confusing case where a
 *      package was NOT hoisted.
 *
 *   3. It ignores the `exports` field in package.json unless told otherwise.
 *      @peapod/shared uses `exports` to point React Native at its TypeScript
 *      source; without exports support Metro would fall back to `main`, which
 *      points at dist/ - and dist/ does not exist until someone runs a build.
 *      The app would fail to start on a fresh clone.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const { extraNodeModules } = require('../../scripts/metro-extra-modules.cjs');

/** This app. */
const projectRoot = __dirname;
/** The repository root: apps/mobile -> apps -> <root>. */
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// ---------------------------------------------------------------------------
// 1. Watch the whole repository
// ---------------------------------------------------------------------------
// Metro reloads the app when a watched file changes. Watching the repository
// root means editing packages/shared/src/rules.ts refreshes the phone straight
// away, exactly like editing a file in this app.
config.watchFolders = [workspaceRoot];

// ---------------------------------------------------------------------------
// 2. One React / React Native copy — always the hoisted root
// ---------------------------------------------------------------------------
// SDK 57 expects hierarchical lookup. Both workspace manifests now request
// the same React/React Native versions; extraNodeModules remains the final
// guard that sends renderer imports to the hoisted pair.
config.resolver.disableHierarchicalLookup = false;
config.resolver.nodeModulesPaths = [
  path.resolve(workspaceRoot, 'node_modules'),
  path.resolve(projectRoot, 'node_modules'),
];
config.resolver.extraNodeModules = extraNodeModules(workspaceRoot);

// ---------------------------------------------------------------------------
// 3. Honour the `exports` field, and the `react-native` condition inside it
// ---------------------------------------------------------------------------
// @peapod/shared declares:
//
//     "exports": { ".": { "react-native": "./src/index.ts",
//                         "default": "./dist/src/index.js" } }
//
// so with package exports enabled Metro takes the TypeScript source directly
// and Node consumers (services/api) still get the compiled output. The app
// therefore needs no build step before `npx expo start` works on a fresh clone.
config.resolver.unstable_enablePackageExports = true;

// The condition names are listed most-specific first. `react-native` must be
// present or the branch above is never selected. (Expo's default already
// includes it; stating it here means a future Expo default cannot silently
// break the shared package's resolution.)
config.resolver.unstable_conditionNames = ['react-native', 'require', 'import'];

// ---------------------------------------------------------------------------
// 4. TypeScript ESM specifiers (foo.js -> foo.ts)
// ---------------------------------------------------------------------------
// @peapod/shared is `"type": "module"` TypeScript: relative imports are written
// as `./rules.js` even though the file on disk is `rules.ts`. Node's tsc
// understands that; Metro with package-exports enabled does not, and fails
// with "Unable to resolve ./rules.js". Rewrite the specifier before Metro
// looks for a file.
const defaultResolveRequest = config.resolver.resolveRequest;
const pinFromRoot = {
  originModulePath: path.join(workspaceRoot, 'package.json'),
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

// ---------------------------------------------------------------------------
// A note on the shared package's import style
// ---------------------------------------------------------------------------
// @peapod/shared is an ES module, so its internal imports are written with
// explicit extensions - `import { GEO } from '../rules.js'` inside a .ts file.
// That is the TypeScript ESM convention: the specifier names the file that will
// exist after compilation. Metro understands this and maps a `.js` specifier
// back onto the `.ts` file that produces it, so no extra configuration is
// needed. It is worth knowing about, because the failure mode ("Unable to
// resolve ../rules.js") looks like a missing file rather than a resolver
// setting.

module.exports = config;
