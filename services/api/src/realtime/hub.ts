/**
 * MODULE: services/api/src/realtime/hub
 *
 * PURPOSE
 *   WebSocket fan-out at `/realtime`. Clients authenticate with a first
 *   message `{ type: 'auth', token }`, then `{ type: 'subscribe', podId }`.
 *   Route handlers call `publish(podId, payload)` after a successful write
 *   so every member's open map/chat/wallet updates without polling.
 *
 * INPUTS  : a Fastify instance, plus `publish()` calls from routes
 * OUTPUTS : `{ type: 'event', entity, action, row }` frames to subscribers
 *
 * WHY AUTH VIA MESSAGE RATHER THAN THE HEADER
 *   React Native's WebSocket client cannot set arbitrary headers on the
 *   handshake in a portable way. The first-message protocol is the same
 *   one the mobile app already speaks.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyToken } from '../auth/securityClient.js';
import { requirePodMember } from '../policy/rls.js';

export interface RealtimeEvent {
  entity: string;
  action: 'insert' | 'update' | 'delete';
  row: unknown;
}

/** Minimal socket surface so we do not couple to a specific `ws` type version. */
interface HubSocket {
  readyState: number;
  send: (data: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface ClientState {
  socket: HubSocket;
  userId: string | null;
  pods: Set<string>;
}

const OPEN = 1;
const clients = new Set<ClientState>();

/** Broadcast an entity change to every socket subscribed to this pod. */
export function publish(podId: string, payload: RealtimeEvent): void {
  const frame = JSON.stringify({ type: 'event', ...payload });
  for (const client of clients) {
    if (!client.pods.has(podId)) continue;
    if (client.socket.readyState !== OPEN) continue;
    try {
      client.socket.send(frame);
    } catch {
      // A racing close is fine; the `close` handler drops the client.
    }
  }
}

function send(socket: HubSocket, payload: unknown): void {
  if (socket.readyState === OPEN) socket.send(JSON.stringify(payload));
}

export async function registerRealtime(app: FastifyInstance): Promise<void> {
  app.get('/realtime', { websocket: true }, (socket: HubSocket) => {
    const client: ClientState = { socket, userId: null, pods: new Set() };
    clients.add(client);

    socket.on('message', (...args: unknown[]) => {
      const raw = args[0];
      const asString =
        typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString() : String(raw ?? '');
      void handleMessage(client, asString).catch((err: unknown) => {
        send(socket, {
          type: 'error',
          message: err instanceof Error ? err.message : 'realtime error',
        });
      });
    });

    socket.on('close', () => {
      clients.delete(client);
    });
    socket.on('error', () => {
      clients.delete(client);
    });
  });
}

async function handleMessage(client: ClientState, raw: string): Promise<void> {
  let parsed: { type?: string; token?: string; podId?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    send(client.socket, { type: 'error', message: 'invalid json' });
    return;
  }

  if (parsed.type === 'auth') {
    if (!parsed.token) {
      send(client.socket, { type: 'error', message: 'token required' });
      return;
    }
    const principal = await verifyToken(parsed.token);
    const profile = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, principal.user_id))
      .limit(1);
    // A missing profile is still a valid login -- registration may be in flight.
    client.userId = profile[0]?.id ?? principal.user_id;
    send(client.socket, { type: 'auth', ok: true, userId: client.userId });
    return;
  }

  if (parsed.type === 'subscribe') {
    if (!client.userId) {
      send(client.socket, { type: 'error', message: 'auth required' });
      return;
    }
    if (!parsed.podId) {
      send(client.socket, { type: 'error', message: 'podId required' });
      return;
    }
    await requirePodMember(client.userId, parsed.podId);
    client.pods.add(parsed.podId);
    send(client.socket, { type: 'subscribed', podId: parsed.podId });
    return;
  }

  if (parsed.type === 'unsubscribe' && parsed.podId) {
    client.pods.delete(parsed.podId);
    send(client.socket, { type: 'unsubscribed', podId: parsed.podId });
    return;
  }

  send(client.socket, { type: 'error', message: `unknown type ${parsed.type ?? ''}` });
}
