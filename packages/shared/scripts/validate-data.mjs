#!/usr/bin/env node
/**
 * SCRIPT: packages/shared/scripts/validate-data.mjs
 *
 * PURPOSE
 *   Fails fast if any rule, catalog, or seed file has become invalid JSON, lost
 *   its `$schemaVersion`, or broken one of Peapod's cross-file invariants.
 *
 * INPUTS  : ../data/**\/*.json
 * OUTPUTS : exit code 0 (all good) or 1 (with a report of what is wrong)
 *
 * USAGE
 *   node scripts/validate-data.mjs
 *
 * WHY THIS EXISTS
 *   These files are read by four languages. A trailing comma is a build error in
 *   TypeScript, a compile error in Rust, and a runtime crash in Python -- but
 *   only the last of those happens in production, at 3am. Catching it here makes
 *   it a five-second failure instead.
 *
 *   The invariant checks matter more than the syntax check. An earned garden
 *   seed that accidentally acquires a `peanutCost` would silently become
 *   purchasable, quietly destroying the one distinction the whole garden feature
 *   rests on. A rule file cannot express that constraint; this script can.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

/** Accumulated problems. A non-empty list means exit 1. */
const errors = [];
/** Accumulated advisories. These do not fail the run. */
const warnings = [];

/**
 * Recursively lists every `.json` file under a directory.
 *
 * @param dir Absolute directory path.
 * @returns Absolute file paths, sorted for deterministic output.
 */
function listJsonFiles(dir) {
  const out = [];

  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJsonFiles(full));
    else if (entry.endsWith('.json')) out.push(full);
  }

  return out;
}

/**
 * Parses a file, recording a readable error rather than throwing.
 *
 * @param path Absolute file path.
 * @returns The parsed value, or null when parsing failed.
 */
function parseOrRecord(path) {
  const label = relative(DATA_DIR, path);

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    errors.push(`${label}: not valid JSON -- ${cause.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

/**
 * Every data file must declare a `$schemaVersion`.
 *
 * Without one, a breaking shape change is invisible to a service reading an
 * older copy of the file from a cached image.
 *
 * @param label Relative path, for the message.
 * @param data  The parsed file.
 */
function checkSchemaVersion(label, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  if (typeof data.$schemaVersion !== 'number') {
    errors.push(`${label}: missing a numeric "$schemaVersion" at the top level.`);
  }
}

/**
 * Garden invariants -- the ones the product genuinely depends on.
 *
 * @param data The parsed garden.json.
 */
function checkGarden(data) {
  const label = 'rules/garden.json';

  const earned = data?.earnedSeeds?.items ?? [];
  const shop = data?.shopSeeds?.items ?? [];

  // THE central rule: an earned seed represents something a pod actually did.
  // Giving one a price would make a Sakura tree -- which is supposed to mean
  // "we went to Japan" -- purchasable, and the garden would stop meaning
  // anything at all.
  for (const seed of earned) {
    if (seed.peanutCost !== undefined) {
      errors.push(
        `${label}: earned seed "${seed.id}" has a peanutCost. Earned seeds are granted only by real ` +
          `experiences and must never be purchasable.`,
      );
    }
    if (!Array.isArray(seed.triggerTypes) || seed.triggerTypes.length === 0) {
      errors.push(`${label}: earned seed "${seed.id}" has no triggerTypes, so nothing can ever grant it.`);
    }
  }

  // The mirror rule: a shop seed with no price cannot be sold.
  for (const seed of shop) {
    if (typeof seed.peanutCost !== 'number') {
      errors.push(`${label}: shop seed "${seed.id}" has no numeric peanutCost.`);
    }
    if (seed.triggerTypes !== undefined) {
      warnings.push(
        `${label}: shop seed "${seed.id}" declares triggerTypes, which only applies to earned seeds.`,
      );
    }
  }

  // Seed ids share one namespace, since a garden entry stores only a catalog_id.
  const ids = [...earned, ...shop].map((seed) => seed.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    errors.push(`${label}: duplicate seed ids across the shop and earned catalogs: ${[...new Set(duplicates)].join(', ')}`);
  }

  // Every seed mapping must point at a seed that exists, or the reward would
  // silently fail to be granted.
  const known = new Set(ids);
  const mappings = [
    ...(data?.memoryTagToEarnedSeed?.order ?? []),
    ...(data?.tripToEarnedSeed?.order ?? []),
  ];
  for (const rule of mappings) {
    if (rule.seed && !known.has(rule.seed)) {
      errors.push(`${label}: a seed mapping points at unknown seed "${rule.seed}".`);
    }
  }
  for (const key of ['memoryTagToEarnedSeed', 'tripToEarnedSeed']) {
    const fallback = data?.[key]?._default;
    if (fallback && !known.has(fallback)) {
      errors.push(`${label}: ${key}._default points at unknown seed "${fallback}".`);
    }
  }

  // Every species referenced by the tag map must exist.
  const speciesIds = new Set((data?.species?.items ?? []).map((entry) => entry.id));
  for (const [tag, speciesId] of Object.entries(data?.memoryTagToSpecies ?? {})) {
    if (tag.startsWith('_')) continue;
    if (!speciesIds.has(speciesId)) {
      errors.push(`${label}: memoryTagToSpecies["${tag}"] points at unknown species "${speciesId}".`);
    }
  }
}

/**
 * Progression invariants.
 *
 * @param data The parsed progression.json.
 */
function checkProgression(data) {
  const label = 'rules/progression.json';
  const levels = data?.worldLevels ?? [];

  if (levels.length === 0) {
    errors.push(`${label}: worldLevels is empty, so every pod would be level 1 forever.`);
    return;
  }

  // Level 1 must start at zero XP or a brand-new pod has no level at all.
  if (levels[0].xp !== 0) {
    errors.push(`${label}: the first world level must start at 0 XP (found ${levels[0].xp}).`);
  }

  // Thresholds must strictly increase, otherwise levelFromXp becomes ambiguous.
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].xp <= levels[i - 1].xp) {
      errors.push(
        `${label}: world level ${levels[i].level} has an XP threshold (${levels[i].xp}) that does not ` +
          `exceed level ${levels[i - 1].level}'s (${levels[i - 1].xp}). Thresholds must strictly increase.`,
      );
    }
    if (levels[i].level !== levels[i - 1].level + 1) {
      errors.push(`${label}: world levels must be consecutive; found ${levels[i - 1].level} then ${levels[i].level}.`);
    }
  }

  // Every reward must be a non-negative number -- a negative XP award would
  // silently demote a pod for doing something together.
  for (const [table, values] of [
    ['xpRewards', data?.xpRewards],
    ['peanutEarnRules', data?.peanutEarnRules],
  ]) {
    for (const [action, value] of Object.entries(values ?? {})) {
      if (action.startsWith('_')) continue;
      if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) {
        errors.push(`${label}: ${table}.${action} must be a non-negative integer (found ${JSON.stringify(value)}).`);
      }
    }
  }

  const capacity = data?.gardenPlotCapacity;
  if (capacity && capacity.base + capacity.perLevel > capacity.max) {
    warnings.push(
      `${label}: gardenPlotCapacity is already at its max (${capacity.max}) by level 1, so levelling up ` +
        `never unlocks a slot.`,
    );
  }
}

