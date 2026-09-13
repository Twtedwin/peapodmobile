/**
 * MODULE: services/api/src/db/ensure
 *
 * PURPOSE
 *   Bring the domain schema up to date at process start without requiring an
 *   interactive drizzle-kit session. Two strategies, tried in order:
 *
 *     1. If a `drizzle/` folder of generated migrations exists, apply them
 *        with drizzle-orm's postgres-js migrator.
 *     2. Always also run `src/db/bootstrap.sql` (`CREATE TABLE IF NOT EXISTS`
 *        for every table). This is the reliable local-dev path and is
 *        idempotent, so running it after (1) is a no-op on a fully migrated
 *        database.
 *
 * INPUTS  : the live Postgres connection from `./client.ts`
 * OUTPUTS : a fully created schema, or a thrown error that names the failure
 *
 * WHY BOTH
 *   Generated migrations are the production-correct way to evolve a live
 *   database. `bootstrap.sql` is what makes `docker compose up` and a fresh
 *   laptop work on the first boot, before anyone has run `db:generate`.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve a file that may live next to this module (tsx or dist/) or under cwd. */
function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Apply pending drizzle-kit migrations when the `drizzle/` folder is present.
 *
 * @returns true when migrations ran (or the folder existed and was empty)
 */
export async function migrateIfPresent(): Promise<boolean> {
  const folder = firstExisting([
    join(here, '../../drizzle'),
    join(process.cwd(), 'drizzle'),
    join(process.cwd(), 'services/api/drizzle'),
  ]);
  if (!folder) return false;

  await migrate(db, { migrationsFolder: folder });
  return true;
}

/**
 * Execute the hand-written bootstrap.sql. Every statement is IF NOT EXISTS,
 * so this is safe to call on every boot.
 */
export async function pushSchema(): Promise<void> {
  const sqlPath = firstExisting([
    join(here, 'bootstrap.sql'),
    join(process.cwd(), 'src/db/bootstrap.sql'),
    join(process.cwd(), 'dist/db/bootstrap.sql'),
    join(process.cwd(), 'services/api/src/db/bootstrap.sql'),
  ]);
  if (!sqlPath) {
    throw new Error(
      'bootstrap.sql is missing. Expected it next to src/db/ensure.ts (or copied to dist/db/ in production).',
    );
  }

  const sqlText = await readFile(sqlPath, 'utf8');
  // postgres.js `unsafe` runs the whole script, including multiple statements.
  await sqlClient.unsafe(sqlText);
}

/**
 * The function `src/index.ts` calls during boot. Migrations first (if any),
 * then the idempotent CREATE TABLE script so a brand-new database is usable
 * even when no migrations have been generated yet.
 */
export async function ensureSchema(): Promise<void> {
  await migrateIfPresent();
  await pushSchema();
}
