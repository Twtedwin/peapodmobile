/**
 * MODULE: services/api/src/routes/compute
 *
 * PURPOSE
 *   Thin proxies onto `src/compute/client.ts`. The client tries the Rust
 *   service (800 ms timeout) and falls back to the TypeScript twins, so
 *   these routes never 502 just because the compute container is down.
 *
 * INPUTS  : compute request payloads (zod-light)
 * OUTPUTS : compute response payloads
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as compute from '../compute/client.js';
import { parseBody } from './helpers.js';

export async function registerCompute(app: FastifyInstance): Promise<void> {
  app.post('/compute/reconstruct-trip', async (request) => {
    const body = parseBody(
      z.object({
        pings: z.array(
          z.object({
            latitude: z.number(),
            longitude: z.number(),
            recorded_at_ms: z.number(),
            speed: z.number().optional().default(0),
            accuracy: z.number().optional().default(0),
            is_driving: z.boolean().optional().default(false),
          }),
        ),
      }),
      request.body,
    );
    return compute.reconstructTrip({
      pings: body.pings.map((ping) => ({
        latitude: ping.latitude,
        longitude: ping.longitude,
        recorded_at_ms: ping.recorded_at_ms,
        speed: ping.speed ?? 0,
        accuracy: ping.accuracy ?? 0,
        is_driving: ping.is_driving ?? false,
      })),
    });
  });

  app.post('/compute/evaluate-decision', async (request) => {
    const body = parseBody(
      z.object({
        member_ids: z.array(z.string()),
        votes: z.array(z.object({ voter_id: z.string(), stance: z.enum(['want', 'maybe', 'no']) })),
        creator_stance: z.enum(['want', 'maybe', 'no']).nullable().optional(),
        source_type: z.enum(['user', 'ai']).optional(),
        status: z.enum(['active', 'archived', 'converted']).optional(),
        stage_override: z.string().nullable().optional(),
      }),
      request.body,
    );
    return compute.evaluateDecision(body);
  });

  app.post('/compute/itinerary', async (request) => {
    const body = parseBody(
      z.object({
        countries: z.array(z.string()).default([]),
        regions: z.array(z.string()).optional().default([]),
        days: z.number().int().min(1).max(30),
        travellers: z.number().int().optional().default(2),
        personalities: z.array(z.string()).optional().default([]),
        pace: z.enum(['relaxed', 'balanced', 'packed']).optional().default('balanced'),
        budget_tier: z.enum(['budget', 'mid', 'luxury']).optional().default('mid'),
        start_date: z.string().nullable().optional().default(null),
        must_see: z.array(z.string()).optional().default([]),
        avoid: z.array(z.string()).optional().default([]),
        currency: z.string().optional().default('SGD'),
        seed: z.number().nullable().optional().default(null),
      }),
      request.body,
    );
    return compute.generateItinerary({
      countries: body.countries ?? [],
      regions: body.regions ?? [],
      days: body.days,
      travellers: body.travellers ?? 2,
      personalities: body.personalities ?? [],
      pace: body.pace ?? 'balanced',
      budget_tier: body.budget_tier ?? 'mid',
      start_date: body.start_date ?? null,
      must_see: body.must_see ?? [],
      avoid: body.avoid ?? [],
      currency: body.currency ?? 'SGD',
      seed: body.seed ?? null,
    });
  });

  app.post('/compute/split', async (request) => {
    const body = parseBody(
      z.object({
        amount_minor: z.number().int(),
        shares: z.array(z.object({ party_id: z.string(), percent: z.number() })),
      }),
      request.body,
    );
    return compute.split(body);
  });
}
