/**
 * MODULE: apps/mobile/plugins/withMapsApiKeyFromLocalProperties.cjs
 *
 * PURPOSE
 *   Keep the Google Maps SDK Android key off git. After `expo prebuild`,
 *   Gradle reads `MAPS_API_KEY` from `android/local.properties` (or
 *   `GOOGLE_MAPS_ANDROID_API_KEY` in the environment for EAS) and injects it
 *   into AndroidManifest.xml through `manifestPlaceholders`.
 *
 * INPUTS  : android/local.properties  MAPS_API_KEY=...
 * OUTPUTS : app/build.gradle placeholder +
 *           <meta-data android:name="com.google.android.geo.API_KEY"
 *                      android:value="${MAPS_API_KEY}" />
 *
 * CALLED BY
 *   Expo prebuild / EAS, via apps/mobile/app.config.ts `plugins`.
 */

const { AndroidConfig, withAndroidManifest, withAppBuildGradle } = require('@expo/config-plugins');

const META_NAME = 'com.google.android.geo.API_KEY';
const PLACEHOLDER = '${MAPS_API_KEY}';

const GRADLE_LOAD = `
    // Maps SDK key: android/local.properties (gitignored). EAS uses the env var.
    def peapodLocalProperties = new Properties()
    def peapodLocalPropertiesFile = rootProject.file("local.properties")
    if (peapodLocalPropertiesFile.exists()) {
        peapodLocalPropertiesFile.withInputStream { stream -> peapodLocalProperties.load(stream) }
    }
    def peapodMapsApiKey = peapodLocalProperties.getProperty("MAPS_API_KEY") ?: (System.getenv("GOOGLE_MAPS_ANDROID_API_KEY") ?: "")
`;

const GRADLE_PLACEHOLDER = 'manifestPlaceholders += [MAPS_API_KEY: peapodMapsApiKey]';

function applyAppBuildGradle(contents) {
  let next = contents;
  if (!next.includes('def peapodMapsApiKey')) {
    if (!/android\s*\{/.test(next)) {
      throw new Error('withMapsApiKeyFromLocalProperties: no android { block in app/build.gradle');
    }
    next = next.replace(/android\s*\{/, `android {${GRADLE_LOAD}`);
  }
  if (!next.includes('MAPS_API_KEY: peapodMapsApiKey')) {
    if (!/defaultConfig\s*\{/.test(next)) {
      throw new Error('withMapsApiKeyFromLocalProperties: no defaultConfig { in app/build.gradle');
    }
    next = next.replace(/defaultConfig\s*\{/, `defaultConfig {\n        ${GRADLE_PLACEHOLDER}`);
  }
  return next;
}

function setManifestPlaceholder(androidManifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, META_NAME, PLACEHOLDER);
  return androidManifest;
}

function withMapsApiKeyFromLocalProperties(config) {
  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = applyAppBuildGradle(mod.modResults.contents);
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    mod.modResults = setManifestPlaceholder(mod.modResults);
    return mod;
  });
  return config;
}

module.exports = withMapsApiKeyFromLocalProperties;
