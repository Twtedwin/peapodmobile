/**
 * MODULE: services/api/src/env
 *
 * PURPOSE
 *   Load and validate process environment once at boot. Every other module
 *   imports `env` from here rather than reading `process.env` itself, so a
 *   missing or malformed value fails in one place with a loud message instead
 *   of surfacing as a cryptic ECONNREFUSED three layers down.
 *
 * INPUTS  : `process.env`, plus the repo-root `.env` when a variable is unset.
 *           npm workspace scripts run with cwd `services/api`, so we walk up
 *           to the monorepo root rather than looking for `.env` only in cwd.
 * OUTPUTS : a frozen `env` object of typed, defaulted settings
 *
 * WHY FAIL LOUD ON DATABASE_URL
 *   This service owns the domain database. Starting without a connection
 *   string would boot a Fastify process that 500s every real request. Better
 *   to refuse to start and print the variable name than to look healthy.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rewrite `localhost` to IPv4 loopback.
 *
 * On Windows, `localhost` often resolves to `::1` while uvicorn is bound to
 * `127.0.0.1` (or a leftover process is still listening on IPv6). The two
 * sockets do not share the in-memory auth rate-limiter, so the API can 429
 * while a curl to 127.0.0.1:8081 still succeeds.
 */
function loopbackHttp(url: string): string {
  return url.replace(/\/$/, '').replace('://localhost', '://127.0.0.1');
}

/**
 * Load KEY=VALUE pairs from the first existing candidate `.env`.
 * Existing process.env keys win, so a shell export still overrides the file.
 */
function loadRepoDotenv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../.env'),
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
  ];
  const file = candidates.find((path) => existsSync(path));
  if (!file) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

loadRepoDotenv();

/** Parse a boolean-ish env flag. `"false"`, `"0"`, `"no"` are false; everything else truthy is true. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback;
  const normalised = raw.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
  return fallback;
}

/** Split a comma-separated origin list, trimming blanks. */
function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw == null || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Require a variable or throw a message that names it. */
function required(name: string): string {
  const value = process.env[name];
  if (value == null || value.trim() === '') {
    throw new Error(
      `${name} is required. The API owns the domain database and cannot start without a working ${name}.`,
    );
  }
  return value;
}

/** Optional string; empty becomes the fallback. */
function optional(name: string, fallback: string): string {
  const value = process.env[name];
  if (value == null || value.trim() === '') return fallback;
  return value;
}

/** Optional string that may legitimately be unset. */
function maybe(name: string): string | undefined {
  const value = process.env[name];
  if (value == null || value.trim() === '') return undefined;
  return value;
}

const PORT = Number.parseInt(optional('PORT', '8080'), 10);
if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`PORT must be a TCP port number, got ${process.env.PORT}`);
}

/**
 * Typed runtime configuration.
 *
 * Secrets (INTERNAL_SERVICE_TOKEN, S3_SECRET_ACCESS_KEY, LLM_API_KEY) live
 * here only long enough to be passed to the clients that need them. Nothing
 * in this object is logged.
 */
export const env = Object.freeze({
  /** HTTP listen port. Default 8080 to match docker-compose and the mobile client's assumed API port. */
  PORT,

  /** Postgres connection string. Shared instance; this service owns the domain tables only. */
  DATABASE_URL: required('DATABASE_URL'),

  /** Base URL of the Python security service (no trailing slash). IPv4 loopback avoids Windows localhost → ::1 hitting a different process. */
  SECURITY_URL: loopbackHttp(optional('SECURITY_URL', 'http://127.0.0.1:8081')),

  /**
   * Shared secret sent as `X-Internal-Token` on every `/internal/*` call.
   * This is the ONLY authentication on that surface -- never expose it on a
   * public network.
   */
  INTERNAL_SERVICE_TOKEN: optional('INTERNAL_SERVICE_TOKEN', 'dev-only-insecure-internal-service-token'),

  /** Base URL of the Rust compute service (no trailing slash). */
  COMPUTE_URL: loopbackHttp(optional('COMPUTE_URL', 'http://127.0.0.1:8082')),

  /**
   * When false, skip the HTTP hop entirely and always use the TypeScript
   * fallback in `src/compute/fallback.ts`. Defaults to false so a first run
   * does not require the Rust container. Set COMPUTE_ENABLED=true after
   * `docker compose up -d compute` to use the Rust maths path.
   */
  COMPUTE_ENABLED: parseBool(process.env.COMPUTE_ENABLED, false),

  /** Allowed CORS origins. `"*"` is a development convenience for Expo's shifting LAN address. */
  CORS_ORIGINS: parseList(process.env.CORS_ORIGINS, ['*']),

  // -- Object storage (optional; uploads return 503 when unset) ------------
  S3_ENDPOINT: maybe('S3_ENDPOINT'),
  S3_REGION: optional('S3_REGION', 'auto'),
  S3_BUCKET: optional('S3_BUCKET', 'peapod-media'),
  S3_ACCESS_KEY_ID: maybe('S3_ACCESS_KEY_ID'),
  S3_SECRET_ACCESS_KEY: maybe('S3_SECRET_ACCESS_KEY'),
  S3_PUBLIC_BASE_URL: maybe('S3_PUBLIC_BASE_URL'),

  // -- LLM (optional; compromise suggestions fall back to shared algorithms)
  LLM_PROVIDER: optional('LLM_PROVIDER', 'none'),
  LLM_API_KEY: maybe('LLM_API_KEY'),
  LLM_MODEL: maybe('LLM_MODEL'),

  // -- Routing / geocoding (optional; stored so later routes can pick them up)
  /** Road-snapping router. Unset means trip lines stay as the smoothed GPS trace. */
  OSRM_URL: maybe('OSRM_URL'),
  /** Server-side Maps key, restricted by IP. Unused by the core routes today. */
  GOOGLE_MAPS_SERVER_API_KEY: maybe('GOOGLE_MAPS_SERVER_API_KEY'),

  NODE_ENV: optional('NODE_ENV', 'development'),
});

export type Env = typeof env;
