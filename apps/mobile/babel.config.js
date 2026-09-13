/**
 * FILE: apps/mobile/babel.config.js
 *
 * PURPOSE
 *   How Metro transforms every source file before bundling it.
 *
 * INPUTS  : none (read by Metro's transformer)
 * OUTPUTS : a Babel configuration object
 * CONSUMED BY : every .ts/.tsx file in this app, and @peapod/shared's source
 *
 * WHY THIS FILE IS SO SHORT AND SO IMPORTANT
 *   `babel-preset-expo` already contains everything a normal app needs:
 *   TypeScript stripping, JSX, the React Native runtime transforms, and the
 *   `@/*` path alias resolved from tsconfig.json. The only thing it cannot
 *   decide for us is PLUGIN ORDER, and one plugin here is order-sensitive.
 */

module.exports = function babelConfig(api) {
  // Babel calls this function once per configuration environment. Caching on
  // `true` tells it the result never varies, which skips a re-evaluation on
  // every single file - a measurable difference on a cold bundle.
  api.cache(true);

  return {
    // require.resolve so Babel (running from the repo-root @babel/core) finds
    // the preset even when npm nested it under expo/node_modules.
    presets: [require.resolve('babel-preset-expo')],
    plugins: [
      // ---------------------------------------------------------------------
      // THE REANIMATED PLUGIN. IT MUST BE LAST. ALWAYS.
      // ---------------------------------------------------------------------
      // Reanimated runs animation callbacks on a second JavaScript runtime that
      // lives on the UI thread, so an animation keeps ticking at 60fps even
      // while the main thread is busy rendering a list or parsing a response.
      //
      // Functions destined for that runtime are marked with the 'worklet'
      // directive, and this plugin is what finds them, rewrites them into a
      // form the second runtime can execute, and captures the variables they
      // close over. If any other plugin transforms a function AFTER this one
      // has processed it, the rewritten form is destroyed and the animation
      // fails at runtime with an unhelpful error about a worklet not being a
      // function. Being last in the list is what guarantees that cannot happen.
      //
      // The plugin lives in `react-native-worklets` rather than
      // `react-native-reanimated` as of Reanimated 4, which split the worklet
      // runtime into its own package. It is still "the Reanimated plugin"; only
      // the package name changed.
      'react-native-worklets/plugin',
    ],
  };
};
