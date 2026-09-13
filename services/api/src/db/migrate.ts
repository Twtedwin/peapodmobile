/**
 * MODULE: services/api/src/db/migrate
 *
 * PURPOSE
 *   CLI entry point for `npm run db:migrate`. Applies drizzle-kit migrations
 *   when present, then the idempotent bootstrap.sql, then exits.
 *
 * INPUTS  : DATABASE_URL (via env.ts)
 * OUTPUTS : a schema-ready database, process exit 0 or 1
 */

import { ensureSchema } from './ensure.js';
import { sqlClient } from './client.js';

async function main(): Promise<void> {
  await ensureSchema();
  console.log('Schema is up to date.');
  await sqlClient.end({ timeout: 5 });
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exitCode = 1;
  void sqlClient.end({ timeout: 5 });
});
