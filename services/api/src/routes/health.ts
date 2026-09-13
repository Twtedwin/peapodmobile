/**
 * MODULE: services/api/src/routes/health
 *
 * PURPOSE
 *   Liveness (`/health`) and readiness (`/ready`). Load balancers and
 *   docker-compose healthchecks hit these; they must stay unauthenticated.
 *
 *   /health  -- the process is answering. No dependency checks.
 *   /ready   -- Postgres accepted `select 1`. Fail this and traffic stays off.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export async function registerHealth(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'api', version: '1.0.0' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ready' };
    } catch (err) {
      reply.code(503);
      return {
        status: 'not_ready',
        reason: err instanceof Error ? err.message : 'database unreachable',
      };
    }
  });
}
