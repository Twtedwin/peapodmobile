/**
 * MODULE: services/api/src/auth/plugin
 *
 * PURPOSE
 *   Fastify preHandler that turns `Authorization: Bearer ...` into
 *   `request.user`. Public routes (`/health`, `/ready`) skip the check;
 *   the websocket at `/realtime` authenticates via its first message
 *   instead, so it is also skipped here.
 *
 * INPUTS  : the raw request
 * OUTPUTS : `request.user = { id, email, role, display_name }`
 *
 * WHY LOOK UP display_name LOCALLY
 *   The security service's verify-token response is the signed JWT claims,
 *   which do not include the profile display name (it changes, the token
 *   does not). We join against `users` after verification. If the profile
 *   row is missing -- a race with registration -- we fall back to the
 *   email local-part rather than 500ing a brand-new account.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { unauthorized } from '../http.js';
import { verifyToken } from './securityClient.js';
import type { AuthUser } from '../types.js';

/** Exact paths that anyone may hit without a bearer token. */
const PUBLIC_PATHS = new Set(['/health', '/ready', '/realtime']);

function isPublic(request: FastifyRequest): boolean {
  const path = (request.url.split('?')[0] ?? '').replace(/\/$/, '') || '/';
  // Auth is proxied to the security service, which enforces its own Bearer
  // requirement on /auth/me and friends. This process must not 401 first.
  if (path === '/auth' || path.startsWith('/auth/')) return true;
  return PUBLIC_PATHS.has(path);
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request) => {
    if (isPublic(request)) return;
    // CORS preflight never carries credentials worth verifying.
    if (request.method === 'OPTIONS') return;

    const token = extractBearer(request.headers.authorization);
    if (!token) throw unauthorized('Missing Authorization: Bearer token');

    const principal = await verifyToken(token);

    const profile = await db
      .select({ display_name: users.display_name, role: users.role, email: users.email })
      .from(users)
      .where(eq(users.id, principal.user_id))
      .limit(1);

    const row = profile[0];
    const user: AuthUser = {
      id: principal.user_id,
      email: row?.email ?? principal.email,
      role: row?.role === 'admin' || principal.role === 'admin' ? 'admin' : 'user',
      display_name: row?.display_name ?? principal.display_name ?? principal.email.split('@')[0] ?? 'member',
    };
    request.user = user;
  });
}
