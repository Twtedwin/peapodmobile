/**
 * MODULE: services/api/src/db/client
 *
 * PURPOSE
 *   The single Postgres connection and the Drizzle handle every route and job
 *   share. Instantiated at import time so a missing DATABASE_URL fails at
 *   boot (via `env.ts`) rather than on the first query.
 *
 * INPUTS  : `env.DATABASE_URL`
 * OUTPUTS : `sqlClient` (postgres.js) and `db` (drizzle-orm)
 *
 * WHY POSTGRES.JS
 *   One lightweight tagged-template driver, no connection-pool ceremony, and
 *   first-class ESM. drizzle-orm 0.44's `postgres-js` dialect sits on top of
 *   it. `max: 10` is enough for a single-node API plus the scheduled jobs.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import { schema } from './schema.js';

/**
 * Raw postgres.js client. Used by `ensureSchema()` to run the multi-statement
 * bootstrap.sql (Drizzle's `db.execute` is one statement at a time).
 */
export const sqlClient = postgres(env.DATABASE_URL, {
  max: 10,
  // Prepare-once is a win for the hot ping insert; it is a footgun for the
  // bootstrap script which sends a different statement every time.
  prepare: false,
});

/** Drizzle query builder bound to the domain schema. */
export const db = drizzle(sqlClient, { schema, logger: env.NODE_ENV === 'development' });
