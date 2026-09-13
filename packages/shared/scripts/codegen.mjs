#!/usr/bin/env node
/**
 * SCRIPT: packages/shared/scripts/codegen.mjs
 *
 * PURPOSE
 *   Generates the Python (Pydantic) and Rust (serde) model files from the JSON
 *   Schemas in ../schemas/. Those schemas are the single source of truth for
 *   every payload that crosses a service boundary; this script is what stops the
 *   four languages from drifting apart.
 *
 * INPUTS  : ../schemas/*.schema.json
 * OUTPUTS : ../generated/python/peapod_models.py
 *           ../generated/rust/models.rs
 *
 * USAGE
 *   node scripts/codegen.mjs           regenerate the files
 *   node scripts/codegen.mjs --check   verify they are up to date, exit 1 if not
 *
 * The --check mode is what a CI job or pre-commit hook should run: it fails if
 * somebody edited a schema without regenerating, which would otherwise show up
 * as a confusing deserialisation error in a different language days later.
 *
 * WHY A HAND-ROLLED GENERATOR
 *   Off-the-shelf tools exist (datamodel-code-generator for Python, typify for
 *   Rust) but each needs its own toolchain installed in its own language, which
 *   makes `npm run codegen` depend on having Python AND Rust set up. These
 *   schemas use a deliberately small slice of JSON Schema -- objects, primitives,
 *   enums, arrays, $ref, nullable unions -- so a focused generator is a few
 *   hundred readable lines and has no dependencies at all. If the schemas ever
 *   need oneOf/allOf composition beyond what is handled below, revisit this.
 *
 * WHAT IS DELIBERATELY NOT GENERATED
 *   The TypeScript types. Those are hand-written in ../src/ because TypeScript
 *   is the language the schemas were authored against, and hand-written types
 *   give far better editor hints (literal unions, branded ids, JSDoc) than any
 *   generator would. The trade is that they can drift; `validateAgainstTypes`
 *   below reports every schema definition that has no matching exported type.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'schemas');
const OUT_PYTHON = join(HERE, '..', 'generated', 'python', 'peapod_models.py');
const OUT_RUST = join(HERE, '..', 'generated', 'rust', 'models.rs');

const CHECK_ONLY = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

/**
 * Loads every schema file, in a stable order.
 *
 * Order matters only for output determinism -- two runs must produce identical
 * bytes, otherwise --check would report spurious drift.
 *
 * @returns An array of `{ file, schema }`, sorted by filename.
 */
