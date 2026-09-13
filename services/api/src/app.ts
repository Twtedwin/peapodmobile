/**
 * MODULE: services/api/src/app
 *
 * PURPOSE
 *   Compose the Fastify instance: CORS, websocket, rate-limit, auth, routes.
 *   Split from `index.ts` so tests can `inject()` without opening a TCP port
 *   or starting cron jobs.
 *
 * INPUTS  : env.ts
 * OUTPUTS : a Fastify instance ready to listen or to inject
 * CONSUMED BY : src/index.ts (listen), test/endpoints.test.ts (inject)
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { HttpError } from './http.js';
import { registerAuth } from './auth/plugin.js';
import { registerAuthProxy } from './routes/authProxy.js';
import { registerRealtime } from './realtime/hub.js';
import { registerHealth } from './routes/health.js';
import { registerPods } from './routes/pods.js';
import { registerDomain } from './routes/domain.js';
import { registerCompute } from './routes/compute.js';
import { registerUploads } from './routes/uploads.js';
import { registerAi } from './routes/ai.js';

export interface BuildAppOptions {
  /** Tests pass false so pino-pretty does not drown assertion output. */
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const useLogger = options.logger ?? env.NODE_ENV !== 'test';
  const app = Fastify({
    logger: useLogger
      ? {
          level: env.NODE_ENV === 'production' ? 'info' : 'debug',
          transport:
            env.NODE_ENV === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
        }
      : false,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.includes('*') ? true : env.CORS_ORIGINS,
    credentials: true,
  });

  // Inject tests fire more than 300 requests in one process. The production
  // cap still applies when the API is actually listening.
  if (env.NODE_ENV !== 'test') {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      // The websocket upgrade is long-lived; counting it as a request per
      // frame would lock a member out of their own chat.
      allowList: (request) => (request.url.split('?')[0] ?? '') === '/realtime',
    });
  }

  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        details: error.details ?? undefined,
      });
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    request.log.error({ err: error }, 'unhandled');
    return reply.code(status).send({
      error: status >= 500 ? 'Internal server error' : error.message,
    });
  });

  await registerAuthProxy(app);
  await registerAuth(app);
  await registerRealtime(app);
  await registerHealth(app);
  await registerPods(app);
  await registerDomain(app);
  await registerCompute(app);
  await registerUploads(app);
  await registerAi(app);

  return app;
}
