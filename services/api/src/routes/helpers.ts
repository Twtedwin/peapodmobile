/**
 * MODULE: services/api/src/routes/helpers
 *
 * PURPOSE
 *   Shared parsing, audit-column stamping, and "now" helpers so individual
 *   route files stay short. Zod is used lightly: a failed parse is a 400
 *   with the first issue's message, not a wall of issues.
 *
 * INPUTS  : Fastify request pieces, a zod schema
 * OUTPUTS : typed values, or HttpError
 */

import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import { badRequest } from '../http.js';
import type { AuthUser } from '../types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuid(value: string | undefined, name = 'id'): string {
  if (!value || !UUID_RE.test(value)) throw badRequest(`Invalid ${name}`);
  return value;
}

export function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  if (!value) throw badRequest(`Missing path parameter ${name}`);
  return value;
}

export function uuidParam(request: FastifyRequest, name: string): string {
  return asUuid(param(request, name), name);
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid body', result.error.issues);
  }
  return result.data;
}

export function stamp(user: AuthUser): { created_by_id: string; created_at: Date; updated_at: Date } {
  const now = new Date();
  return { created_by_id: user.id, created_at: now, updated_at: now };
}

export function touch(): { updated_at: Date } {
  return { updated_at: new Date() };
}

/**
 * Six uppercase alphanumeric characters. 36^6 is ~2.1 billion; we still
 * unique-index the column and retry on collision at the insert site.
 */
export function inviteCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export const zString = z.string().min(1);
export const zUuid = z.string().uuid();
