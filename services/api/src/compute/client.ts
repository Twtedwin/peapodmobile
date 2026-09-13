/**
 * MODULE: services/api/src/compute/client
 *
 * PURPOSE
 *   Outbound client for the Rust compute service, with an 800 ms timeout and
 *   an automatic fall-through to the TypeScript twins in `./fallback.ts`.
 *
 * INPUTS  : compute request payloads
 * OUTPUTS : compute response payloads (from Rust, or from the fallback)
 *
 * WHY 800 ms
 *   Trip reconstruction over a few thousand pings is the slowest call and
 *   still finishes well under half a second in Rust. If it has not answered
 *   in 800 ms the process is wedged or unreachable; failing over to the
 *   TypeScript twin is better than hanging the mobile client's spinner.
 *
 *   COMPUTE_ENABLED=false skips the HTTP hop entirely, which is the right
 *   default when you have no Docker / no Rust toolchain.
 */

import { env } from '../env.js';
import type {
  EvaluateDecisionRequest,
  EvaluateDecisionResponse,
  ItineraryRequest,
  ItineraryResponse,
  ReconstructTripRequest,
  ReconstructTripResponse,
  SplitRequest,
  SplitResponse,
} from '@peapod/shared';
import * as fallback from './fallback.js';

/** Compute-service timeout. Kept in one place so a reviewer can find it. */
const TIMEOUT_MS = 800;

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const response = await fetch(`${env.COMPUTE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`compute ${path} returned ${response.status}`);
  }
  return (await response.json()) as TResponse;
}

/**
 * Try the Rust service; on any failure (disabled, timeout, 5xx, network)
 * run the TypeScript fallback. The two implementations are supposed to
 * agree -- see `test/compute-parity.test.ts`.
 */
async function withFallback<T>(rust: () => Promise<T>, local: () => T): Promise<T> {
  if (!env.COMPUTE_ENABLED) return local();
  try {
    return await rust();
  } catch {
    return local();
  }
}

export function reconstructTrip(request: ReconstructTripRequest): Promise<ReconstructTripResponse> {
  return withFallback(
    () => postJson('/trips/reconstruct', request),
    () => fallback.reconstructTrip(request),
  );
}

export function evaluateDecision(request: EvaluateDecisionRequest): Promise<EvaluateDecisionResponse> {
  return withFallback(
    () => postJson('/decisions/evaluate', request),
    () => fallback.evaluate(request),
  );
}

export function generateItinerary(request: ItineraryRequest): Promise<ItineraryResponse> {
  return withFallback(
    () => postJson('/itinerary/generate', request),
    () => fallback.generateItineraryStub(request),
  );
}

export function split(request: SplitRequest): Promise<SplitResponse> {
  return withFallback(
    () => postJson('/wallet/split', request),
    () => fallback.split(request),
  );
}
