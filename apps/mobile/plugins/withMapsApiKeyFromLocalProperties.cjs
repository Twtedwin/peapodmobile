/**
 * MODULE: apps/mobile/plugins/withMapsApiKeyFromLocalProperties.cjs
 *
 * PURPOSE
 *   Keep the Google Maps SDK Android key off git. After `expo prebuild`,
 *   Gradle fills `com.google.android.geo.API_KEY` from, in order:
 *     1. android/local.properties  MAPS_API_KEY  (blank counts as unset)
 *     2. GOOGLE_MAPS_ANDROID_API_KEY / EXPO_PUBLIC_GOOGLE_MAPS_API_KEY_ANDROID
 *     3. the value present in process.env at prebuild (root .env / EAS env)
 *
 * A blank `MAPS_API_KEY=` in local.properties used to win over a real env
 * key because Groovy `?:` only replaces null, not "".
 */

const { AndroidConfig, withAndroidManifest, withAppBuildGradle } = require('@expo/config-plugins');

const META_NAME = 'com.google.android.geo.API_KEY';
const PLACEHOLDER = '${MAPS_API_KEY}';

function firstEnvKey() {
  const names = [
    'GOOGLE_MAPS_ANDROID_API_KEY',
    'EXPO_PUBLIC_GOOGLE_MAPS_API_KEY_ANDROID',
    'MAPS_API_KEY',
  ];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function groovySingleQuoted(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function gradleLoadBlock() {
  const baked = groovySingleQuoted(firstEnvKey());
  return `
    // Maps SDK key. Blank local.properties values must not mask env / prebuild keys.
    def peapodLocalProperties = new Properties()
    def peapodLocalPropertiesFile = rootProject.file("local.properties")
    if (peapodLocalPropertiesFile.exists()) {
        peapodLocalPropertiesFile.withInputStream { stream -> peapodLocalProperties.load(stream) }
    }
    def peapodMapsFromFile = peapodLocalProperties.getProperty("MAPS_API_KEY")
    def peapodMapsFromEnv = System.getenv("GOOGLE_MAPS_ANDROID_API_KEY") ?: System.getenv("EXPO_PUBLIC_GOOGLE_MAPS_API_KEY_ANDROID") ?: ""
    def peapodMapsApiKey = (peapodMapsFromFile != null && !peapodMapsFromFile.trim().isEmpty()) ? peapodMapsFromFile.trim() : (peapodMapsFromEnv.trim() ? peapodMapsFromEnv.trim() : ${baked})
`;
}

const GRADLE_PLACEHOLDER = 'manifestPlaceholders += [MAPS_API_KEY: peapodMapsApiKey]';

function applyAppBuildGradle(contents) {
  let next = contents.replace(
    /\n\s*\/\/ Maps SDK key[\s\S]*?def peapodMapsApiKey =[^\n]*\n/,
    '\n',
  );
  next = next.replace(/\n\s*manifestPlaceholders \+= \[MAPS_API_KEY: peapodMapsApiKey\]\n/, '\n');
  if (!next.includes('def peapodMapsApiKey')) {
    if (!/android\s*\{/.test(next)) {
      throw new Error('withMapsApiKeyFromLocalProperties: no android { block in app/build.gradle');
    }
    next = next.replace(/android\s*\{/, `android {${gradleLoadBlock()}`);
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