/**
 * Decision invariants.
 *
 * @param data The parsed decisions.json.
 */
function checkDecisions(data) {
  const label = 'rules/decisions.json';
  const harmony = data?.harmony;

  if (!harmony) {
    errors.push(`${label}: missing the harmony block.`);
    return;
  }

  // A maybe weight outside 0..1 would make "maybe" either worthless or stronger
  // than "want", both of which break the three-stance design.
  if (typeof harmony.maybeWeight !== 'number' || harmony.maybeWeight < 0 || harmony.maybeWeight > 1) {
    errors.push(`${label}: harmony.maybeWeight must be between 0 and 1 (found ${harmony.maybeWeight}).`);
  }

  if (harmony.clamp?.min !== 0 || harmony.clamp?.max !== 100) {
    warnings.push(`${label}: harmony is clamped to something other than 0..100, which the UI assumes.`);
  }

  // All five outcomes must be reachable and have display copy, or the UI would
  // render a blank result card.
  const OUTCOMES = ['everyone_in', 'work_it_out', 'maybe_later', 'not_for_us', 'deciding'];
  for (const outcome of OUTCOMES) {
    if (!data?.outcomeCopy?.[outcome]) {
      errors.push(`${label}: outcomeCopy is missing an entry for "${outcome}".`);
    }
    if (!data?.stageMapping?.[outcome]) {
      errors.push(`${label}: stageMapping is missing an entry for "${outcome}".`);
    }
  }
}

/**
 * Geo invariants.
 *
 * @param data The parsed geo.json.
 */
