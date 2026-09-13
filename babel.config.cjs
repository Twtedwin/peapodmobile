/**
 * FILE: babel.config.cjs (repository root)
 *
 * PURPOSE
 *   Same Babel pipeline as apps/mobile. `.cjs` because the root package.json
 *   is `"type": "module"`.
 */
module.exports = require('./apps/mobile/babel.config.js');
