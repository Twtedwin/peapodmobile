/**
 * MODULE: apps/mobile/src/api/client.ts
 *
 * PURPOSE
 *   The only HTTP client the app uses. Every call — auth included — goes to
 *   services/api. The API reverse-proxies `/auth/*` onto the Python security
 *   service so this process never holds a password hash.
 *
 * INPUTS
 *   - EXPO_PUBLIC_API_URL, inlined by Expo at bundle time
 *   - access + refresh tokens from the session store
 *
 * OUTPUTS : JSON bodies, or an ApiError
 * CONSUMED BY : every screen and hook that talks to the network
 */

import type { AuthenticatedUser } from '@/models/api';
import { useSession } from '@/store/session';

const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
if (!configuredApiUrl) {
  throw new Error(
    'EXPO_PUBLIC_API_URL is required. Set it to the API origin in .env before starting or building Peapod.',
  );
}

/** One deploy-time origin for local Wi-Fi, staging, and production. */
export const apiUrl: string = configuredApiUrl.replace(/\/$/, '');

/**
 * Auth base. Same origin as the API: Fastify proxies `/auth/*` to the
 * security service. A second URL would violate "the app talks only to the API".
 */
export const authBaseUrl: string = apiUrl;

export const websocketUrl: string = (
  process.env.EXPO_PUBLIC_WEBSOCKET_URL?.trim() || apiUrl.replace(/^http/, 'ws')
).replace(/\/$/, '');

/**
 * A failed request, with enough context for a retry button and nothing that
 * would leak a token into a log.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(message: string, status: number, path: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** JSON we expect back from /auth/login, /auth/register verify, /auth/refresh. */
export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

export type AuthUser = AuthenticatedUser;

export interface AuthResponse extends TokenPair {
  user: AuthUser;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RequestOptions {
  method?: Method;
  body?: unknown;
  /** When true, the request is sent to authBaseUrl instead of apiUrl. */
  auth?: boolean;
  /** Skip the Authorization header (login, register, refresh itself). */
  anonymous?: boolean;
  /** Skip the 401 → refresh → retry cycle (the refresh call itself). */
  skipRefresh?: boolean;
  signal?: AbortSignal;
  /** Maximum wall-clock wait in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;
}

let refreshInFlight: Promise<boolean> | null = null;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Pulls a human message out of a JSON error body.
 *
 * Fastify, FastAPI, and our own `{ error: { message } }` envelopes all show
 * up in the wild; we try them in that order and fall back to the HTTP status.
 */
function messageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.detail === 'string') return record.detail;
  if (record.detail && typeof record.detail === 'object') {
    const inner = record.detail as Record<string, unknown>;
    if (typeof inner.detail === 'string') return inner.detail;
    if (inner.email_sent !== undefined || inner.detail === 'email not verified') {
      return 'Verify your email first. We sent a new 6-digit code.';
    }
  }
  if (record.error && typeof record.error === 'object') {
    const inner = record.error as Record<string, unknown>;
    if (typeof inner.message === 'string') return inner.message;
  }
  if (Array.isArray(record.detail) && record.detail[0] && typeof record.detail[0] === 'object') {
    const first = record.detail[0] as Record<string, unknown>;
    if (typeof first.msg === 'string') return first.msg;
  }
  return fallback;
}

/**
 * Reads JSON if the response has a JSON content type, otherwise null.
 * A 204 or an HTML error page must not crash the parser.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Normalises the several token-envelope shapes the security service (and a
 * future API proxy) might return into a flat `{ access_token, refresh_token, user }`.
 */