function checkGeo(data) {
  const label = 'rules/geo.json';

  const enter = data?.geofence?.enterRadius_m?.value;
  const exit = data?.geofence?.exitRadius_m?.value;

  // The hysteresis gap is the whole point of having two radii. If exit were not
  // larger than entry, a member sitting on the boundary would fire an endless
  // arrived/left alert loop and notify their whole pod each time.
  if (typeof enter === 'number' && typeof exit === 'number' && exit <= enter) {
    errors.push(
      `${label}: geofence exitRadius_m (${exit}) must be LARGER than enterRadius_m (${enter}). ` +
        `The gap between them is the hysteresis that prevents alert flapping.`,
    );
  }

  // Activity bands must be ordered, or classification becomes unreachable.
  const bands = data?.activityBands;
  if (bands) {
    const stationary = bands.stationaryBelow_mps?.value;
    const walking = bands.walkingBelow_mps?.value;
    const cycling = bands.cyclingBelow_mps?.value;
    if (!(stationary < walking && walking < cycling)) {
      errors.push(
        `${label}: activity band thresholds must strictly increase ` +
          `(stationary ${stationary} < walking ${walking} < cycling ${cycling}).`,
      );
    }
  }

  // Every documented threshold must actually carry its justification, since the
  // `why` field is the only place that reasoning is recorded.
  const walk = (node, path) => {
    if (typeof node !== 'object' || node === null) return;

    if (Object.hasOwn(node, 'value') && typeof node.value === 'number') {
      if (typeof node.why !== 'string' || node.why.trim() === '') {
        warnings.push(`${label}: threshold at ${path} has a value but no "why" explaining it.`);
      }
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('_')) continue;
      walk(child, `${path}.${key}`);
    }
  };
  walk(data, 'geo');
}

/**
 * Reward and collectible invariants.
 *
 * @param rewards      The parsed rewards.json, or null when absent.
 * @param collectibles The parsed collectibles.json, or null when absent.
 */
function checkCatalogs(rewards, collectibles) {
  if (rewards) {
    const ids = (rewards.items ?? []).map((item) => item.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) {
      errors.push(`catalog/rewards.json: duplicate item ids: ${[...new Set(duplicates)].join(', ')}`);
    }

    for (const item of rewards.items ?? []) {
      if (typeof item.peanutCost !== 'number' || item.peanutCost < 0) {
        errors.push(`catalog/rewards.json: "${item.id}" needs a non-negative peanutCost.`);
      }
    }
  }

  if (collectibles) {
    const ids = (collectibles.items ?? []).map((item) => item.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) {
      errors.push(`catalog/collectibles.json: duplicate item ids: ${[...new Set(duplicates)].join(', ')}`);
    }

    // Every collectible must state how it is earned. One with no rule can never
    // be unlocked, which shows as a permanently greyed-out slot with no way to
    // ever fill it.
    for (const item of collectibles.items ?? []) {
      if (!item.unlockedBy || typeof item.unlockedBy.kind !== 'string') {
        errors.push(`catalog/collectibles.json: "${item.id}" has no unlockedBy.kind, so it can never be unlocked.`);
      }
    }

    // Check-in places may reference a collectible; if they do, it must exist.
    const known = new Set(ids);
    for (const place of collectibles.checkInPlaces?.items ?? []) {
      if (place.collectibleId && !known.has(place.collectibleId)) {
        errors.push(
          `catalog/collectibles.json: check-in place "${place.id}" points at unknown collectible "${place.collectibleId}".`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const files = listJsonFiles(DATA_DIR);

  if (files.length === 0) {
    console.error(`No JSON files found under ${DATA_DIR}`);
    process.exit(1);
  }

  const parsed = new Map();

  for (const path of files) {
    const label = relative(DATA_DIR, path).replace(/\\/g, '/');
    const data = parseOrRecord(path);
    if (data === null) continue;

    parsed.set(label, data);
    checkSchemaVersion(label, data);
  }

  // Per-file invariants. Each is skipped when its file is absent, so this script
  // stays usable while the data set is still being filled in.
  if (parsed.has('rules/garden.json')) checkGarden(parsed.get('rules/garden.json'));
  if (parsed.has('rules/progression.json')) checkProgression(parsed.get('rules/progression.json'));
  if (parsed.has('rules/decisions.json')) checkDecisions(parsed.get('rules/decisions.json'));
  if (parsed.has('rules/geo.json')) checkGeo(parsed.get('rules/geo.json'));
  checkCatalogs(parsed.get('catalog/rewards.json') ?? null, parsed.get('catalog/collectibles.json') ?? null);

  // --- Report ---
  console.log(`Checked ${files.length} data file(s) under ${relative(process.cwd(), DATA_DIR)}`);

  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} warning(s):`);
    for (const warning of warnings) console.warn(`  - ${warning}`);
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log('\nAll data files are valid.');
}

main();
