/**
 * MODULE: services/api/src/index
 *
 * PURPOSE
 *   Boot the API process: ensure the domain schema exists, start scheduled
 *   jobs, then listen. The Fastify composition lives in `app.ts` so tests
 *   can inject without this side effect.
 *
 * INPUTS  : env.ts
 * OUTPUTS : an HTTP + WebSocket server on PORT (default 8080)
 */

import { env } from './env.js';
import { ensureSchema } from './db/ensure.js';
import { sqlClient } from './db/client.js';
import { startJobs } from './jobs/index.js';
import { buildApp } from './app.js';

export { buildApp } from './app.js';

async function main(): Promise<void> {
  await ensureSchema();
  const app = await buildApp();
  startJobs();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`API listening on ${env.PORT}`);
}

main().catch(async (err: unknown) => {
  console.error('API failed to start:', err);
  await sqlClient.end({ timeout: 2 }).catch(() => undefined);
  process.exit(1);
});