export function normaliseAuth(raw: unknown): AuthResponse {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tokens = (record.tokens && typeof record.tokens === 'object'
    ? record.tokens
    : record) as Record<string, unknown>;
  const access = String(tokens.access_token ?? tokens.accessToken ?? '');
  const refresh = String(tokens.refresh_token ?? tokens.refreshToken ?? '');
  const userRaw = (record.user ?? record.profile ?? record) as Record<string, unknown>;
  const user: AuthUser = {
    id: String(userRaw.id ?? ''),
    email: String(userRaw.email ?? ''),
    display_name: String(userRaw.display_name ?? userRaw.displayName ?? userRaw.email ?? 'Pea'),
    avatar_url: (userRaw.avatar_url as string | null | undefined) ?? (userRaw.avatarUrl as string | null | undefined) ?? null,
    permissions_granted: Boolean(userRaw.permissions_granted ?? userRaw.permissionsGranted ?? false),
    role: userRaw.role === 'admin' ? 'admin' : 'user',
  };
  return { access_token: access, refresh_token: refresh, user };
}

/**
 * Rotates the refresh token. Single-flight: two 401s at once share one refresh
 * so we cannot burn a one-time refresh token twice and lock the user out.
 */
async function rotateRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refreshToken, applyTokens, signOut } = useSession.getState();
    if (!refreshToken) {
      await signOut();
      return false;
    }
    try {
      const data = await request<unknown>('/auth/refresh', {
        method: 'POST',
        auth: true,
        anonymous: true,
        skipRefresh: true,
        body: { refresh_token: refreshToken },
      });
      const pair = normaliseAuth(data);
      if (!pair.access_token) {
        await signOut();
        return false;
      }
      await applyTokens(pair.access_token, pair.refresh_token || refreshToken, pair.user.id ? pair.user : undefined);
      return true;
    } catch {
      await signOut();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Low-level fetch. Screens should prefer the typed helpers below.
 *
 * @param path Absolute path beginning with `/`.
 * @param options Method, body, auth-vs-data, abort.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    auth = false,
    anonymous = false,
    skipRefresh = false,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const base = auth ? authBaseUrl : apiUrl;
  const url = `${base.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const token = useSession.getState().accessToken;
  if (!anonymous && token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    const timedOut = controller.signal.aborted && !signal?.aborted;
    const reason = timedOut
      ? `Request timed out after ${timeoutMs} ms`
      : cause instanceof Error
        ? cause.message
        : 'Network request failed';
    throw new ApiError(
      `Could not reach Peapod (${reason}). Check EXPO_PUBLIC_API_URL and that the API is running.`,
      0,
      path,
      null,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  const parsed = await readBody(response);

  if (response.status === 401 && !skipRefresh && !anonymous) {
    const refreshed = await rotateRefresh();
    if (refreshed) {
      return request<T>(path, { ...options, skipRefresh: true });
    }
  }

  if (!response.ok) {
    throw new ApiError(
      messageFromBody(parsed, `Request failed (${response.status})`),
      response.status,
      path,
      parsed,
    );
  }

  return parsed as T;
}

/** GET against the data API. */
export const apiGet = <T>(path: string, signal?: AbortSignal) =>
  request<T>(path, { method: 'GET', signal });

/** POST against the data API. */
export const apiPost = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body });

/** PATCH against the data API. */
export const apiPatch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body });

/** DELETE against the data API. */
export const apiDelete = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/** POST against the auth base (security service, or API proxy). */
export const authPost = <T>(path: string, body?: unknown, anonymous = true) =>
  request<T>(path, { method: 'POST', body, auth: true, anonymous });

/** GET against the auth base. Sends the access token. */
export const authGet = <T>(path: string) =>
  request<T>(path, { method: 'GET', auth: true, anonymous: false });

/** PATCH against the auth base. Sends the access token. */
export const authPatch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body, auth: true, anonymous: false });

/**
 * Unwraps a payload that may be a bare array/object or nested under one of
 * several conventional keys (`items`, `data`, `members`, …). APIs in flux
 * during the rewrite disagree on envelopes; this keeps screens from crashing.
 */
export function unwrap<T>(raw: unknown, keys: string[]): T {
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of keys) {
      if (key in record && record[key] !== undefined) return record[key] as T;
    }
  }
  return raw as T;
}

/**
 * Coerces whatever the members endpoint returned into a flat list.
 */
export function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of ['items', 'data', 'members', 'results', 'rows']) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}
