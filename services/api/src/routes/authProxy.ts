/**
 * MODULE: services/api/src/routes/authProxy
 *
 * PURPOSE
 *   Reverse-proxy `/auth/*` onto the Python security service so the mobile
 *   app has a single origin (this API). Credentials never land in this
 *   process: the body is forwarded as bytes and the response is echoed.
 *
 * INPUTS  : whatever the client posted to `/auth/...`
 * OUTPUTS : the security service's status, headers, and body, unmodified
 *
 * WHY A PROXY INSTEAD OF DUPLICATING AUTH HERE
 *   The security service is the only process allowed to touch password
 *   hashes. Reimplementing login in Node would put hashes in a second
 *   codebase. Forwarding keeps that boundary and still honours "the app
 *   talks only to services/api".
 *
 * PUBLIC
 *   These routes are excluded from the Bearer hook in `auth/plugin.ts`.
 *   `/auth/me` and `/auth/delete-account` still require a token -- the
 *   security service enforces that; we just pass the Authorization header
 *   through.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { unavailable } from '../http.js';

/** Headers that must not be copied hop-to-hop. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Only the headers security actually needs. Copying the full inbound set (Accept-Encoding, Expect, Connection leftovers) has made undici `fetch` fail on Windows loopback. */
const FORWARD_ALLOW = new Set(['authorization', 'content-type', 'x-request-id', 'x-internal-token']);

function forwardHeaders(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value !== 'string') continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (!FORWARD_ALLOW.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

export async function registerAuthProxy(app: FastifyInstance): Promise<void> {
  app.all('/auth', proxy);
  app.all('/auth/*', proxy);
}

async function proxy(request: FastifyRequest, reply: import('fastify').FastifyReply) {
  const target = `${env.SECURITY_URL}${request.url}`;
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const headers = forwardHeaders(request);
  if (hasBody && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error && 'cause' in err && err.cause instanceof Error ? err.cause.message : '';
    request.log.warn(
      { err, target, securityUrl: env.SECURITY_URL },
      'auth proxy could not reach the security service',
    );
    throw unavailable(
      `Security service unreachable at ${env.SECURITY_URL}: ${err instanceof Error ? err.message : String(err)}${cause ? ` (${cause})` : ''}`,
    );
  }

  reply.code(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    // Fastify sets content-length itself from the payload we send.
    if (key.toLowerCase() === 'content-encoding') return;
    reply.header(key, value);
  });

  const location = upstream.headers.get('location');
  if (location) reply.header('location', location);

  const buf = Buffer.from(await upstream.arrayBuffer());
  return reply.send(buf);
}
