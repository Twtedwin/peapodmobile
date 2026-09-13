/**
 * MODULE: apps/mobile/src/api/realtime.ts
 *
 * PURPOSE
 *   WebSocket client for the API's /realtime hub. Authenticates with the
 *   access token, then subscribes to a pod so live presence, chat, and
 *   decision events land without polling.
 *
 * INPUTS
 *   - WebSocket origin derived from EXPO_PUBLIC_API_URL
 *   - access token from the session store
 *   - the pod id to subscribe to
 *
 * OUTPUTS : parsed event objects via a listener callback
 * CONSUMED BY : Home (presence, chat), Plans (votes)
 *
 * LIFETIME
 *   The socket is created lazily on first subscribe and torn down when the
 *   last listener unsubscribes. A drop reconnects with backoff; a missing
 *   token is treated as "stay quiet" rather than spinning.
 */

import { websocketUrl } from '@/api/client';
import { useSession } from '@/store/session';

export interface RealtimeEvent {
  type: string;
  entity?: string;
  action?: string;
  row?: unknown;
  podId?: string;
  [key: string]: unknown;
}

type Listener = (event: RealtimeEvent) => void;

/** Minimal socket surface. RN and Node disagree on the full WebSocket type. */
interface HubSocket {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
}

const OPEN = 1;

const listeners = new Set<Listener>();
let socket: HubSocket | null = null;
let subscribedPod: string | null = null;
let backoffMs = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function hubUrl(): string {
  const base = websocketUrl.replace(/\/$/, '');
  if (base.endsWith('/realtime')) return base;
  return `${base}/realtime`;
}

function send(payload: unknown): void {
  if (socket && socket.readyState === OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function authenticateAndSubscribe(): void {
  const token = useSession.getState().accessToken;
  if (!token) return;
  send({ type: 'auth', token });
  if (subscribedPod) send({ type: 'subscribe', podId: subscribedPod });
}

function connect(): void {
  if (stopped || socket) return;
  const token = useSession.getState().accessToken;
  if (!token) return;

  try {
    const ws = new WebSocket(hubUrl());
    socket = ws;
    ws.onopen = () => {
      backoffMs = 1000;
      authenticateAndSubscribe();
    };
    ws.onmessage = (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as RealtimeEvent;
        listeners.forEach((listener) => listener(parsed));
      } catch {
        // Non-JSON frames are ignored; the hub should only send JSON.
      }
    };
    ws.onerror = () => {
      // onclose follows; reconnect lives there so we do not double-schedule.
    };
    ws.onclose = () => {
      socket = null;
      scheduleReconnect();
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (stopped || listeners.size === 0) return;
  if (reconnectTimer) return;
  const wait = backoffMs;
  backoffMs = Math.min(15_000, backoffMs * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      // Closing a CLOSING socket throws on some engines; ignore.
    }
    socket = null;
  }
}

/**
 * Subscribe to hub events. Returns an unsubscribe function.
 *
 * @param podId Pod to subscribe to after auth. Passing a new id resubscribes.
 * @param listener Called with every parsed frame.
 */
export function subscribeRealtime(podId: string, listener: Listener): () => void {
  subscribedPod = podId;
  listeners.add(listener);
  stopped = false;
  if (!socket) connect();
  else authenticateAndSubscribe();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopped = true;
      disconnect();
    }
  };
}
