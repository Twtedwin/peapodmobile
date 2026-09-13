/**
 * Drizzle Kit configuration.
 *
 * PURPOSE
 *   Tells `drizzle-kit generate` where the TypeScript table definitions live
 *   and where to write SQL migrations. `db:migrate` / `ensureSchema()` then
 *   apply those files if the `drizzle/` folder exists.
 *
 * WHY THIS FILE SITS AT THE SERVICE ROOT
 *   drizzle-kit looks for `drizzle.config.ts` next to the package.json it was
 *   invoked from. Paths below are therefore relative to `services/api/`.
 */
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit against this database.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
});
