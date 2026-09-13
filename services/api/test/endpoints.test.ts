/**
 * MODULE: services/api/test/endpoints.test.ts
 *
 * PURPOSE
 *   Hit every public HTTP route the mobile app uses, against the running API
 *   (which proxies `/auth/*` to the security service). Failures here are the
 *   same 4xx/5xx a phone would see.
 *
 * INPUTS
 *   - API at `API_URL` (default http://127.0.0.1:8080)
 *   - Postgres (for planting a known OTP hash during the register test)
 *   - Demo accounts from `npm run db:seed` + `npm run seed:security`
 *
 * OUTPUTS : pass / fail
 *
 * HOW TO RUN
 *   docker compose up -d postgres
 *   npm run dev:security   # must be a fresh process; a leftover uvicorn on
 *                          # 8081 keeps the in-memory limiter and will 429
 *   npm test --workspace @peapod/api
 *
 *   Default mode injects into Fastify in-process (does not bind 8080).
 *   PEAPOD_LIVE_API=1 hits API_URL instead (default http://127.0.0.1:8080).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { sqlClient } from '../src/db/client.js';
import { publish } from '../src/realtime/hub.js';

const API = (process.env.API_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const USE_LIVE = process.env.PEAPOD_LIVE_API === '1';
const SEED_POD = '00000000-0000-0000-0000-0000000000aa';
const DEMO_A = { email: 'alex@peapod.local', password: 'peapod-demo-12' };
const DEMO_B = { email: 'sarah@peapod.local', password: 'peapod-demo-12' };
const NEW_PASSWORD = 'peapod-test-12';
const OTP = '123456';

const here = dirname(fileURLToPath(import.meta.url));
const securityRoot = resolve(here, '../../security');
const pythonCandidates = [
  resolve(securityRoot, '.venv/Scripts/python.exe'),
  resolve(securityRoot, '.venv/bin/python'),
];

interface CallOptions {
  token?: string;
  body?: unknown;
  status?: number;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; json: unknown; text: string }> {
  let status: number;
  let text: string;
  if (app) {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      payload: options.body as never,
    });
    status = response.statusCode;
    text = response.body;
  } else {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    status = response.status;
    text = await response.text();
  }
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
  }
  const expected = options.status ?? 200;
  expect(status, `${method} ${path} → ${text.slice(0, 500)}`).toBe(expected);
  if (expected === 200 || expected === 201) {
    expect(
      json !== null && typeof json === 'object',
      `${method} ${path} must return a JSON object or array`,
    ).toBe(true);
  }
  return { status, json, text };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected object, got ${String(textPreview(value))}`);
  }
  return value as Record<string, unknown>;
}

function textPreview(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value);
  }
}

function asId(value: unknown): string {
  const id = asRecord(value).id;
  if (typeof id !== 'string') throw new Error(`missing id in ${textPreview(value)}`);
  return id;
}

function pythonBin(): string | null {
  return pythonCandidates.find((path) => existsSync(path)) ?? null;
}

function hashOtp(code: string): string {
  const bin = pythonBin();
  if (!bin) throw new Error('services/security/.venv Python is missing; cannot plant an OTP hash');
  return execFileSync(
    bin,
    ['-c', `from app.security.otp import hash_code; print(hash_code(${JSON.stringify(code)}), end='')`],
    { cwd: securityRoot, encoding: 'utf8' },
  ).trim();
}

async function plantOtp(userId: string, code: string): Promise<void> {
  const hash = hashOtp(code);
  const rows = await sqlClient`
    update otp_codes
    set code_hash = ${hash}, attempt_count = 0, consumed_at = null
    where id = (
      select id from otp_codes
      where user_id = ${userId}::uuid
      order by created_at desc
      limit 1
    )
    returning id
  `;
  if (rows.length === 0) throw new Error(`register did not insert otp_codes for ${userId}`);
}

async function login(email: string, password: string): Promise<{ token: string; refresh: string; userId: string }> {
  const result = await call('POST', '/auth/login', { body: { email, password } });
  const body = asRecord(result.json);
  const user = asRecord(body.user);
  return {
    token: String(body.access_token),
    refresh: String(body.refresh_token),
    userId: String(user.id),
  };
}

async function statusOf(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: Omit<CallOptions, 'status'> = {},
): Promise<number> {
  if (app) {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      payload: options.body as never,
    });
    return response.statusCode;
  }
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  return response.status;
}

function nextSocketFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveFrame, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket frame timed out after 3 seconds')), 3_000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        try {
          resolveFrame(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch (cause) {
          reject(cause);
        }
      },
      { once: true },
    );
  });
}

let app: FastifyInstance | null = null;

describe('public HTTP endpoints', () => {
  let tokenA = '';
  let refreshA = '';
  let userA = '';
  let tokenB = '';
  let userB = '';

  beforeAll(async () => {
    if (USE_LIVE) {
      let health: Response;
      try {
        health = await fetch(`${API}/health`, { signal: AbortSignal.timeout(3_000) });
      } catch {
        throw new Error(`API is not running at ${API}. Start it with npm run dev:api`);
      }
      if (!health.ok) throw new Error(`API /health returned ${health.status}`);
    } else {
      app = await buildApp({ logger: false });
      const health = await app.inject({ method: 'GET', url: '/health' });
      if (health.statusCode !== 200) {
        throw new Error(`in-process API /health returned ${health.statusCode}`);
      }
    }

    try {
      const alex = await login(DEMO_A.email, DEMO_A.password);
      tokenA = alex.token;
      refreshA = alex.refresh;
      userA = alex.userId;
      const sarah = await login(DEMO_B.email, DEMO_B.password);
      tokenB = sarah.token;
      userB = sarah.userId;
    } catch (err) {
      throw new Error(
        `Demo login failed (${err instanceof Error ? err.message : String(err)}). Run npm run db:seed and npm run seed:security, and keep npm run dev:security running.`,
      );
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    await sqlClient.end({ timeout: 2 }).catch(() => undefined);
  });

  it('GET /health and /ready are unauthenticated', async () => {
    expect(asRecord((await call('GET', '/health')).json).status).toBe('ok');
    expect(asRecord((await call('GET', '/ready')).json).status).toBe('ready');
  });

  it('rejects domain routes without a bearer token', async () => {
    await call('GET', '/pods', { status: 401 });
  });

  it('GET/PATCH /auth/me, refresh, forgot-password, bad reset, bad login', async () => {
    const me = await call('GET', '/auth/me', { token: tokenA });
    expect(asRecord(me.json).email).toBe(DEMO_A.email);

    const patched = await call('PATCH', '/auth/me', {
      token: tokenA,
      body: { permissions_granted: true },
    });
    expect(asRecord(patched.json).permissions_granted).toBe(true);

    const refreshed = await call('POST', '/auth/refresh', { body: { refresh_token: refreshA } });
    tokenA = String(asRecord(refreshed.json).access_token);
    refreshA = String(asRecord(refreshed.json).refresh_token);

    await call('POST', '/auth/forgot-password', { body: { email: DEMO_A.email } });
    await call('POST', '/auth/login', {
      status: 401,
      body: { email: 'missing-user@peapod.test', password: NEW_PASSWORD },
    });
    await call('POST', '/auth/reset-password', {
      status: 401,
      body: { token: 'a'.repeat(32), password: NEW_PASSWORD },
    });
    await call('POST', '/auth/verify-otp', {
      status: 422,
      body: { email: DEMO_A.email, code: OTP, otp: OTP, purpose: 'register' },
    });
  });

  it('lists pods, members, and presence for the seeded pod', async () => {
    const pods = await call('GET', '/pods', { token: tokenA });
    expect((pods.json as { id: string }[]).some((row) => row.id === SEED_POD)).toBe(true);
    await call('GET', `/pods/${SEED_POD}`, { token: tokenA });
    await call('GET', `/pods/${SEED_POD}/members`, { token: tokenA });
    await call('GET', `/pods/${SEED_POD}/presence`, { token: tokenA });
  });

  it('CRUD places, plans, dates, messages, pings, phone status', async () => {
    const place = await call('POST', `/pods/${SEED_POD}/places`, {
      status: 201,
      token: tokenA,
      body: { name: 'Endpoint Cafe', latitude: 1.3, longitude: 103.8, category: 'food' },
    });
    const placeId = asId(place.json);
    await call('GET', `/pods/${SEED_POD}/places`, { token: tokenA });
    await call('PATCH', `/pods/${SEED_POD}/places/${placeId}`, {
      token: tokenA,
      body: { name: 'Endpoint Cafe 2' },
    });
    await call('POST', `/pods/${SEED_POD}/place-alerts`, {
      status: 201,
      token: tokenA,
      body: { place_name: 'Endpoint Cafe 2', event: 'arrived', latitude: 1.3, longitude: 103.8 },
    });
    await call('GET', `/pods/${SEED_POD}/place-alerts`, { token: tokenA });
    await call('DELETE', `/pods/${SEED_POD}/places/${placeId}`, { token: tokenA, status: 204 });

    const start = new Date(Date.now() + 3_600_000).toISOString();
    const plan = await call('POST', `/pods/${SEED_POD}/plans`, {
      status: 201,
      token: tokenA,
      body: { title: 'Endpoint picnic', start_time: start, for_whom: 'pod' },
    });
    const planId = asId(plan.json);
    await call('GET', `/pods/${SEED_POD}/plans`, { token: tokenA });
    await call('PATCH', `/pods/${SEED_POD}/plans/${planId}`, {
      token: tokenA,
      body: { title: 'Endpoint picnic 2' },
    });
    await call('DELETE', `/pods/${SEED_POD}/plans/${planId}`, { token: tokenA, status: 204 });

    const dateRow = await call('POST', `/pods/${SEED_POD}/important-dates`, {
      status: 201,
      token: tokenA,
      body: { title: 'Endpoint day', date: '2024-06-01', emoji: '📌' },
    });
    const dateId = asId(dateRow.json);
    await call('GET', `/pods/${SEED_POD}/important-dates`, { token: tokenA });
    await call('PATCH', `/pods/${SEED_POD}/important-dates/${dateId}`, {
      token: tokenA,
      body: { pinned: true },
    });
    await call('DELETE', `/pods/${SEED_POD}/important-dates/${dateId}`, { token: tokenA, status: 204 });

    const message = await call('POST', `/pods/${SEED_POD}/messages`, {
      status: 201,
      token: tokenA,
      body: { text: 'endpoint test ping' },
    });
    await call('GET', `/pods/${SEED_POD}/messages`, { token: tokenA });
    await call('DELETE', `/pods/${SEED_POD}/messages/${asId(message.json)}`, { token: tokenA, status: 204 });
    await call('POST', `/pods/${SEED_POD}/messages`, {
      status: 400,
      token: tokenA,
      body: { text: '   ' },
    });
    const direct = await call('POST', `/direct-messages/${userB}`, {
      status: 201,
      token: tokenA,
      body: { text: 'private endpoint test' },
    });
    expect(asRecord(direct.json).pod_id).toBeNull();
    const directHistory = await call('GET', `/direct-messages/${userA}`, { token: tokenB });
    expect(
      (directHistory.json as { text?: string }[]).some((row) => row.text === 'private endpoint test'),
    ).toBe(true);
    await call('POST', `/direct-messages/${userA}`, {
      status: 400,
      token: tokenA,
      body: { text: 'cannot message self' },
    });

    const nudge = await call('POST', `/pods/${SEED_POD}/nudges`, {
      status: 201,
      token: tokenA,
      body: { recipient_id: userB },
    });
    expect(asRecord(nudge.json).type).toBe('nudge');
    await call('POST', `/pods/${SEED_POD}/nudges`, {
      status: 400,
      token: tokenA,
      body: { recipient_id: userA },
    });
    await call('DELETE', `/notifications/${asId(nudge.json)}`, { token: tokenB, status: 204 });

    const notes = await call('GET', '/notifications', { token: tokenA });
    expect(Array.isArray(notes.json)).toBe(true);
    const firstNote = (notes.json as { id?: string }[])[0];
    if (firstNote?.id) {
      await call('PATCH', `/notifications/${firstNote.id}`, {
        token: tokenA,
        body: { is_read: true },
      });
      await call('DELETE', `/notifications/${firstNote.id}`, { token: tokenA, status: 204 });
    }

    await call('POST', '/location/pings', {
      status: 201,
      token: tokenA,
      body: { latitude: 1.3521, longitude: 103.8198, pod_id: SEED_POD },
    });
    await call('GET', `/pods/${SEED_POD}/pings`, { token: tokenA });
    await call('POST', `/pods/${SEED_POD}/phone-status`, {
      status: 201,
      token: tokenA,
      body: { battery_level: 64, is_charging: false, signal_bars: 3 },
    });
    await call('GET', `/pods/${SEED_POD}/phone-status`, { token: tokenA });
  });

  it('trips, hidden idea votes, wallet, garden, world, memories, bucket list', async () => {
    const trip = await call('POST', `/pods/${SEED_POD}/trips`, {
      status: 201,
      token: tokenA,
      body: { title: 'Endpoint trip', destination: 'Penang', country: 'MY' },
    });
    const tripId = asId(trip.json);
    await call('GET', `/pods/${SEED_POD}/trips`, { token: tokenA });
    await call('PATCH', `/pods/${SEED_POD}/trips/${tripId}`, { token: tokenA, body: { status: 'planned' } });

    const idea = await call('POST', `/pods/${SEED_POD}/ideas`, {
      status: 201,
      token: tokenA,
      body: { title: 'Endpoint idea', category: 'activity', creator_stance: 'want' },
    });
    const ideaId = asId(idea.json);
    const listed = await call('GET', `/pods/${SEED_POD}/ideas`, { token: tokenA });
    const ours = (listed.json as Record<string, unknown>[]).find((row) => row.id === ideaId);
    expect(ours).toBeTruthy();
    expect(asRecord(asRecord(ours).evaluation).all_voted).toBe(false);
    expect(asRecord(ours).votes).toEqual([]);

    await call('POST', `/pods/${SEED_POD}/ideas/${ideaId}/votes`, {
      token: tokenB,
      body: { stance: 'maybe' },
    });
    const stillHidden = await call('GET', `/pods/${SEED_POD}/ideas`, { token: tokenA });
    const afterB = (stillHidden.json as Record<string, unknown>[]).find((row) => row.id === ideaId);
    expect(asRecord(asRecord(afterB).evaluation).all_voted).toBe(false);
    expect(asRecord(afterB).votes).toEqual([]);

    await call('DELETE', `/pods/${SEED_POD}/ideas/${ideaId}`, { token: tokenA, status: 204 });

    const wallet = await call('GET', `/pods/${SEED_POD}/wallet`, { token: tokenA });
    expect(asRecord(wallet.json).simulated).toBe(true);
    await call('POST', `/pods/${SEED_POD}/wallet/transactions`, {
      status: 201,
      token: tokenA,
      body: { kind: 'deposit', amount_minor: 100, description: 'endpoint test' },
    });
    await call('POST', `/pods/${SEED_POD}/wallet/bills`, {
      status: 201,
      token: tokenA,
      body: { name: 'Endpoint bill', amount_minor: 1000, due_date: '2026-10-01' },
    });
    await call('POST', `/pods/${SEED_POD}/wallet/goals`, {
      status: 201,
      token: tokenA,
      body: { name: 'Endpoint goal', target_minor: 50_000 },
    });

    const plant = await call('POST', `/pods/${SEED_POD}/garden`, {
      status: 201,
      token: tokenA,
      body: { slot: 99, catalog_id: 'endpoint-pea', name: 'Test pea', emoji: '🌱' },
    });
    await call('GET', `/pods/${SEED_POD}/garden`, { token: tokenA });
    await call('POST', `/pods/${SEED_POD}/garden/${asId(plant.json)}/water`, { token: tokenA });

    const activity = await call('POST', `/pods/${SEED_POD}/date-activities`, {
      status: 201,
      token: tokenA,
      body: {
        catalog_id: 'endpoint-date',
        title: 'Endpoint date',
        emoji: '💛',
        is_online: true,
        scheduled_at: new Date().toISOString(),
        participant_ids: [userA, userB],
      },
    });
    expect(asRecord(activity.json).title).toBe('Endpoint date');
    const activities = await call('GET', `/pods/${SEED_POD}/date-activities`, { token: tokenA });
    expect((activities.json as { id: string }[]).some((row) => row.id === asId(activity.json))).toBe(true);

    const redemption = await call('POST', `/pods/${SEED_POD}/rewards/redeem`, {
      token: tokenA,
      body: { catalog_id: 'endpoint-reward', peanut_cost: 1 },
    });
    expect(asRecord(redemption.json).simulated).toBe(true);
    await call('GET', `/pods/${SEED_POD}/world`, { token: tokenA });

    const memory = await call('POST', `/pods/${SEED_POD}/memories`, {
      status: 201,
      token: tokenA,
      body: { title: 'Endpoint memory', date: '2026-09-10', tag: 'everyday' },
    });
    await call('GET', `/pods/${SEED_POD}/memories`, { token: tokenA });
    await call('DELETE', `/pods/${SEED_POD}/memories/${asId(memory.json)}`, { token: tokenA, status: 204 });

    const bucket = await call('POST', `/pods/${SEED_POD}/bucket-list`, {
      status: 201,
      token: tokenA,
      body: { title: 'Endpoint aurora', country: 'IS', state: 'dream' },
    });
    const bucketId = asId(bucket.json);
    await call('GET', `/pods/${SEED_POD}/bucket-list`, { token: tokenA });
    await call('PATCH', `/pods/${SEED_POD}/bucket-list/${bucketId}`, {
      token: tokenA,
      body: { state: 'planned' },
    });
    await call('DELETE', `/pods/${SEED_POD}/bucket-list/${bucketId}`, { token: tokenA, status: 204 });
    await call('DELETE', `/pods/${SEED_POD}/trips/${tripId}`, { token: tokenA, status: 204 });
  });

  it('authenticates, subscribes, and receives an event over /realtime', async () => {
    const base = app
      ? await app.listen({ host: '127.0.0.1', port: 0 })
      : API;
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/realtime`);
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener('open', () => resolveOpen(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), { once: true });
    });

    const authFrame = nextSocketFrame(socket);
    socket.send(JSON.stringify({ type: 'auth', token: tokenB }));
    await expect(authFrame).resolves.toMatchObject({ type: 'auth', ok: true, userId: userB });

    const subscribedFrame = nextSocketFrame(socket);
    socket.send(JSON.stringify({ type: 'subscribe', podId: SEED_POD }));
    await expect(subscribedFrame).resolves.toMatchObject({ type: 'subscribed', podId: SEED_POD });

    const eventFrame = nextSocketFrame(socket);
    publish(SEED_POD, { entity: 'health_test', action: 'update', row: { ok: true } });
    await expect(eventFrame).resolves.toMatchObject({
      type: 'event',
      entity: 'health_test',
      action: 'update',
      row: { ok: true },
    });
    socket.close();
  });

  it('compute, AI fallback, uploads 503, invites, and logout/refresh cycle', async () => {
    await call('POST', '/compute/reconstruct-trip', {
      token: tokenA,
      body: {
        pings: [
          { latitude: 1.35, longitude: 103.82, recorded_at_ms: Date.now() - 60_000 },
          { latitude: 1.351, longitude: 103.821, recorded_at_ms: Date.now() - 30_000 },
          { latitude: 1.352, longitude: 103.822, recorded_at_ms: Date.now() },
        ],
      },
    });
    await call('POST', '/compute/evaluate-decision', {
      token: tokenA,
      body: {
        member_ids: [userA, userB],
        votes: [
          { voter_id: userA, stance: 'want' },
          { voter_id: userB, stance: 'want' },
        ],
        creator_stance: 'want',
        source_type: 'user',
      },
    });
    await call('POST', '/compute/itinerary', {
      token: tokenA,
      body: { countries: ['Japan'], days: 3, travellers: 2 },
    });
    const split = await call('POST', '/compute/split', {
      token: tokenA,
      body: {
        amount_minor: 1000,
        shares: [
          { party_id: userA, percent: 50 },
          { party_id: userB, percent: 50 },
        ],
      },
    });
    expect(asRecord(split.json).total_minor).toBe(1000);

    const ai = await call('POST', '/ai/compromise', {
      token: tokenA,
      body: { title: 'Weekend', duration_days: 2 },
    });
    expect(asRecord(ai.json).source).toBe('fallback');

    await call('POST', '/uploads/presign', {
      token: tokenA,
      status: 503,
      body: { filename: 'avatar.png', content_type: 'image/png' },
    });

    const seedInvite = await call('POST', `/pods/${SEED_POD}/invites`, { status: 201, token: tokenA });
    expect(String(asRecord(seedInvite.json).code).length).toBeGreaterThan(3);
    await call('POST', '/pods/join', {
      status: 400,
      token: tokenB,
      body: { code: 'BAD!' },
    });

    const created = await call('POST', '/pods', {
      status: 201,
      token: tokenA,
      body: { name: 'Endpoint throwaway', emoji: '🧪', group_type: 'friends' },
    });
    const podId = asId(created.json);
    await call('PATCH', `/pods/${podId}`, { token: tokenA, body: { name: 'Endpoint throwaway 2' } });
    const invite = await call('POST', `/pods/${podId}/invites`, { status: 201, token: tokenA });
    await call('POST', '/pods/join', {
      token: tokenB,
      body: { code: String(asRecord(invite.json).code) },
    });
    await call('POST', `/pods/${podId}/members/${userB}/role`, {
      token: tokenA,
      body: { role: 'admin' },
    });
    await call('POST', `/pods/${podId}/members/${userB}/role`, {
      token: tokenA,
      body: { role: 'member' },
    });
    await call('DELETE', `/pods/${podId}/members/${userB}`, { token: tokenA, status: 204 });
    await call('DELETE', `/pods/${podId}`, { token: tokenA, status: 204 });

    const oauth = await statusOf('GET', '/auth/oauth/google/start');
    expect([302, 503]).toContain(oauth);
    expect(await statusOf('GET', '/auth/oauth/google/callback?error=access_denied')).toBe(302);

    await call('POST', '/auth/logout', { status: 204, body: { refresh_token: refreshA } });
    await call('POST', '/auth/refresh', { status: 401, body: { refresh_token: refreshA } });
  });

  it('registers a new account, verifies OTP, then deletes it', async () => {
    const email = `endpoint-${Date.now()}@peapod.test`;
    const raw = await (app
      ? app.inject({
          method: 'POST',
          url: '/auth/register',
          headers: { 'content-type': 'application/json' },
          payload: { email, password: NEW_PASSWORD, display_name: 'Endpoint Newbie' },
        })
      : fetch(`${API}/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: NEW_PASSWORD, display_name: 'Endpoint Newbie' }),
        }));
    const status = 'statusCode' in raw ? raw.statusCode : raw.status;
    const text = 'body' in raw && typeof raw.body === 'string' ? raw.body : await (raw as Response).text();
    if (status === 429) {
      console.warn('POST /auth/register → 429; restart npm run dev:security and re-run to exercise signup');
      return;
    }
    expect(status, `POST /auth/register → ${text}`).toBe(201);
    const createdJson = JSON.parse(text) as { user_id: string };
    await call('POST', '/auth/resend-otp', { body: { email, purpose: 'register' } });
    await plantOtp(createdJson.user_id, OTP);
    const verified = await call('POST', '/auth/verify-otp', {
      body: { email, code: OTP, purpose: 'register' },
    });
    const access = String(asRecord(verified.json).access_token);
    const me = await call('GET', '/auth/me', { token: access });
    expect(asRecord(me.json).email).toBe(email);
    await call('POST', '/auth/delete-account', {
      status: 204,
      token: access,
      body: { password: NEW_PASSWORD },
    });
  });
});