function loadSchemas() {
  return readdirSync(SCHEMA_DIR)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
    .map((file) => ({
      file,
      schema: JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')),
    }));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Converts a snake_case or kebab-case name to PascalCase.
 *
 * @param name e.g. `reconstructed_trip`
 * @returns e.g. `ReconstructedTrip`
 */
function toPascalCase(name) {
  return name
    .split(/[_\-\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Extracts the definition name from a `$ref` pointer.
 *
 * Handles both local refs (`#/$defs/Trip`) and cross-file refs
 * (`https://peapod.app/schemas/domain.schema.json#/$defs/ItineraryDay`). Both
 * resolve to the same flat namespace, because the generated output puts every
 * model in a single file per language.
 *
 * @param ref The `$ref` string.
 * @returns The bare definition name, or null when the pointer is not a $defs ref.
 */
function refName(ref) {
  const match = /#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  return match ? match[1] : null;
}

/**
 * Whether a schema node's `type` includes `"null"`.
 *
 * The schemas express nullability as a type union (`"type": ["string", "null"]`)
 * rather than with a separate `nullable` keyword, which is the 2020-12 way.
 *
 * @param node A schema node.
 * @returns True when null is an allowed value.
 */
function isNullable(node) {
  return Array.isArray(node.type) && node.type.includes('null');
}

/**
 * The non-null part of a node's type.
 *
 * @param node A schema node.
 * @returns The primary type string, or undefined when the node has no `type`
 *          (which means it is a `$ref` or a composition).
 */
function primaryType(node) {
  if (Array.isArray(node.type)) return node.type.find((t) => t !== 'null');
  return node.type;
}

/**
 * Collects every `$defs` entry across every schema file into one flat map.
 *
 * @param schemas The loaded schemas.
 * @returns A Map of definition name to its node, plus the file it came from.
 */
function collectDefinitions(schemas) {
  const defs = new Map();

  for (const { file, schema } of schemas) {
    for (const [name, node] of Object.entries(schema.$defs ?? {})) {
      if (defs.has(name)) {
        // A duplicate name across files would silently overwrite one model with
        // another, which is exactly the kind of drift this script exists to
        // prevent. Fail loudly instead.
        throw new Error(
          `Duplicate schema definition "${name}" found in ${file} and ${defs.get(name).file}. ` +
            `Definition names share one flat namespace across all schema files, so they must be unique.`,
        );
      }
      defs.set(name, { file, node });
    }
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Python (Pydantic v2) generation
// ---------------------------------------------------------------------------

/**
 * Maps a schema node to a Python type annotation.
 *
 * @param node    The schema node.
 * @param defs    The flat definition map, used to resolve `$ref`.
 * @returns A Python type expression as a string.
 */
function pythonType(node, defs) {
  // A direct $ref becomes the referenced model's class name.
  if (node.$ref) {
    const name = refName(node.$ref);
    if (name && defs.has(name)) return name;
    // An unresolvable ref falls back to a permissive type rather than emitting
    // a name that would not import.
    return 'Any';
  }

  // A oneOf of [X, null] is how the schemas express an optional nested model.
  if (Array.isArray(node.oneOf)) {
    const inner = node.oneOf.filter((entry) => entry.type !== 'null');
    const nullable = node.oneOf.some((entry) => entry.type === 'null');
    const rendered = inner.length === 1 ? pythonType(inner[0], defs) : 'Any';
    return nullable ? `Optional[${rendered}]` : rendered;
  }

  const base = primaryType(node);
  let rendered;

  switch (base) {
    case 'string':
      // An inline enum becomes a Literal, which Pydantic validates strictly.
      rendered = Array.isArray(node.enum)
        ? `Literal[${node.enum.map((value) => JSON.stringify(value)).join(', ')}]`
        : 'str';
      break;
    case 'integer':
      rendered = 'int';
      break;
    case 'number':
      rendered = 'float';
      break;
    case 'boolean':
      rendered = 'bool';
      break;
    case 'array': {
      const items = node.items ? pythonType(node.items, defs) : 'Any';
      rendered = `List[${items}]`;
      break;
    }
    case 'object':
      // An object with additionalProperties is a map; without, it is an opaque blob.
      rendered = node.additionalProperties
        ? `Dict[str, ${pythonType(node.additionalProperties, defs)}]`
        : 'Dict[str, Any]';
      break;
    default:
      rendered = 'Any';
  }

  return isNullable(node) ? `Optional[${rendered}]` : rendered;
}

/**
 * Renders one Pydantic model class.
 *
 * @param name The definition name, used as the class name.
 * @param node The schema node. Must be an object with `properties`.
 * @param defs The flat definition map.
 * @returns Python source for the class, or null for non-object definitions
 *          (bare enums are emitted as module-level type aliases instead).
 */
function pythonModel(name, node, defs) {
  // A bare string enum is a type alias, not a class.
  if (primaryType(node) === 'string' && Array.isArray(node.enum)) {
    const literals = node.enum.map((value) => JSON.stringify(value)).join(', ');
    const doc = node.description ? `  # ${node.description.split('\n')[0]}` : '';
    return `${name} = Literal[${literals}]${doc}`;
  }

  if (primaryType(node) !== 'object' && !node.properties) return null;

  // `allOf` is used only to mix in the shared audit fields, so flatten those
  // properties in rather than trying to model inheritance.
  const properties = { ...(node.properties ?? {}) };
  const required = new Set(node.required ?? []);

  for (const composed of node.allOf ?? []) {
    const composedName = composed.$ref ? refName(composed.$ref) : null;
    const composedNode = composedName ? defs.get(composedName)?.node : composed;
    if (!composedNode) continue;

    Object.assign(properties, composedNode.properties ?? {});
    for (const field of composedNode.required ?? []) required.add(field);
  }

  const lines = [`class ${name}(BaseModel):`];

  if (node.description) {
    lines.push('    """');
    for (const paragraph of String(node.description).split('\n')) {
      lines.push(`    ${paragraph}`.trimEnd());
    }
    lines.push('    """');
  }

  // Forbid unknown fields: silently accepting an unexpected key is how a
  // renamed field turns into a field that is quietly always its default.
  lines.push('    model_config = ConfigDict(extra="forbid")');
  lines.push('');

  const entries = Object.entries(properties).filter(([key]) => !key.startsWith('_'));
  if (entries.length === 0) {
    lines.push('    pass');
    return lines.join('\n');
  }

  // Required fields must come before defaulted ones in a Python class body.
  const ordered = [
    ...entries.filter(([key]) => required.has(key)),
    ...entries.filter(([key]) => !required.has(key)),
  ];

  for (const [key, propertyNode] of ordered) {
    const annotation = pythonType(propertyNode, defs);
    const comment = propertyNode.description
      ? `  # ${String(propertyNode.description).split('\n')[0]}`
      : '';

    if (required.has(key)) {
      lines.push(`    ${key}: ${annotation}${comment}`);
    } else if (propertyNode.default !== undefined) {
      const literal = JSON.stringify(propertyNode.default);
      // Mutable defaults must go through default_factory or every instance
      // would share one list/dict -- a classic Python footgun.
      if (Array.isArray(propertyNode.default)) {
        lines.push(`    ${key}: ${annotation} = Field(default_factory=list)${comment}`);
      } else if (propertyNode.default !== null && typeof propertyNode.default === 'object') {
        lines.push(`    ${key}: ${annotation} = Field(default_factory=dict)${comment}`);
      } else {
        lines.push(`    ${key}: ${annotation} = ${literal === 'true' ? 'True' : literal === 'false' ? 'False' : literal === 'null' ? 'None' : literal}${comment}`);
      }
    } else {
      const optional = annotation.startsWith('Optional[') ? annotation : `Optional[${annotation}]`;
      lines.push(`    ${key}: ${optional} = None${comment}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generates the whole Python module.
 *
 * @param schemas The loaded schemas.
 * @param defs    The flat definition map.
 * @returns Python source.
 */
function generatePython(schemas, defs) {
  const header = `"""
GENERATED FILE -- DO NOT EDIT BY HAND.

Regenerate with:  npm run codegen  (from packages/shared)
Source of truth:  packages/shared/schemas/*.schema.json

These Pydantic models mirror Peapod's cross-service payload contract. Editing
this file directly will be overwritten, and worse, will make Python disagree
with TypeScript and Rust about what a payload looks like. Change the schema
instead, then regenerate.

Generated from: ${schemas.map((entry) => entry.file).join(', ')}
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

`;

  const blocks = [];

  // Enums (type aliases) first, so the classes that reference them resolve.
  for (const [name, { node }] of defs) {
    if (primaryType(node) === 'string' && Array.isArray(node.enum)) {
      blocks.push(pythonModel(name, node, defs));
    }
  }

  blocks.push('');

  for (const [name, { node }] of defs) {
    if (primaryType(node) === 'string' && Array.isArray(node.enum)) continue;
    const rendered = pythonModel(name, node, defs);
    if (rendered) blocks.push(rendered, '');
  }

  return `${header}${blocks.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Rust (serde) generation
// ---------------------------------------------------------------------------

/**
 * Maps a schema node to a Rust type.
 *
 * @param node The schema node.
 * @param defs The flat definition map.
 * @returns A Rust type expression as a string.
 */
function rustType(node, defs) {
  if (node.$ref) {
    const name = refName(node.$ref);
    if (name && defs.has(name)) return name;
    return 'serde_json::Value';
  }

  if (Array.isArray(node.oneOf)) {
    const inner = node.oneOf.filter((entry) => entry.type !== 'null');
    const nullable = node.oneOf.some((entry) => entry.type === 'null');
    const rendered = inner.length === 1 ? rustType(inner[0], defs) : 'serde_json::Value';
    return nullable ? `Option<${rendered}>` : rendered;
  }

  const base = primaryType(node);
  let rendered;

  switch (base) {
    case 'string':
      rendered = 'String';
      break;
    case 'integer':
      rendered = 'i64';
      break;
    case 'number':
      rendered = 'f64';
      break;
    case 'boolean':
      rendered = 'bool';
      break;
    case 'array': {
      const items = node.items ? rustType(node.items, defs) : 'serde_json::Value';
      rendered = `Vec<${items}>`;
      break;
    }
    case 'object':
      rendered = node.additionalProperties
        ? `std::collections::HashMap<String, ${rustType(node.additionalProperties, defs)}>`
        : 'serde_json::Value';
      break;
    default:
      rendered = 'serde_json::Value';
  }

  return isNullable(node) ? `Option<${rendered}>` : rendered;
}

/**
 * Renders one serde struct (or an enum for a bare string enum).
 *
 * @param name The definition name.
 * @param node The schema node.
 * @param defs The flat definition map.
 * @returns Rust source, or null when the definition is not representable.
 */
function rustModel(name, node, defs) {
  // A bare string enum becomes a real Rust enum with serde renames, so an
  // invalid value fails to deserialise instead of being accepted as a String.
  if (primaryType(node) === 'string' && Array.isArray(node.enum)) {
    const lines = [];
    if (node.description) {
      for (const paragraph of String(node.description).split('\n')) {
        lines.push(`/// ${paragraph}`.trimEnd());
      }
    }
    lines.push('#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]');
    lines.push(`pub enum ${name} {`);
    for (const value of node.enum) {
      if (value === null) continue;
      lines.push(`    #[serde(rename = ${JSON.stringify(value)})]`);
      lines.push(`    ${toPascalCase(String(value))},`);
    }
    lines.push('}');
    return lines.join('\n');
  }

  if (primaryType(node) !== 'object' && !node.properties) return null;

  const properties = { ...(node.properties ?? {}) };
  const required = new Set(node.required ?? []);

  for (const composed of node.allOf ?? []) {
    const composedName = composed.$ref ? refName(composed.$ref) : null;
    const composedNode = composedName ? defs.get(composedName)?.node : composed;
    if (!composedNode) continue;

    Object.assign(properties, composedNode.properties ?? {});
    for (const field of composedNode.required ?? []) required.add(field);
  }

  const lines = [];

  if (node.description) {
    for (const paragraph of String(node.description).split('\n')) {
      lines.push(`/// ${paragraph}`.trimEnd());
    }
  }

  lines.push('#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]');
  lines.push(`pub struct ${name} {`);

  const entries = Object.entries(properties).filter(([key]) => !key.startsWith('_'));

  for (const [key, propertyNode] of entries) {
    if (propertyNode.description) {
      lines.push(`    /// ${String(propertyNode.description).split('\n')[0]}`);
    }

    const type = rustType(propertyNode, defs);
    const isRequired = required.has(key);

    // An optional field with a default deserialises from a missing key; a
    // required one does not, which is what makes a contract violation loud.
    if (!isRequired) {
      lines.push('    #[serde(default)]');
    }

    // Rust keywords cannot be field names, so rename the two that occur.
    const safeKey = key === 'type' ? 'kind' : key;
    if (safeKey !== key) lines.push(`    #[serde(rename = ${JSON.stringify(key)})]`);

    const finalType = isRequired || type.startsWith('Option<') ? type : `Option<${type}>`;
    lines.push(`    pub ${safeKey}: ${finalType},`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Generates the whole Rust module.
 *
 * @param schemas The loaded schemas.
 * @param defs    The flat definition map.
 * @returns Rust source.
 */
function generateRust(schemas, defs) {
  const header = `//! GENERATED FILE -- DO NOT EDIT BY HAND.
//!
//! Regenerate with:  npm run codegen  (from packages/shared)
//! Source of truth:  packages/shared/schemas/*.schema.json
//!
//! These serde structs mirror Peapod's cross-service payload contract. Editing
//! this file directly will be overwritten, and worse, will make Rust disagree
//! with TypeScript and Python about what a payload looks like. Change the
//! schema instead, then regenerate.
//!
//! Generated from: ${schemas.map((entry) => entry.file).join(', ')}

#![allow(dead_code)]

`;

  const blocks = [];

  for (const [name, { node }] of defs) {
    const rendered = rustModel(name, node, defs);
    if (rendered) blocks.push(rendered, '');
  }

  return `${header}${blocks.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Drift reporting against the hand-written TypeScript
// ---------------------------------------------------------------------------

/**
 * Reports schema definitions that have no matching exported TypeScript type.
 *
 * This is a heuristic, not a proof: it greps the barrel export for each
 * definition name. That is enough to catch the common failure -- adding a
 * definition to a schema and forgetting the TypeScript mirror -- without
 * building a TypeScript AST parser into this script.
 *
 * @param defs The flat definition map.
 * @returns An array of definition names with no apparent TypeScript export.
 */
function reportTypeScriptDrift(defs) {
  const indexPath = join(HERE, '..', 'src', 'index.ts');
  if (!existsSync(indexPath)) return [];

  const barrel = readFileSync(indexPath, 'utf8');
  const missing = [];

  for (const name of defs.keys()) {
    // AuditFields-style helpers and inline request wrappers are exported under
    // the same name, so a plain substring check is sufficient.
    if (!barrel.includes(name)) missing.push(name);
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const schemas = loadSchemas();
  if (schemas.length === 0) {
    console.error(`No schema files found in ${SCHEMA_DIR}`);
    process.exit(1);
  }

  const defs = collectDefinitions(schemas);

  const python = generatePython(schemas, defs);
  const rust = generateRust(schemas, defs);

  const targets = [
    { path: OUT_PYTHON, content: python, label: 'Python' },
    { path: OUT_RUST, content: rust, label: 'Rust' },
  ];

  if (CHECK_ONLY) {
    let stale = false;

    for (const { path, content, label } of targets) {
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (existing !== content) {
        console.error(`STALE: ${label} models are out of date (${path}).`);
        stale = true;
      }
    }

    const drift = reportTypeScriptDrift(defs);
    if (drift.length > 0) {
      console.warn(
        `WARNING: ${drift.length} schema definition(s) have no matching TypeScript export: ${drift.join(', ')}`,
      );
    }

    if (stale) {
      console.error('\nRun `npm run codegen` from packages/shared and commit the result.');
      process.exit(1);
    }

    console.log(`Generated models are up to date (${defs.size} definitions).`);
    return;
  }

  for (const { path, content, label } of targets) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    console.log(`Wrote ${label} models -> ${path}`);
  }

  const drift = reportTypeScriptDrift(defs);
  if (drift.length > 0) {
    console.warn(
      `\nWARNING: ${drift.length} schema definition(s) have no matching TypeScript export in src/index.ts:`,
    );
    for (const name of drift) console.warn(`  - ${name}`);
    console.warn('Add the hand-written mirror in src/ so TypeScript stays in step.');
  }

  console.log(`\nDone. ${defs.size} definitions across ${schemas.length} schema file(s).`);
}

main();
