/**
 * MODULE: services/api/src/auth/securityClient
 *
 * PURPOSE
 *   The ONLY outbound client that talks to the Python security service.
 *   Every access token the API sees is forwarded here; this process holds
 *   no signing key and cannot mint or introspect JWTs itself.
 *
 * INPUTS  : a bearer token, or an authorize request
 * OUTPUTS : a verified principal, or an allow/deny decision
 *
 * WHY NO CACHE
 *   Access tokens last 15 minutes and an authorize check is about LIVE
 *   membership/role. Caching either would let a kicked member keep writing
 *   until the TTL expired -- exactly the stale-role problem the security
 *   service's own comments warn about. Round-trip every time; it is a
 *   local hop on the compose network.
 */

import { env } from '../env.js';
import { unauthorized, unavailable } from '../http.js';

export interface VerifiedPrincipal {
  user_id: string;
  email: string;
  role: 'admin' | 'user';
  jti?: string;
  display_name?: string;
}

export interface AuthorizeRequest {
  user_id: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  pod_id?: string;
}

function internalHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'X-Internal-Token': env.INTERNAL_SERVICE_TOKEN,
  };
}

/**
 * POST /internal/verify-token
 *
 * The security service verifies the JWT and returns the signed claims.
 * A 401 here is "this token is garbage"; a network failure is 503 so the
 * client retries rather than treating it as a logout.
 */
export async function verifyToken(token: string): Promise<VerifiedPrincipal> {
  let response: Response;
  try {
    response = await fetch(`${env.SECURITY_URL}/internal/verify-token`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    throw unavailable(
      `Security service unreachable at ${env.SECURITY_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw unauthorized('Invalid or expired access token');
  }
  if (!response.ok) {
    throw unavailable(`Security service returned ${response.status} from /internal/verify-token`);
  }

  const body = (await response.json()) as VerifiedPrincipal;
  if (!body?.user_id || !body.email) {
    throw unauthorized('Security service returned an incomplete principal');
  }
  return {
    user_id: body.user_id,
    email: body.email,
    role: body.role === 'admin' ? 'admin' : 'user',
    jti: body.jti,
    display_name: body.display_name,
  };
}

/**
 * POST /internal/authorize
 *
 * Asks the security service to confirm a privileged action against live
 * data (not the snapshot frozen into the access token). Returns false on
 * an explicit deny. A down/missing endpoint falls back to `null` so the
 * caller can apply local row-level rules -- the security service's
 * authorize route may not be up in every development layout.
 */
export async function authorize(request: AuthorizeRequest): Promise<boolean | null> {
  let response: Response;
  try {
    response = await fetch(`${env.SECURITY_URL}/internal/authorize`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({
        user_id: request.user_id,
        action: request.action,
        resource: {
          kind: request.resource_type ?? 'pod',
          id: request.resource_id ?? request.pod_id ?? null,
          pod_id: request.pod_id ?? request.resource_id ?? null,
        },
      }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return null;
  }

  // 404: old security binary without this route. 422: body shape drift.
  // Both fall through to the API's local Seed check instead of a hard 403.
  if (response.status === 404 || response.status === 422) return null;
  if (!response.ok) return false;

  const body = (await response.json()) as { allowed?: boolean };
  return body.allowed === true;
}
